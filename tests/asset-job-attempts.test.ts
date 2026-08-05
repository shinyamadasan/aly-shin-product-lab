import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  finishAssetJobAttempt,
  fromAssetJobAttemptRow,
  isAssetJobAttemptStatus,
  type AssetJobAttemptClient,
  type AssetJobAttemptRow,
} from "../src/lib/asset-job-attempts.ts";

type ErrorLike = { code?: string; message: string };

// The fake's finish_asset_job_attempt RPC handler stamps this fixed "database now()" for every
// finish call, standing in for the real SQL function's own now(). completed_at and latency_ms are
// computed from it and the row's own started_at, exactly like the production RPC.
const finishedAt = "2026-07-31T10:05:00.000Z";

function assetJobAttemptRow(overrides: Partial<AssetJobAttemptRow> = {}): AssetJobAttemptRow {
  return {
    id: "attempt-1",
    asset_job_id: "job-1",
    attempt_number: 1,
    worker_type: "mock",
    status: "running",
    started_at: "2026-07-31T10:01:00.000Z",
    completed_at: null,
    latency_ms: null,
    error_code: null,
    error_message: null,
    provider: null,
    model: null,
    created_at: "2026-07-31T10:01:05.000Z",
    ...overrides,
  };
}

function makeClient(options: { attempts?: AssetJobAttemptRow[]; rpcError?: ErrorLike } = {}) {
  const attempts = [...(options.attempts ?? [])];
  let rpcCalls = 0;

  const client = {
    rpc(functionName: string, args: Record<string, unknown>) {
      assert.equal(functionName, "finish_asset_job_attempt");
      return {
        // Mirrors finish_asset_job_attempt's own guards: id + status='running' + p_outcome in
        // ('completed','failed','timed_out'). completed_at/latency_ms are computed here exactly
        // like `now()`/`now() - started_at` inside the real function -- never app-supplied.
        async maybeSingle() {
          rpcCalls += 1;
          if (options.rpcError) {
            return { data: null, error: options.rpcError };
          }
          const outcome = args.p_outcome as string;
          const validOutcome = outcome === "completed" || outcome === "failed" || outcome === "timed_out";
          const index = attempts.findIndex((row) => row.id === (args.p_attempt_id as string) && row.status === "running");
          if (index === -1 || !validOutcome) {
            return { data: null, error: null };
          }
          attempts[index] = {
            ...attempts[index],
            status: outcome as AssetJobAttemptRow["status"],
            completed_at: finishedAt,
            latency_ms: Date.parse(finishedAt) - Date.parse(attempts[index].started_at),
            error_code: outcome === "completed" ? null : (args.p_error_code as string | null),
            error_message: outcome === "completed" ? null : (args.p_error_message as string | null),
          };
          return { data: attempts[index], error: null };
        },
      };
    },
  } as unknown as AssetJobAttemptClient;

  return {
    client,
    attempts,
    get rpcCalls() {
      return rpcCalls;
    },
  };
}

test("isAssetJobAttemptStatus accepts only the approved lifecycle statuses", () => {
  for (const status of ["running", "completed", "failed", "timed_out"]) {
    assert.equal(isAssetJobAttemptStatus(status), true);
  }
  for (const status of ["queued", "retrying", "cancelled", ""]) {
    assert.equal(isAssetJobAttemptStatus(status), false);
  }
});

test("fromAssetJobAttemptRow maps nullable fields to empty string or null defaults", () => {
  const record = fromAssetJobAttemptRow(assetJobAttemptRow());
  assert.equal(record.status, "running");
  assert.equal(record.completedAt, "");
  assert.equal(record.latencyMs, null);
  assert.equal(record.errorCode, "");
  assert.equal(record.errorMessage, "");
  assert.equal(record.provider, "");
  assert.equal(record.model, "");
});

test("fromAssetJobAttemptRow throws when id or created_at is missing", () => {
  assert.throws(() => fromAssetJobAttemptRow(assetJobAttemptRow({ id: undefined })), /missing id or created_at/);
  assert.throws(() => fromAssetJobAttemptRow(assetJobAttemptRow({ created_at: undefined })), /missing id or created_at/);
});

test("finishAssetJobAttempt marks a running attempt completed with a database-computed latency_ms and null error fields", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow()] });
  const result = await finishAssetJobAttempt(store.client, "attempt-1", "completed");

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].completed_at, finishedAt);
  assert.equal(store.attempts[0].latency_ms, Date.parse(finishedAt) - Date.parse("2026-07-31T10:01:00.000Z"));
  assert.equal(store.attempts[0].error_code, null);
  assert.equal(store.attempts[0].error_message, null);
});

test("finishAssetJobAttempt marks a running attempt failed with the given error_code and error_message", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow()] });
  const result = await finishAssetJobAttempt(store.client, "attempt-1", "failed", {
    errorCode: "failed",
    errorMessage: "Worker execution failed: boom.",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
  assert.equal(store.attempts[0].error_message, "Worker execution failed: boom.");
});

test("finishAssetJobAttempt marks a running attempt timed_out with error_code timeout and a positive latency_ms", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow()] });
  const result = await finishAssetJobAttempt(store.client, "attempt-1", "timed_out", {
    errorCode: "timeout",
    errorMessage: "Asset Job execution exceeded 10ms timeout.",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.ok((store.attempts[0].latency_ms ?? -1) > 0);
});

test("finishAssetJobAttempt does not mutate an attempt that is no longer running", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow({ status: "completed", completed_at: "2026-07-31T10:02:00.000Z" })] });
  const result = await finishAssetJobAttempt(store.client, "attempt-1", "failed", {
    errorCode: "failed",
    errorMessage: "should not apply",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
  assert.equal(store.attempts[0].status, "completed");
});

test("finishAssetJobAttempt reports a missing-table error distinctly from a generic failure", async () => {
  const missingTableStore = makeClient({ attempts: [assetJobAttemptRow()], rpcError: { code: "PGRST205", message: "missing" } });
  const missingTableResult = await finishAssetJobAttempt(missingTableStore.client, "attempt-1", "completed");
  assert.equal(missingTableResult.ok, false);
  if (!missingTableResult.ok) {
    assert.equal(missingTableResult.reason, "missing-table");
  }

  const genericStore = makeClient({ attempts: [assetJobAttemptRow()], rpcError: { message: "boom" } });
  const genericResult = await finishAssetJobAttempt(genericStore.client, "attempt-1", "completed");
  assert.equal(genericResult.ok, false);
  if (!genericResult.ok) {
    assert.equal(genericResult.reason, "failed");
    assert.equal(genericResult.message, "boom");
  }
});

test("finish_asset_job_attempt RPC guard rejects an invalid outcome and a non-running attempt", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow()] });

  const invalidOutcome = await store.client
    .rpc("finish_asset_job_attempt", { p_attempt_id: "attempt-1", p_outcome: "cancelled", p_error_code: null, p_error_message: null })
    .maybeSingle();
  assert.equal(invalidOutcome.data, null);
  assert.equal(store.attempts[0].status, "running");

  const finished = await finishAssetJobAttempt(store.client, "attempt-1", "completed");
  assert.equal(finished.ok, true);

  const alreadyTerminal = await store.client
    .rpc("finish_asset_job_attempt", { p_attempt_id: "attempt-1", p_outcome: "failed", p_error_code: "failed", p_error_message: "too late" })
    .maybeSingle();
  assert.equal(alreadyTerminal.data, null);
  assert.equal(store.attempts[0].status, "completed");
});

test("asset job attempt code does not call external providers, log to the console, or create future-domain records", () => {
  const source = readFileSync(new URL("../src/lib/asset-job-attempts.ts", import.meta.url), "utf8");
  for (const forbidden of [
    /OpenAI/i,
    /Gemini/i,
    /Veo/i,
    /Runway/i,
    /Remotion/i,
    /\bfetch\s*\(/,
    /console\./,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("content_drafts"\)/i,
    /@supabase\/supabase-js/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
