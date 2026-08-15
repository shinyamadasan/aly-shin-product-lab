import test from "node:test";
import assert from "node:assert/strict";

import type { AiTextFailureReason, AiTextProvider, AiTextRequest, AiTextResult } from "../src/lib/ai/ai-text-provider.ts";
import type { CreativeFormat } from "../src/lib/creative-formats.ts";
import {
  CREATIVE_AI_CLAUDE_MODEL,
  CREATIVE_AI_CODEX_MODEL,
  buildDefaultCreativeAiRoutes,
} from "../src/lib/creative-generation/ai-orchestrator.ts";
import { createCreativeAiExecutor, summarizeCreativeAiCompatibility } from "../src/lib/creative-generation/creative-ai-executor.ts";
import {
  buildMockCreativeJobResult,
  runCreativeJobWithExecutors,
  type CreativeJobRow,
} from "../src/lib/creative-jobs.ts";
import {
  createCreativePackageFromCompletedJob,
  validateCreativePackageContentV2,
  type CreativePackageRow,
  type CreativePackageRunnerClient,
} from "../src/lib/creative-packages.ts";
import { fromCreativeJobAttemptRow, type CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";
import type { Product } from "../src/lib/product-lab-types.ts";

// S3E-A2 -- the whole path through the REAL runner: claim -> creative_ai executor -> job completion
// -> trace-aware attempt finish -> v2 Creative Package materialization. Only the AI providers and
// the database are fakes; every function between them is the shipped one.

type ErrorLike = { code?: string; message: string };
type FakeStep = AiTextResult | ((request: AiTextRequest) => AiTextResult);

const NOW = Date.parse("2026-08-13T10:00:00.000Z");
const fixedNow = "2026-08-13T10:00:00.000Z";

class FakeProvider implements AiTextProvider {
  readonly providerId: string;
  readonly calls: AiTextRequest[] = [];
  private readonly steps: FakeStep[];
  constructor(providerId: string, steps: FakeStep[]) {
    this.providerId = providerId;
    this.steps = steps;
  }
  async generate(request: AiTextRequest): Promise<AiTextResult> {
    this.calls.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      return { ok: false, reason: "process_error", message: "no step", metadata: { providerId: this.providerId, model: request.model ?? null, durationMs: 1 } };
    }
    return typeof step === "function" ? step(request) : step;
  }
}

function aiSuccess(providerId: string, model: string, value: unknown, durationMs = 5): AiTextResult {
  return { ok: true, text: JSON.stringify(value), structuredValue: value, metadata: { providerId, model, durationMs } };
}
function aiFailure(reason: AiTextFailureReason, providerId: string, model: string, durationMs = 5): AiTextResult {
  return { ok: false, reason, message: reason, metadata: { providerId, model, durationMs } };
}

function formatDecision(format: CreativeFormat = "photo") {
  return { format, formatRationale: "Best fit for a simple product moment." };
}

function bodyFor(format: CreativeFormat = "photo"): Record<string, unknown> {
  const common = {
    angle: "A quiet blondie moment",
    hook: "Blondies, simply framed.",
    headline: "Blondies for the coffee pause",
    caption: "A calm kitchen moment with Blondies.",
    cta: "Save this idea for your next coffee break.",
    platformVariants: [{ platform: "instagram", caption: "Blondies and a coffee pause.", hashtags: ["#blondies"] }],
    // H1-B: the generation contract now requires this on every body. These fixtures are all camera
    // work, so capture_new keeps their meaning exactly as it was.
    productionSource: "capture_new",
  };
  if (format === "reel") {
    return {
      ...common,
      shots: [{ direction: "Pan across Blondies.", onScreenText: null, approxSeconds: 4, framing: "medium", movement: "pan" }],
      spokenScript: null,
      audioDirection: "Soft audio.",
    };
  }
  return { ...common, visualDirection: "Overhead phone photo on parchment.", overlayText: null, framing: "overhead" };
}

function recommendation(): MarketingRecommendation {
  return {
    id: "no_marketing_history:blondies",
    recommendationType: "no_marketing_history",
    priority: 1,
    confidence: "high",
    title: "Introduce Blondies in content",
    explanation: "Blondies has never appeared in the Journey.",
    suggestedNextAction: "Feature Blondies in a post.",
    evidence: { productId: "blondies", productName: "Blondies", entryCount: 0 },
  };
}

function product(): Product {
  return {
    id: "blondies",
    name: "Blondies",
    category: "Bars",
    role: "Hero candidate",
    status: "testing",
    description: "",
    image: "",
    decision: "Needs proof",
    isPublic: false,
  };
}

function queuedJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: null,
    intent: { schemaVersion: "v1", text: "Give me something easy today" },
    status: "queued",
    worker_type: "creative_ai",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-08-13T09:00:00.000Z",
    updated_at: "2026-08-13T09:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

// A faithful-enough stand-in for the two finish RPCs and the claim RPC: only the _with_trace
// variant can write ai_execution_trace, exactly as in the database.
function makeClient(options: { jobs?: CreativeJobRow[] } = {}) {
  const jobs = [...(options.jobs ?? [queuedJobRow()])];
  const packages: CreativePackageRow[] = [];
  const attempts: CreativeJobAttemptRow[] = [];
  const rpcCalls: string[] = [];

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function queryBuilder<T>(rows: T[]) {
    const filters: Array<{ column: string; value: string }> = [];
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      async maybeSingle() {
        return { data: rows.find((row) => matches(row as Record<string, unknown>, filters)) ?? null, error: null as ErrorLike | null };
      },
      select() {
        return {
          maybeSingle: builder.maybeSingle,
          async single() {
            const result = await builder.maybeSingle();
            return result.data ? result : { data: null, error: { message: "No row returned." } };
          },
        };
      },
      then(resolve: (value: { data: T[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve({ data: rows.filter((row) => matches(row as Record<string, unknown>, filters)), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "creative_jobs") {
        return { select: () => queryBuilder(jobs), insert: () => { throw new Error("out of scope"); } };
      }
      assert.equal(table, "creative_packages");
      return {
        select: () => queryBuilder(packages),
        insert(row: Partial<CreativePackageRow>) {
          return {
            select: () => ({
              async single() {
                if (packages.some((existing) => existing.creative_job_id === row.creative_job_id)) {
                  return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                }
                const inserted = {
                  creative_job_id: row.creative_job_id!,
                  status: row.status ?? "ready",
                  schema_version: row.schema_version ?? "v1",
                  content: row.content ?? {},
                  id: `package-${packages.length + 1}`,
                  created_at: fixedNow,
                  updated_at: fixedNow,
                } satisfies CreativePackageRow;
                packages.push(inserted);
                return { data: inserted, error: null };
              },
            }),
          };
        },
      };
    },
    rpc(functionName: string, args: Record<string, unknown>) {
      rpcCalls.push(functionName);
      return {
        async maybeSingle() {
          if (functionName === "claim_creative_job_with_attempt") {
            const job = jobs.find((candidate) => candidate.id === args.p_job_id);
            if (!job || job.status !== "queued") return { data: null, error: null as ErrorLike | null };
            job.status = "running";
            job.attempt_count += 1;
            job.started_at = "2026-08-13T09:30:00.000Z";
            const attempt: CreativeJobAttemptRow = {
              id: `attempt-${attempts.length + 1}`,
              creative_job_id: job.id!,
              attempt_number: job.attempt_count,
              worker_type: job.worker_type,
              status: "running",
              started_at: job.started_at,
              ai_execution_trace: null,
              created_at: fixedNow,
            };
            attempts.push(attempt);
            return { data: { ...job, attempt_id: attempt.id, attempt_number: attempt.attempt_number }, error: null };
          }
          if (functionName === "finish_creative_job") {
            const job = jobs.find((candidate) => candidate.id === args.p_job_id);
            if (!job || job.status !== "running") return { data: null, error: null as ErrorLike | null };
            job.status = args.p_outcome as CreativeJobRow["status"];
            if (args.p_outcome === "completed") {
              job.result = args.p_result as CreativeJobRow["result"];
              job.completed_at = fixedNow;
            } else {
              job.last_error = args.p_last_error as string;
              job.failed_at = fixedNow;
            }
            job.updated_at = fixedNow;
            return { data: job, error: null };
          }
          if (functionName === "finish_creative_job_attempt" || functionName === "finish_creative_job_attempt_with_trace") {
            const attempt = attempts.find((candidate) => candidate.id === args.p_attempt_id);
            if (!attempt || attempt.status !== "running") return { data: null, error: null as ErrorLike | null };
            attempt.status = args.p_outcome as CreativeJobAttemptRow["status"];
            attempt.completed_at = fixedNow;
            attempt.error_code = (args.p_error_code as string | null) ?? null;
            attempt.error_message = (args.p_error_message as string | null) ?? null;
            if (functionName === "finish_creative_job_attempt_with_trace") {
              attempt.ai_execution_trace = args.p_ai_execution_trace as never;
            }
            return { data: attempt, error: null };
          }
          throw new Error(`Unexpected RPC: ${functionName}`);
        },
      };
    },
  };

  return { client: client as unknown as CreativePackageRunnerClient, jobs, packages, attempts, rpcCalls };
}

function makeCreativeAiExecutor(claudeSteps: FakeStep[], codexSteps: FakeStep[] = []) {
  const claude = new FakeProvider("claude-cli", claudeSteps);
  const codex = new FakeProvider("codex-cli", codexSteps);
  const executor = createCreativeAiExecutor({
    routes: buildDefaultCreativeAiRoutes({ claude, codex }),
    now: () => NOW,
    loadGrounding: async () => ({
      recommendations: [recommendation()],
      journal: [],
      products: [product()],
      brandBible: BRAND_BIBLE,
      configuredPlatforms: ["instagram"],
    }),
  });
  return { executor, claude, codex };
}

// --- §25 the full success path ------------------------------------------------------------------

test("a mixed-provider creative_ai job completes, persists its full trace, and materializes a v2 package", async () => {
  const store = makeClient();
  const { executor } = makeCreativeAiExecutor(
    [aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo"), 1200), aiFailure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL, 300)],
    [aiSuccess("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor("photo"), 2400)],
  );

  const run = await runCreativeJobWithExecutors(store.client, "job-1", { creative_ai: executor });

  // Job completed.
  assert.equal(run.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].opportunity_id, null, "request-backed: no Opportunity anywhere");

  // Attempt completed, via the TRACE-AWARE finish path.
  assert.deepEqual(store.rpcCalls.filter((name) => name.startsWith("finish_creative_job_attempt")), ["finish_creative_job_attempt_with_trace"]);
  const attempt = fromCreativeJobAttemptRow(store.attempts[0]);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.workerType, "creative_ai");

  // All three invocations survived -- not collapsed to the last provider.
  assert.equal(attempt.aiExecutionTrace?.length, 3);
  assert.deepEqual(
    attempt.aiExecutionTrace?.map((entry) => `${entry.stage}:${entry.providerId}:${entry.action}`),
    ["format_decision:claude-cli:accepted", "creative_body:claude-cli:fallback", "creative_body:codex-cli:accepted"],
  );
  assert.equal(attempt.aiExecutionTrace?.[1].failureReason, "usage_limit");

  // §16 compatibility summary derives from the accepted BODY.
  assert.deepEqual(summarizeCreativeAiCompatibility(attempt.aiExecutionTrace ?? []), { provider: "codex-cli", model: CREATIVE_AI_CODEX_MODEL });

  // Package materializes as v2 through the existing materializer.
  const materialized = await createCreativePackageFromCompletedJob(store.client, "job-1");
  assert.equal(materialized.ok, true);
  assert.equal(materialized.ok && materialized.creativePackage.schemaVersion, "v2");
  assert.equal(store.packages.length, 1);
  assert.equal(store.packages[0].schema_version, "v2");
  assert.equal(validateCreativePackageContentV2(store.packages[0].content).ok, true);
  assert.equal((store.packages[0].content as { metadata: { sourceCreativeJobId: string } }).metadata.sourceCreativeJobId, "job-1");
  assert.equal((store.packages[0].content as { metadata: { sourceWorker: string } }).metadata.sourceWorker, "creative_ai");

  // No trace in package content.
  assert.equal(JSON.stringify(store.packages[0].content).includes("claude-cli"), false);

  // Idempotent.
  const again = await createCreativePackageFromCompletedJob(store.client, "job-1");
  assert.equal(again.ok && again.outcome, "existing");
  assert.equal(store.packages.length, 1);
});

// --- §23 expected failure through the runner ----------------------------------------------------

test("provider exhaustion fails the job, persists the trace on the attempt, and creates no package", async () => {
  const store = makeClient();
  const { executor } = makeCreativeAiExecutor(
    [aiFailure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
    [aiFailure("usage_limit", "codex-cli", CREATIVE_AI_CODEX_MODEL)],
  );

  const run = await runCreativeJobWithExecutors(store.client, "job-1", { creative_ai: executor });

  assert.equal(run.ok, false);
  assert.equal(store.jobs[0].status, "failed");
  assert.match(store.jobs[0].last_error ?? "", /format_decision/);

  // The attempt failed AND kept its history -- via the trace-aware RPC.
  assert.deepEqual(store.rpcCalls.filter((name) => name.startsWith("finish_creative_job_attempt")), ["finish_creative_job_attempt_with_trace"]);
  const attempt = fromCreativeJobAttemptRow(store.attempts[0]);
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.errorCode, "ai_usage_limit");
  assert.equal(attempt.aiExecutionTrace?.length, 2);
  assert.deepEqual(attempt.aiExecutionTrace?.map((entry) => entry.providerId), ["claude-cli", "codex-cli"]);

  // No package, and no placeholder content.
  const materialized = await createCreativePackageFromCompletedJob(store.client, "job-1");
  assert.equal(materialized.ok, false);
  assert.equal(!materialized.ok && materialized.reason, "invalid-job-status");
  assert.equal(store.packages.length, 0);
});

test("an AI timeout marks the attempt timed_out and still persists the trace", async () => {
  const store = makeClient();
  const { executor } = makeCreativeAiExecutor(
    [aiFailure("timeout", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
    [aiFailure("timeout", "codex-cli", CREATIVE_AI_CODEX_MODEL)],
  );

  const run = await runCreativeJobWithExecutors(store.client, "job-1", { creative_ai: executor });

  assert.equal(run.ok, false);
  assert.equal(!run.ok && run.reason, "timeout");
  assert.equal(store.jobs[0].status, "failed");
  const attempt = fromCreativeJobAttemptRow(store.attempts[0]);
  assert.equal(attempt.status, "timed_out");
  assert.equal(attempt.aiExecutionTrace?.length, 2, "a timed-out AI attempt keeps its history");
});

// --- §24 unexpected exception -------------------------------------------------------------------

test("an infrastructure exception fails the job through the existing exception path with no trace", async () => {
  const store = makeClient();
  const executor = createCreativeAiExecutor({
    routes: buildDefaultCreativeAiRoutes({ claude: new FakeProvider("claude-cli", []), codex: new FakeProvider("codex-cli", []) }),
    now: () => NOW,
    loadGrounding: async () => {
      throw new Error("Creative AI grounding read failed: connection refused");
    },
  });

  const run = await runCreativeJobWithExecutors(store.client, "job-1", { creative_ai: executor });

  assert.equal(run.ok, false);
  assert.equal(store.jobs[0].status, "failed");
  assert.match(store.jobs[0].last_error ?? "", /Worker execution failed.*connection refused/);
  // Nothing was attempted, so nothing is claimed: the untraced RPC, and a NULL trace.
  assert.deepEqual(store.rpcCalls.filter((name) => name.startsWith("finish_creative_job_attempt")), ["finish_creative_job_attempt"]);
  assert.equal(store.attempts[0].ai_execution_trace, null);
  assert.equal(store.packages.length, 0);
});

// --- §29 legacy regression ----------------------------------------------------------------------

test("a legacy v1 worker is completely unaffected by creative_ai existing", async () => {
  const store = makeClient({ jobs: [queuedJobRow({ worker_type: "mock" })] });

  const run = await runCreativeJobWithExecutors(store.client, "job-1", {
    mock: (_job, input) => buildMockCreativeJobResult(input),
    creative_ai: makeCreativeAiExecutor([]).executor,
  });

  assert.equal(run.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal((store.jobs[0].result as { schemaVersion: string }).schemaVersion, "v1");

  // The original untraced RPC, and a NULL trace -- no empty array is forced onto a non-AI attempt.
  assert.deepEqual(store.rpcCalls.filter((name) => name.startsWith("finish_creative_job_attempt")), ["finish_creative_job_attempt"]);
  assert.equal(store.attempts[0].ai_execution_trace, null);
  assert.equal(fromCreativeJobAttemptRow(store.attempts[0]).aiExecutionTrace, null);

  // ...and it still materializes as a v1 package.
  const materialized = await createCreativePackageFromCompletedJob(store.client, "job-1");
  assert.equal(materialized.ok && materialized.creativePackage.schemaVersion, "v1");
});

test("a creative_ai job with no executor registered fails cleanly rather than half-working", async () => {
  const store = makeClient();
  const run = await runCreativeJobWithExecutors(store.client, "job-1", { mock: (_job, input) => buildMockCreativeJobResult(input) });

  assert.equal(run.ok, false);
  assert.match(store.jobs[0].last_error ?? "", /No executor is registered for worker type: creative_ai/);
  assert.equal(store.packages.length, 0);
});
