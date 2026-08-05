import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  finishCreativeJobAttempt,
  fromCreativeJobAttemptRow,
  isCreativeJobAttemptStatus,
  type CreativeJobAttemptClient,
  type CreativeJobAttemptRow,
} from "../src/lib/creative-job-attempts.ts";

type ErrorLike = { code?: string; message: string };

// The fake's finish_creative_job_attempt RPC handler stamps this fixed "database now()" for
// every finish call, standing in for the real SQL function's own now(). completed_at and
// latency_ms are computed from it and the row's own started_at, exactly like the production RPC.
const finishedAt = "2026-07-29T10:05:00.000Z";

function creativeJobAttemptRow(overrides: Partial<CreativeJobAttemptRow> = {}): CreativeJobAttemptRow {
  return {
    id: "attempt-1",
    creative_job_id: "job-1",
    attempt_number: 1,
    worker_type: "product_text_worker",
    status: "running",
    started_at: "2026-07-29T10:01:00.000Z",
    completed_at: null,
    latency_ms: null,
    error_code: null,
    error_message: null,
    provider: null,
    model: null,
    created_at: "2026-07-29T10:01:05.000Z",
    ...overrides,
  };
}

function makeClient(options: { attempts?: CreativeJobAttemptRow[]; rpcError?: ErrorLike } = {}) {
  const attempts = [...(options.attempts ?? [])];
  let rpcCalls = 0;

  const client = {
    rpc(functionName: string, args: Record<string, unknown>) {
      assert.equal(functionName, "finish_creative_job_attempt");
      return {
        // Mirrors finish_creative_job_attempt's own guards: id + status='running' + p_outcome in
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
            status: outcome as CreativeJobAttemptRow["status"],
            completed_at: finishedAt,
            latency_ms: Date.parse(finishedAt) - Date.parse(attempts[index].started_at),
            error_code: outcome === "completed" ? null : (args.p_error_code as string | null),
            error_message: outcome === "completed" ? null : (args.p_error_message as string | null),
          };
          return { data: attempts[index], error: null };
        },
      };
    },
  } as unknown as CreativeJobAttemptClient;

  return {
    client,
    attempts,
    get rpcCalls() {
      return rpcCalls;
    },
  };
}

test("isCreativeJobAttemptStatus accepts only the approved lifecycle statuses", () => {
  for (const status of ["running", "completed", "failed", "timed_out"]) {
    assert.equal(isCreativeJobAttemptStatus(status), true);
  }
  for (const status of ["queued", "retrying", "cancelled", ""]) {
    assert.equal(isCreativeJobAttemptStatus(status), false);
  }
});

test("fromCreativeJobAttemptRow maps nullable fields to empty string or null defaults", () => {
  const record = fromCreativeJobAttemptRow(creativeJobAttemptRow());
  assert.equal(record.status, "running");
  assert.equal(record.completedAt, "");
  assert.equal(record.latencyMs, null);
  assert.equal(record.errorCode, "");
  assert.equal(record.errorMessage, "");
  assert.equal(record.provider, "");
  assert.equal(record.model, "");
});

test("fromCreativeJobAttemptRow throws when id or created_at is missing", () => {
  assert.throws(() => fromCreativeJobAttemptRow(creativeJobAttemptRow({ id: undefined })), /missing id or created_at/);
  assert.throws(() => fromCreativeJobAttemptRow(creativeJobAttemptRow({ created_at: undefined })), /missing id or created_at/);
});

test("finishCreativeJobAttempt marks a running attempt completed with a database-computed latency_ms and null error fields", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "completed");

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].completed_at, finishedAt);
  assert.equal(store.attempts[0].latency_ms, Date.parse(finishedAt) - Date.parse("2026-07-29T10:01:00.000Z"));
  assert.equal(store.attempts[0].error_code, null);
  assert.equal(store.attempts[0].error_message, null);
});

test("finishCreativeJobAttempt marks a running attempt failed with the given error_code and error_message", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "failed", {
    errorCode: "failed",
    errorMessage: "Worker execution failed: boom.",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
  assert.equal(store.attempts[0].error_message, "Worker execution failed: boom.");
});

test("finishCreativeJobAttempt marks a running attempt timed_out with error_code timeout and a positive latency_ms", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "timed_out", {
    errorCode: "timeout",
    errorMessage: "Creative Job execution exceeded 10ms timeout.",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.ok((store.attempts[0].latency_ms ?? -1) > 0);
});

test("finishCreativeJobAttempt does not mutate an attempt that is no longer running", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow({ status: "completed", completed_at: "2026-07-29T10:02:00.000Z" })] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "failed", {
    errorCode: "failed",
    errorMessage: "should not apply",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
  assert.equal(store.attempts[0].status, "completed");
});

test("finishCreativeJobAttempt reports a missing-table error distinctly from a generic failure", async () => {
  const missingTableStore = makeClient({ attempts: [creativeJobAttemptRow()], rpcError: { code: "PGRST205", message: "missing" } });
  const missingTableResult = await finishCreativeJobAttempt(missingTableStore.client, "attempt-1", "completed");
  assert.equal(missingTableResult.ok, false);
  if (!missingTableResult.ok) {
    assert.equal(missingTableResult.reason, "missing-table");
  }

  const genericStore = makeClient({ attempts: [creativeJobAttemptRow()], rpcError: { message: "boom" } });
  const genericResult = await finishCreativeJobAttempt(genericStore.client, "attempt-1", "completed");
  assert.equal(genericResult.ok, false);
  if (!genericResult.ok) {
    assert.equal(genericResult.reason, "failed");
    assert.equal(genericResult.message, "boom");
  }
});

test("finish_creative_job_attempt RPC guard rejects an invalid outcome and a non-running attempt", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });

  const invalidOutcome = await store.client
    .rpc("finish_creative_job_attempt", { p_attempt_id: "attempt-1", p_outcome: "cancelled", p_error_code: null, p_error_message: null })
    .maybeSingle();
  assert.equal(invalidOutcome.data, null);
  assert.equal(store.attempts[0].status, "running");

  const finished = await finishCreativeJobAttempt(store.client, "attempt-1", "completed");
  assert.equal(finished.ok, true);

  const alreadyTerminal = await store.client
    .rpc("finish_creative_job_attempt", { p_attempt_id: "attempt-1", p_outcome: "failed", p_error_code: "failed", p_error_message: "too late" })
    .maybeSingle();
  assert.equal(alreadyTerminal.data, null);
  assert.equal(store.attempts[0].status, "completed");
});

test("creative job attempt code does not call external providers, log to the console, or create future-domain records", () => {
  const source = readFileSync(new URL("../src/lib/creative-job-attempts.ts", import.meta.url), "utf8");
  for (const forbidden of [
    /Claude/i,
    /OpenAI/i,
    /Gemini/i,
    /Remotion/i,
    /\bfetch\s*\(/,
    /console\./,
    /from\("assets"\)/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("content_drafts"\)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
