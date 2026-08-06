import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreativePrepCli, type CreativePrepClient } from "../scripts/creative-prep/run.ts";
import { acquireLock } from "../scripts/daily-advisor/lock.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";
import type { CreativeJobRow } from "../src/lib/creative-jobs.ts";

// This file verifies only that the creative-prep CLI shell (lock, credential preflight, output
// writing, exit-code mapping) uses its dependencies' existing contracts correctly. It does not
// reproduce lock.ts's own staleness/PID logic (already covered where that module is tested) or
// runCreativePreparation's state-table behavior (covered in creative-prep-run.test.ts) -- each
// test below reaches for the smallest client fixture that exercises the CLI concern at hand.

function opportunityDraft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-07-30:product_marketing_content:brownies",
    title: "Create product content for Brownies",
    summary: "Brownies has enough evidence for a marketing content Opportunity.",
    reason: "The Rule Engine found a product-backed marketing opportunity.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: {},
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: "2026-07-30T01:00:00.000Z",
    expiresAt: "2026-08-02T01:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:product=brownies|action=create_content|business_date=2026-07-30",
    status: "accepted",
    ...overrides,
  };
}

function opportunityRow(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    ...toOpportunityRow(opportunityDraft()),
    id: "opportunity-1",
    created_at: "2026-07-30T01:05:00.000Z",
    updated_at: "2026-07-30T01:05:00.000Z",
    ...overrides,
  };
}

function creativeJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: "opportunity-1",
    status: "failed",
    worker_type: "opportunity_brief",
    attempt_count: 1,
    result: {},
    last_error: "Worker execution failed.",
    created_at: "2026-07-30T01:10:00.000Z",
    updated_at: "2026-07-30T01:11:00.000Z",
    started_at: "2026-07-30T01:10:30.000Z",
    completed_at: null,
    failed_at: "2026-07-30T01:11:00.000Z",
    ...overrides,
  };
}

type ErrorLike = { code?: string; message: string };

function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
  return filters.every(({ column, value }) => row[column] === value);
}

// No eligible Opportunity anywhere -- selectPreparationCandidate resolves to null, so the
// orchestration core reports a plain "no-op" without touching creative_jobs or creative_packages
// at all. Enough for every test below that only needs *some* clean outcome to write to output.
function makeNoOpClient(): CreativePrepClient {
  return {
    from(table: string) {
      if (table === "opportunities") {
        return {
          select() {
            const builder = {
              eq() {
                return builder;
              },
              order() {
                return builder;
              },
              limit() {
                return builder;
              },
              then(resolve: (value: { data: OpportunityRow[]; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve({ data: [], error: null }).then(resolve, reject);
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`Unexpected table in makeNoOpClient: ${table}`);
    },
  } as unknown as CreativePrepClient;
}

// One accepted Opportunity whose Creative Job already failed -- reaches runCreativePreparation's
// terminal-failure branch without ever needing the trusted runner's RPC machinery, since a
// "failed" job is never re-claimed.
function makeFailedJobClient(): CreativePrepClient {
  const opportunities = [opportunityRow()];
  const jobs = [creativeJobRow()];

  return {
    from(table: string) {
      if (table === "opportunities") {
        return {
          select() {
            const filters: Array<{ column: string; value: string }> = [];
            const builder = {
              eq(column: string, value: string) {
                filters.push({ column, value });
                return builder;
              },
              order() {
                return builder;
              },
              limit() {
                return builder;
              },
              then(resolve: (value: { data: OpportunityRow[]; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
                const data = opportunities.filter((row) => matches(row, filters));
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              },
            };
            return builder;
          },
        };
      }
      if (table === "creative_jobs") {
        return {
          select() {
            const filters: Array<{ column: string; value: string }> = [];
            const builder = {
              eq(column: string, value: string) {
                filters.push({ column, value });
                return builder;
              },
              async maybeSingle() {
                return { data: jobs.find((row) => matches(row, filters)) ?? null, error: null as ErrorLike | null };
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`Unexpected table in makeFailedJobClient: ${table}`);
    },
  } as unknown as CreativePrepClient;
}

test("runCreativePrepCli: a failed Creative Job produces a structured failed result and exit code 1", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creative-prep-cli-"));
  try {
    const { exitCode, result } = await runCreativePrepCli({
      lockPath: path.join(dir, ".run.lock"),
      outputDir: path.join(dir, "output"),
      createClient: async () => ({ ok: true, client: makeFailedJobClient() }),
      timezone: "UTC",
      now: () => Date.parse("2026-07-30T09:00:00.000Z"),
    });

    assert.equal(exitCode, 1);
    assert.equal(result?.outcome, "failed");
    assert.match(result?.reason ?? "", /operator attention/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCreativePrepCli: a failed scheduled run remains in the dated JSONL after a successful catch-up; latest.json reflects only the newest", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creative-prep-cli-"));
  const lockPath = path.join(dir, ".run.lock");
  const outputDir = path.join(dir, "output");
  const fixedNow = () => Date.parse("2026-07-30T09:00:00.000Z"); // same calendar date for both invocations

  try {
    const first = await runCreativePrepCli({ lockPath, outputDir, createClient: async () => ({ ok: true, client: makeFailedJobClient() }), timezone: "UTC", now: fixedNow });
    assert.equal(first.exitCode, 1);

    const second = await runCreativePrepCli({ lockPath, outputDir, createClient: async () => ({ ok: true, client: makeNoOpClient() }), timezone: "UTC", now: fixedNow });
    assert.equal(second.exitCode, 0);

    const lines = readFileSync(path.join(outputDir, "2026-07-30.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { outcome: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].outcome, "failed");
    assert.equal(lines[1].outcome, "no-op");

    const latest = JSON.parse(readFileSync(path.join(outputDir, "latest.json"), "utf8")) as { outcome: string };
    assert.equal(latest.outcome, "no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCreativePrepCli: a live lock exits 3 without performing any state transition", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creative-prep-cli-"));
  const lockPath = path.join(dir, ".run.lock");
  const held = acquireLock(lockPath);
  assert.equal(held.ok, true);

  let createClientCalled = false;
  try {
    const { exitCode } = await runCreativePrepCli({
      lockPath,
      outputDir: path.join(dir, "output"),
      createClient: async () => {
        createClientCalled = true;
        return { ok: true, client: makeNoOpClient() };
      },
    });

    assert.equal(exitCode, 3);
    assert.equal(createClientCalled, false);
  } finally {
    if (held.ok) held.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCreativePrepCli: a stale lock is reclaimed through the reused lock contract, not a new one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creative-prep-cli-"));
  const lockPath = path.join(dir, ".run.lock");
  // A lock file naming a PID that certainly isn't alive -- acquireLock's own staleness recovery
  // (dead PID, or older than its staleness window) reclaims it automatically. This is the same
  // recovery Daily Advisor already relies on; nothing new is being tested about the mechanism
  // itself, only that this script's lock path plays by the same rule.
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "2020-01-01T00:00:00.000Z" }), { flag: "wx" });

  try {
    const { exitCode } = await runCreativePrepCli({
      lockPath,
      outputDir: path.join(dir, "output"),
      createClient: async () => ({ ok: true, client: makeNoOpClient() }),
    });

    assert.equal(exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCreativePrepCli: the lock is released after a normal run, after missing credentials, and after an output-write failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "creative-prep-cli-"));
  const lockPath = path.join(dir, ".run.lock");

  function assertLockIsFree(): void {
    const reacquired = acquireLock(lockPath);
    assert.equal(reacquired.ok, true, "lock should have been released by the previous run");
    if (reacquired.ok) {
      reacquired.release();
    }
  }

  try {
    const normal = await runCreativePrepCli({ lockPath, outputDir: path.join(dir, "output-a"), createClient: async () => ({ ok: true, client: makeNoOpClient() }) });
    assert.equal(normal.exitCode, 0);
    assertLockIsFree();

    const missingCreds = await runCreativePrepCli({
      lockPath,
      outputDir: path.join(dir, "output-b"),
      createClient: async () => ({ ok: false, exitCode: 2, message: "Missing required Supabase credentials." }),
    });
    assert.equal(missingCreds.exitCode, 2);
    assertLockIsFree();

    // Point outputDir at a path that already exists as a *file* -- mkdirSync(recursive: true)
    // inside writeCreativePrepOutput throws in that case, exercising the write-failure path.
    const notADirectory = path.join(dir, "not-a-directory");
    writeFileSync(notADirectory, "occupied", "utf8");
    const writeFailure = await runCreativePrepCli({ lockPath, outputDir: notADirectory, createClient: async () => ({ ok: true, client: makeNoOpClient() }) });
    assert.equal(writeFailure.exitCode, 1);
    assertLockIsFree();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
