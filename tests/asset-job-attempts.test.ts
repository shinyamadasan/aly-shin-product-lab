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
  const rpcNames: string[] = [];
  let rpcCalls = 0;

  const client = {
    rpc(functionName: string, args: Record<string, unknown>) {
      // Both finish RPCs land here. They share every guard and differ only in whether they carry
      // provider/model, exactly as the two SQL functions do.
      assert.ok(
        functionName === "finish_asset_job_attempt" || functionName === "finish_asset_job_attempt_with_provenance",
        `unexpected attempt RPC: ${functionName}`,
      );
      rpcNames.push(functionName);
      return {
        // Mirrors finish_asset_job_attempt's own guards: id + status='running' + p_outcome in
        // ('completed','failed','timed_out'). completed_at/latency_ms are computed here exactly
        // like `now()`/`now() - started_at` inside the real function -- never app-supplied.
        async maybeSingle() {
          // PostgreSQL/PostgREST resolve a function by NAME PLUS ARGUMENT NAMES. The 4-argument
          // finish_asset_job_attempt has no p_provider/p_model parameters, so sending them does not
          // "get ignored" -- no candidate function matches and the call fails outright. The fake
          // reproduces that, so a miswiring that sends provenance to the base RPC fails here exactly
          // as it would against a real database, instead of being silently accepted.
          if (functionName === "finish_asset_job_attempt" && ("p_provider" in args || "p_model" in args)) {
            return {
              data: null,
              error: {
                code: "PGRST202",
                message: "Could not find the function public.finish_asset_job_attempt(p_attempt_id, p_error_code, p_error_message, p_model, p_outcome, p_provider) in the schema cache",
              },
            };
          }
          const carriesProvenance = functionName === "finish_asset_job_attempt_with_provenance";
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
            // `coalesce(p_provider, provider)` / `coalesce(p_model, model)` -- the base RPC supplies
            // neither argument, so undefined behaves exactly like the SQL's NULL.
            // Only the provenance RPC can touch these two columns. coalesce(p_x, x) so a null argument
            // never erases an already-recorded value.
            provider: carriesProvenance ? ((args.p_provider as string | null) ?? attempts[index].provider ?? null) : attempts[index].provider,
            model: carriesProvenance ? ((args.p_model as string | null) ?? attempts[index].model ?? null) : attempts[index].model,
          };
          return { data: attempts[index], error: null };
        },
      };
    },
  } as unknown as AssetJobAttemptClient;

  return {
    client,
    attempts,
    rpcNames,
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

// --- provider/model provenance at the client boundary ------------------------------------------------

test("finishAssetJobAttempt routes to the ORIGINAL RPC when there is no provenance", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow()] });

  const result = await finishAssetJobAttempt(store.client, "attempt-1", "completed");

  assert.equal(result.ok, true);
  assert.deepEqual(store.rpcNames, ["finish_asset_job_attempt"]);
  assert.equal(store.attempts[0].provider, null);
  assert.equal(store.attempts[0].model, null);
});

test("finishAssetJobAttempt routes to the provenance RPC and persists provider/model when given them", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow({ worker_type: "generative_image" })] });

  const result = await finishAssetJobAttempt(store.client, "attempt-1", "completed", {
    provenance: { provider: "cloudflare-workers-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(store.rpcNames, ["finish_asset_job_attempt_with_provenance"]);
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
  assert.equal(store.attempts[0].model, "@cf/black-forest-labs/flux-2-klein-9b");
  assert.equal(store.attempts[0].status, "completed");
});

test("provenance persists on a failed outcome, alongside the unchanged error fields", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow({ worker_type: "generative_image" })] });

  const result = await finishAssetJobAttempt(store.client, "attempt-1", "failed", {
    errorCode: "failed",
    errorMessage: "Cloudflare Workers AI request failed with 500",
    provenance: { provider: "cloudflare-workers-ai", model: "@cf/some/other-model" },
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
  assert.match(store.attempts[0].error_message ?? "", /failed with 500/);
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
  assert.equal(store.attempts[0].model, "@cf/some/other-model");
});

test("provenance persists on a timed-out outcome", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow({ worker_type: "generative_image" })] });

  await finishAssetJobAttempt(store.client, "attempt-1", "timed_out", {
    errorCode: "timeout",
    errorMessage: "Asset Job execution exceeded 120000ms timeout.",
    provenance: { provider: "cloudflare-workers-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" },
  });

  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
});

test("the provenance RPC obeys the same running-status and outcome guards as the original", async () => {
  const alreadyTerminal = makeClient({ attempts: [assetJobAttemptRow({ status: "completed" })] });
  const notRunning = await finishAssetJobAttempt(alreadyTerminal.client, "attempt-1", "failed", {
    provenance: { provider: "cloudflare-workers-ai", model: "@cf/m" },
  });
  assert.equal(notRunning.ok, false);
  if (!notRunning.ok) {
    assert.equal(notRunning.reason, "not-found");
  }
  // A refused write records nothing at all -- not even the provenance.
  assert.equal(alreadyTerminal.attempts[0].provider, null);

  const invalidOutcome = makeClient({ attempts: [assetJobAttemptRow()] });
  const rejected = await invalidOutcome.client
    .rpc("finish_asset_job_attempt_with_provenance", {
      p_attempt_id: "attempt-1",
      p_outcome: "cancelled",
      p_error_code: null,
      p_error_message: null,
      p_provider: "cloudflare-workers-ai",
      p_model: "@cf/m",
    })
    .maybeSingle();
  assert.equal(rejected.data, null);
  assert.equal(invalidOutcome.attempts[0].status, "running");
  assert.equal(invalidOutcome.attempts[0].provider, null);
});

test("a null provenance argument can never ERASE a provider already recorded on the row", async () => {
  const store = makeClient({ attempts: [assetJobAttemptRow({ provider: "cloudflare-workers-ai", model: "@cf/m" })] });

  await store.client
    .rpc("finish_asset_job_attempt_with_provenance", {
      p_attempt_id: "attempt-1",
      p_outcome: "completed",
      p_error_code: null,
      p_error_message: null,
      p_provider: null,
      p_model: null,
    })
    .maybeSingle();

  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
  assert.equal(store.attempts[0].model, "@cf/m");
});

test("fromAssetJobAttemptRow surfaces persisted provenance, and still normalizes absence to empty strings", () => {
  const withProvenance = fromAssetJobAttemptRow(
    assetJobAttemptRow({ status: "completed", provider: "cloudflare-workers-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" }),
  );
  assert.equal(withProvenance.provider, "cloudflare-workers-ai");
  assert.equal(withProvenance.model, "@cf/black-forest-labs/flux-2-klein-9b");

  const without = fromAssetJobAttemptRow(assetJobAttemptRow({ status: "completed" }));
  assert.equal(without.provider, "");
  assert.equal(without.model, "");
});
