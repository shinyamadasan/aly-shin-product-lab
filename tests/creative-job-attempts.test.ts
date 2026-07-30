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

function makeClient(options: { attempts?: CreativeJobAttemptRow[]; updateError?: ErrorLike } = {}) {
  const attempts = [...(options.attempts ?? [])];
  let updateCalls = 0;

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  const client = {
    from(table: string) {
      assert.equal(table, "creative_job_attempts");
      return {
        update(updateRow: Partial<CreativeJobAttemptRow>) {
          const filters: Array<{ column: string; value: string }> = [];
          const builder = {
            eq(column: string, value: string) {
              filters.push({ column, value });
              return builder;
            },
            select() {
              return {
                async maybeSingle() {
                  updateCalls += 1;
                  if (options.updateError) {
                    return { data: null, error: options.updateError };
                  }
                  const index = attempts.findIndex((row) => matches(row as Record<string, unknown>, filters));
                  if (index === -1) {
                    return { data: null, error: null };
                  }
                  attempts[index] = { ...attempts[index], ...updateRow };
                  return { data: attempts[index], error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  } as unknown as CreativeJobAttemptClient;

  return {
    client,
    attempts,
    get updateCalls() {
      return updateCalls;
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

test("finishCreativeJobAttempt marks a running attempt completed with a positive computed latency_ms and null error fields", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "completed", {
    startedAt: "2026-07-29T10:01:00.000Z",
    completedAt: "2026-07-29T10:05:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].completed_at, "2026-07-29T10:05:00.000Z");
  assert.equal(store.attempts[0].latency_ms, 240000);
  assert.equal(store.attempts[0].error_code, null);
  assert.equal(store.attempts[0].error_message, null);
});

test("finishCreativeJobAttempt marks a running attempt failed with the given error_code and error_message", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "failed", {
    startedAt: "2026-07-29T10:01:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
    errorCode: "failed",
    errorMessage: "Worker execution failed: boom.",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
  assert.equal(store.attempts[0].error_message, "Worker execution failed: boom.");
});

test("finishCreativeJobAttempt marks a running attempt timed_out with error_code timeout", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow()] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "timed_out", {
    startedAt: "2026-07-29T10:01:00.000Z",
    completedAt: "2026-07-29T10:01:00.010Z",
    errorCode: "timeout",
    errorMessage: "Creative Job execution exceeded 10ms timeout.",
  });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.equal(store.attempts[0].latency_ms, 10);
});

test("finishCreativeJobAttempt does not mutate an attempt that is no longer running", async () => {
  const store = makeClient({ attempts: [creativeJobAttemptRow({ status: "completed", completed_at: "2026-07-29T10:02:00.000Z" })] });
  const result = await finishCreativeJobAttempt(store.client, "attempt-1", "failed", {
    startedAt: "2026-07-29T10:01:00.000Z",
    completedAt: "2026-07-29T10:03:00.000Z",
    errorCode: "failed",
    errorMessage: "should not apply",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
  assert.equal(store.attempts[0].status, "completed");
});

test("finishCreativeJobAttempt reports a missing-table error distinctly from a generic failure", async () => {
  const missingTableStore = makeClient({ attempts: [creativeJobAttemptRow()], updateError: { code: "PGRST205", message: "missing" } });
  const missingTableResult = await finishCreativeJobAttempt(missingTableStore.client, "attempt-1", "completed", {
    startedAt: "2026-07-29T10:01:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
  });
  assert.equal(missingTableResult.ok, false);
  if (!missingTableResult.ok) {
    assert.equal(missingTableResult.reason, "missing-table");
  }

  const genericStore = makeClient({ attempts: [creativeJobAttemptRow()], updateError: { message: "boom" } });
  const genericResult = await finishCreativeJobAttempt(genericStore.client, "attempt-1", "completed", {
    startedAt: "2026-07-29T10:01:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
  });
  assert.equal(genericResult.ok, false);
  if (!genericResult.ok) {
    assert.equal(genericResult.reason, "failed");
    assert.equal(genericResult.message, "boom");
  }
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
