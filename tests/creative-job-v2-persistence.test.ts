import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMockCreativeJobResult,
  completeRunningCreativeJob,
  fromCreativeJobRow,
  isCreativeJobResultEnvelope,
  isCreativeJobResultEnvelopeV2,
  runCreativeJobWithExecutors,
  validateAnyCreativeJobResultEnvelope,
  validateCreativeJobResultEnvelope,
  validateCreativeJobResultEnvelopeV2,
  type CreativeJobResultEnvelopeV1,
  type CreativeJobResultEnvelopeV2,
  type CreativeJobRow,
} from "../src/lib/creative-jobs.ts";
import {
  buildCreativePackageContentV2FromCompletedJob,
  createCreativePackageFromCompletedJob,
  isCreativePackageContentV1,
  isCreativePackageContentV2,
  type CreativePackageContentV2,
  type CreativePackageMetadataV2,
  type CreativePackageRow,
  type CreativePackageRunnerClient,
} from "../src/lib/creative-packages.ts";
import { fromCreativeJobAttemptRow, type CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import type { CreativeAiInvocationTraceEntry } from "../src/lib/creative-generation/ai-orchestrator.ts";
import { buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-08-13T10:00:00.000Z";

// --- fixtures -----------------------------------------------------------------------------------

// A real v1 envelope, produced by the real v1 builder rather than hand-written, so these tests
// cannot drift from what the shipped workers actually emit.
function v1Envelope(): CreativeJobResultEnvelopeV1 {
  return buildMockCreativeJobResult(
    buildCreativeInputFromRequest({ text: "promote the Biscoff Blondie", subject: "Biscoff Blondie", formatHint: null }),
  );
}

function v2Metadata(overrides: Partial<CreativePackageMetadataV2> = {}): CreativePackageMetadataV2 {
  return {
    generatedFromOpportunity: null,
    generatorVersion: "2",
    sourceCreativeJobId: "job-1",
    sourceWorker: "product_text_worker",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "Strong visual product moment.",
    subjectSource: "stated",
    subjectGrounding: null,
    ...overrides,
  };
}

function v2Content(overrides: Partial<CreativePackageContentV2> = {}): CreativePackageContentV2 {
  return {
    schemaVersion: "v2",
    format: "photo",
    subject: "Biscoff Blondie",
    angle: "The recipe changed and here is why",
    hook: "We changed the blondie recipe.",
    headline: "New Biscoff Blondie",
    caption: "Brown butter, Biscoff swirl, baked this morning.",
    cta: "Order for Saturday pickup",
    platformVariants: [{ platform: "instagram", caption: "Baked this morning.", hashtags: ["#blondies"] }],
    visualDirection: "Overhead shot of a cut blondie on parchment.",
    overlayText: null,
    metadata: v2Metadata(),
    ...overrides,
  } as CreativePackageContentV2;
}

// The mixed-provider history S3C-D actually produces: Claude accepted the format decision, Claude
// then hit its usage limit on the body and fell back, and Codex produced the accepted body.
const MIXED_PROVIDER_TRACE: CreativeAiInvocationTraceEntry[] = [
  { stage: "format_decision", providerId: "claude-cli", model: "opus", invocationNumber: 1, providerInvocationNumber: 1, outcome: "success", durationMs: 1200, action: "accepted" },
  { stage: "creative_body", providerId: "claude-cli", model: "opus", invocationNumber: 2, providerInvocationNumber: 2, outcome: "failure", failureReason: "usage_limit", durationMs: 300, action: "fallback" },
  { stage: "creative_body", providerId: "codex-cli", model: "gpt-5.6-sol", invocationNumber: 3, providerInvocationNumber: 1, outcome: "success", durationMs: 2400, action: "accepted" },
];

function v2Envelope(overrides: Partial<CreativeJobResultEnvelopeV2> = {}): CreativeJobResultEnvelopeV2 {
  return {
    schemaVersion: "v2",
    worker: "product_text_worker",
    content: v2Content(),
    executionTrace: MIXED_PROVIDER_TRACE,
    ...overrides,
  };
}

function jobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: null,
    intent: { schemaVersion: "v1", text: "promote the Biscoff Blondie" },
    status: "completed",
    worker_type: "product_text_worker",
    attempt_count: 1,
    result: v1Envelope(),
    last_error: null,
    created_at: "2026-08-13T09:00:00.000Z",
    updated_at: fixedNow,
    started_at: "2026-08-13T09:30:00.000Z",
    completed_at: fixedNow,
    failed_at: null,
    ...overrides,
  };
}

// --- fake client --------------------------------------------------------------------------------

function makeClient(options: { jobs?: CreativeJobRow[]; packages?: CreativePackageRow[] } = {}) {
  const jobs = [...(options.jobs ?? [jobRow()])];
  const packages = [...(options.packages ?? [])];
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
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
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
        return {
          select() {
            return queryBuilder(jobs);
          },
          insert() {
            throw new Error("Creative Job inserts are out of scope here.");
          },
        };
      }

      assert.equal(table, "creative_packages");
      return {
        select() {
          return queryBuilder(packages);
        },
        insert(row: Partial<CreativePackageRow>) {
          return {
            select() {
              return {
                async single() {
                  // The real unique index on creative_job_id, honoured rather than assumed.
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
              };
            },
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
            if (!job || job.status !== "queued") {
              return { data: null, error: null as ErrorLike | null };
            }
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
            if (!job || job.status !== "running") {
              return { data: null, error: null as ErrorLike | null };
            }
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

          // The two finish-attempt RPCs, kept genuinely distinct: only the _with_trace variant
          // knows how to write ai_execution_trace, exactly as in the database.
          if (functionName === "finish_creative_job_attempt" || functionName === "finish_creative_job_attempt_with_trace") {
            const attempt = attempts.find((candidate) => candidate.id === args.p_attempt_id);
            if (!attempt || attempt.status !== "running") {
              return { data: null, error: null as ErrorLike | null };
            }
            attempt.status = args.p_outcome as CreativeJobAttemptRow["status"];
            attempt.completed_at = fixedNow;
            attempt.error_code = (args.p_error_code as string | null) ?? null;
            attempt.error_message = (args.p_error_message as string | null) ?? null;
            if (functionName === "finish_creative_job_attempt_with_trace") {
              attempt.ai_execution_trace = args.p_ai_execution_trace as CreativeAiInvocationTraceEntry[];
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

// --- §22 result-envelope tests ------------------------------------------------------------------

test("A. an existing v1 result envelope still validates, unchanged", () => {
  const envelope = v1Envelope();
  const v1 = validateCreativeJobResultEnvelope(envelope);
  assert.equal(v1.ok, true);
  assert.ok(isCreativeJobResultEnvelope(envelope));

  // ...and through the version-dispatching validator the runner now uses, identically.
  const any = validateAnyCreativeJobResultEnvelope(envelope);
  assert.equal(any.ok, true);
  assert.deepEqual(any.ok && any.result, envelope);
});

test("B. an existing invalid v1 envelope stays invalid, with the same reason and message as before", () => {
  const cases: Array<[unknown, string, string]> = [
    ["not an object", "unsupported-schema-version", "Creative Job result must be a v1 object envelope."],
    [{ ...v1Envelope(), schemaVersion: "v3" }, "unsupported-schema-version", "Creative Job result schemaVersion must be v1."],
    [{ ...v1Envelope(), worker: "definitely_not_a_worker" }, "unsupported-worker", "Creative Job result worker is not supported."],
    [{ ...v1Envelope(), output: { headline: "   ", caption: "ok" } }, "malformed-output", "Creative Job result output must include non-empty headline and caption strings."],
    [{ ...v1Envelope(), metadata: { generatedFromOpportunity: "", generatorVersion: "1" } }, "malformed-metadata", "Creative Job result metadata must include a valid generatedFromOpportunity value (an opportunity id, or null for a request-backed job) and generatorVersion 1."],
    [{ ...v1Envelope(), artifacts: ["something"] }, "malformed-artifacts", "Creative Job result artifacts must be an empty array for this milestone."],
  ];

  for (const [value, reason, message] of cases) {
    const direct = validateCreativeJobResultEnvelope(value);
    assert.equal(direct.ok, false);
    assert.equal(!direct.ok && direct.reason, reason);
    assert.equal(!direct.ok && direct.message, message);

    // The dispatching validator must not change any of it -- same reason, same message.
    const any = validateAnyCreativeJobResultEnvelope(value);
    assert.equal(any.ok, false);
    assert.equal(!any.ok && any.reason, reason);
    assert.equal(!any.ok && any.message, message);
  }
});

test("C. a valid v2 envelope validates", () => {
  const envelope = v2Envelope();
  const result = validateCreativeJobResultEnvelopeV2(envelope);
  assert.equal(result.ok, true);
  assert.ok(isCreativeJobResultEnvelopeV2(envelope));
  assert.equal(validateAnyCreativeJobResultEnvelope(envelope).ok, true);

  // An AI run with no fallback is equally valid -- the trace is history, not a required shape.
  assert.equal(validateCreativeJobResultEnvelopeV2(v2Envelope({ executionTrace: [] })).ok, true);
});

test("D. invalid v2 package content is rejected, carrying the S2 validator's own message", () => {
  const missingHook = validateCreativeJobResultEnvelopeV2(v2Envelope({ content: v2Content({ hook: "   " }) }));
  assert.equal(missingHook.ok, false);
  assert.equal(!missingHook.ok && missingHook.reason, "malformed-content");
  assert.equal(!missingHook.ok && missingHook.message, "Creative Package v2 requires a non-empty hook.");

  // The authoritative S2 rule about ungrounded assumptions still applies through the envelope.
  const ungrounded = validateCreativeJobResultEnvelopeV2(
    v2Envelope({ content: v2Content({ metadata: v2Metadata({ subjectSource: "assumed", subjectGrounding: null }) }) }),
  );
  assert.equal(ungrounded.ok, false);
  assert.equal(!ungrounded.ok && ungrounded.reason, "malformed-content");

  // A v2 envelope with no content at all is not a v2 envelope.
  assert.equal(validateCreativeJobResultEnvelopeV2({ schemaVersion: "v2", worker: "mock", executionTrace: [] }).ok, false);
  // ...nor is one whose worker is unsupported.
  assert.equal(validateCreativeJobResultEnvelopeV2(v2Envelope({ worker: "creative_ai" as never })).ok, false);
});

test("E. a v1 envelope is never silently parsed as v2", () => {
  const envelope = v1Envelope();
  const asV2 = validateCreativeJobResultEnvelopeV2(envelope);
  assert.equal(asV2.ok, false);
  assert.equal(!asV2.ok && asV2.reason, "unsupported-schema-version");
  assert.equal(isCreativeJobResultEnvelopeV2(envelope), false);

  // The dispatcher sends it to the v1 validator, and it comes back as v1 -- not as v2.
  const any = validateAnyCreativeJobResultEnvelope(envelope);
  assert.equal(any.ok && any.result.schemaVersion, "v1");
});

test("F. a v2 envelope is never silently parsed as v1", () => {
  const envelope = v2Envelope();
  const asV1 = validateCreativeJobResultEnvelope(envelope);
  assert.equal(asV1.ok, false);
  assert.equal(!asV1.ok && asV1.reason, "unsupported-schema-version");
  assert.equal(!asV1.ok && asV1.message, "Creative Job result schemaVersion must be v1.");
  assert.equal(isCreativeJobResultEnvelope(envelope), false);

  const any = validateAnyCreativeJobResultEnvelope(envelope);
  assert.equal(any.ok && any.result.schemaVersion, "v2");
});

test("G. execution metadata cannot smuggle anything into or over the package content", () => {
  // The trace is validated as a CLOSED shape: an entry carrying a raw response, a prompt, a
  // credential or any other unrecognized field is rejected rather than quietly persisted.
  for (const smuggled of [
    { rawResponse: "{...the entire model output...}" },
    { prompt: "You are a bakery copywriter..." },
    { apiKey: "sk-live-abcdef" },
    { stdout: "+ claude --print" },
    { content: v2Content() },
  ]) {
    const result = validateCreativeJobResultEnvelopeV2(v2Envelope({ executionTrace: [{ ...MIXED_PROVIDER_TRACE[0], ...smuggled } as CreativeAiInvocationTraceEntry] }));
    assert.equal(result.ok, false, `expected rejection of trace entry carrying ${Object.keys(smuggled)[0]}`);
    assert.equal(!result.ok && result.reason, "malformed-execution-trace");
  }

  // A structurally wrong trace is rejected too -- it is not accepted merely because content is fine.
  assert.equal(validateCreativeJobResultEnvelopeV2({ ...v2Envelope(), executionTrace: "claude then codex" }).ok, false);
  assert.equal(validateCreativeJobResultEnvelopeV2(v2Envelope({ executionTrace: [{ stage: "not_a_stage" } as unknown as CreativeAiInvocationTraceEntry] })).ok, false);

  // And the content the envelope carries is exactly the content that was put in -- the validator
  // returns it untouched rather than rebuilding it from anything in the trace.
  const envelope = v2Envelope();
  const validated = validateCreativeJobResultEnvelopeV2(envelope);
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.ok && validated.result.content, v2Content());
});

// --- §23 package-materializer tests -------------------------------------------------------------

test("A + B. a v1 job result still creates a schema_version v1 package, with unchanged content", async () => {
  const { client, packages } = makeClient();
  const result = await createCreativePackageFromCompletedJob(client, "job-1");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "created");
  assert.equal(result.ok && result.creativePackage.schemaVersion, "v1");
  assert.equal(packages.length, 1);
  assert.equal(packages[0].schema_version, "v1");
  assert.ok(isCreativePackageContentV1(packages[0].content));

  // Byte-for-byte what the v1 builder produces -- this slice changed nothing about v1 content.
  const envelope = v1Envelope();
  assert.deepEqual(packages[0].content, {
    output: { headline: envelope.output.headline, caption: envelope.output.caption },
    metadata: {
      generatedFromOpportunity: null,
      generatorVersion: "1",
      sourceCreativeJobId: "job-1",
      sourceWorker: "mock",
      sourceJobResultSchemaVersion: "v1",
    },
    artifacts: [],
  });
});

test("C + D. a v2 job result creates a schema_version v2 package whose content is the validated S2 content", async () => {
  const { client, packages } = makeClient({ jobs: [jobRow({ result: v2Envelope() })] });
  const result = await createCreativePackageFromCompletedJob(client, "job-1");

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "created");
  assert.equal(result.ok && result.creativePackage.schemaVersion, "v2");
  assert.equal(packages.length, 1);
  assert.equal(packages[0].schema_version, "v2");

  // Equal to the validated S2 content, and nothing else: the execution trace did NOT come along.
  assert.deepEqual(packages[0].content, v2Content());
  assert.ok(isCreativePackageContentV2(packages[0].content));
  assert.equal("executionTrace" in (packages[0].content as Record<string, unknown>), false);
  assert.equal(JSON.stringify(packages[0].content).includes("claude-cli"), false);
});

test("E. malformed v2 content is rejected at persistence, even when the caller claims it is valid", async () => {
  // A job whose stored result claims schemaVersion v2 but carries content S2 refuses.
  const { client, packages } = makeClient({ jobs: [jobRow({ result: v2Envelope({ content: v2Content({ cta: "" }) }) })] });
  const result = await createCreativePackageFromCompletedJob(client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "unsupported-result");
  assert.match(!result.ok ? result.message : "", /non-empty cta/i);
  assert.equal(packages.length, 0, "no package may be written from malformed v2 content");
});

test("E2. v2 content naming a different source Creative Job is refused rather than persisted", async () => {
  const { client, packages } = makeClient({
    jobs: [jobRow({ result: v2Envelope({ content: v2Content({ metadata: v2Metadata({ sourceCreativeJobId: "some-other-job" }) }) }) })],
  });
  const result = await createCreativePackageFromCompletedJob(client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "unsupported-result");
  assert.match(!result.ok ? result.message : "", /names a different source Creative Job/i);
  assert.equal(packages.length, 0);
});

test("F. materializing the same completed job twice is idempotent, for both versions", async () => {
  for (const [label, result] of [["v1", v1Envelope()], ["v2", v2Envelope()]] as const) {
    const { client, packages } = makeClient({ jobs: [jobRow({ result })] });

    const first = await createCreativePackageFromCompletedJob(client, "job-1");
    const second = await createCreativePackageFromCompletedJob(client, "job-1");

    assert.equal(first.ok && first.outcome, "created", label);
    assert.equal(second.ok && second.outcome, "existing", label);
    assert.equal(first.ok && second.ok && first.creativePackage.id, second.ok ? second.creativePackage.id : "", label);
    assert.equal(packages.length, 1, `${label}: exactly one Creative Package per Creative Job`);
  }
});

test("G. no Creative Package is created from a failed job, or from a job that never completed", async () => {
  for (const status of ["failed", "queued", "running"] as const) {
    const { client, packages } = makeClient({ jobs: [jobRow({ status, result: status === "failed" ? {} : v2Envelope(), last_error: "Creative Job execution failed." })] });
    const result = await createCreativePackageFromCompletedJob(client, "job-1");

    assert.equal(result.ok, false, status);
    assert.equal(!result.ok && result.reason, "invalid-job-status", status);
    assert.equal(packages.length, 0, `${status}: no package may exist`);
  }
});

test("a completed job whose result is neither v1 nor v2 is refused, naming the version it claimed", async () => {
  const unversioned = await createCreativePackageFromCompletedJob(makeClient({ jobs: [jobRow({ result: { some: "shape" } })] }).client, "job-1");
  assert.equal(!unversioned.ok && unversioned.reason, "unsupported-result");
  assert.equal(!unversioned.ok && unversioned.message, "Creative Job result is not a supported v1 package source.");

  // A result that claims v2 gets a v2 diagnosis, not a misleading "not a supported v1 source".
  const brokenV2 = await createCreativePackageFromCompletedJob(makeClient({ jobs: [jobRow({ result: { schemaVersion: "v2", worker: "mock" } })] }).client, "job-1");
  assert.equal(!brokenV2.ok && brokenV2.reason, "unsupported-result");
  assert.match(!brokenV2.ok ? brokenV2.message : "", /not a supported v2 package source/i);
});

test("buildCreativePackageContentV2FromCompletedJob refuses a job that is not completed", () => {
  const job = fromCreativeJobRow(jobRow({ status: "running", result: v2Envelope() }));
  assert.throws(() => buildCreativePackageContentV2FromCompletedJob(job), /can only be materialized from completed Creative Jobs/i);
});

// --- §24 trace-persistence tests ----------------------------------------------------------------

test("a v2 result hands its mixed-provider trace to the attempt row, uncollapsed", async () => {
  const { client, attempts, rpcCalls } = makeClient({ jobs: [jobRow({ status: "queued", result: {} })] });

  const run = await runCreativeJobWithExecutors(client, "job-1", { product_text_worker: () => v2Envelope() });
  assert.equal(run.ok, true);

  assert.equal(rpcCalls.includes("finish_creative_job_attempt_with_trace"), true, "a traced attempt must use the trace-aware RPC");
  assert.equal(rpcCalls.includes("finish_creative_job_attempt"), false, "and must not also call the untraced one");

  const attempt = fromCreativeJobAttemptRow(attempts[0]);
  assert.equal(attempt.status, "completed");
  assert.notEqual(attempt.aiExecutionTrace, null);

  // The whole history survived: three invocations, both providers, the usage_limit fallback intact.
  assert.equal(attempt.aiExecutionTrace?.length, 3);
  assert.deepEqual(
    attempt.aiExecutionTrace?.map((entry) => `${entry.providerId}:${entry.model}:${entry.action}`),
    ["claude-cli:opus:accepted", "claude-cli:opus:fallback", "codex-cli:gpt-5.6-sol:accepted"],
  );
  assert.equal(attempt.aiExecutionTrace?.[1].failureReason, "usage_limit");

  // Not collapsed to the last accepted provider. provider/model remain compatibility summary
  // metadata and this slice writes neither -- the trace is the authority.
  assert.deepEqual(attempt.aiExecutionTrace, MIXED_PROVIDER_TRACE);
  assert.equal(attempt.provider, "");
  assert.equal(attempt.model, "");
});

test("an attempt with no AI execution takes the original untraced RPC and stays NULL", async () => {
  const { client, attempts, rpcCalls } = makeClient({ jobs: [jobRow({ status: "queued", result: {} })] });

  const run = await runCreativeJobWithExecutors(client, "job-1", { product_text_worker: (_job, input) => buildMockCreativeJobResult(input) });
  assert.equal(run.ok, true);

  assert.deepEqual(rpcCalls.filter((name) => name.startsWith("finish_creative_job_attempt")), ["finish_creative_job_attempt"]);
  assert.equal(attempts[0].ai_execution_trace, null, "absence must be NULL, never a fabricated empty array");
  assert.equal(fromCreativeJobAttemptRow(attempts[0]).aiExecutionTrace, null);
});

test("a v2 result whose content is malformed fails the job, writes no trace it cannot vouch for, and creates no package", async () => {
  const { client, jobs, attempts, rpcCalls } = makeClient({ jobs: [jobRow({ status: "queued", result: {} })] });

  const run = await runCreativeJobWithExecutors(client, "job-1", { product_text_worker: () => v2Envelope({ content: v2Content({ headline: "" }) }) });

  assert.equal(run.ok, false);
  assert.equal(jobs[0].status, "failed");
  assert.equal(attempts[0].status, "failed");
  // The envelope never validated, so there is no trace this slice is entitled to claim as truth.
  assert.deepEqual(rpcCalls.filter((name) => name.startsWith("finish_creative_job_attempt")), ["finish_creative_job_attempt"]);
  assert.equal(attempts[0].ai_execution_trace, null);

  const packageResult = await createCreativePackageFromCompletedJob(client, "job-1");
  assert.equal(packageResult.ok, false);
  assert.equal(!packageResult.ok && packageResult.reason, "invalid-job-status");
});

test("completeRunningCreativeJob writes a v2 envelope through the same job-completion path as v1", async () => {
  for (const [label, envelope] of [["v1", v1Envelope()], ["v2", v2Envelope()]] as const) {
    const { client, jobs } = makeClient({ jobs: [jobRow({ status: "running", result: {} })] });
    const job = fromCreativeJobRow(jobs[0]);

    const result = await completeRunningCreativeJob(client, job, envelope);

    assert.equal(result.ok, true, label);
    assert.equal(jobs[0].status, "completed", label);
    assert.deepEqual(jobs[0].result, envelope, label);
  }
});
