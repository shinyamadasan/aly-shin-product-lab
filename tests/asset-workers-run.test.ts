import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTEMPT_BOOKKEEPING_EXIT_CODE,
  buildAssetExportDocument,
  parseSubcommand,
  runExportCommand,
  runImportCommand,
  runProductionWorkerCommand,
} from "../scripts/asset-workers/run.ts";
import type { AssetJobExecutionClient } from "../src/lib/asset-jobs.ts";
import type { AssetJobRow } from "../src/lib/asset-jobs.ts";
import type { AssetJobAttemptRow } from "../src/lib/asset-job-attempts.ts";
import type { CreativePackageRow } from "../src/lib/creative-packages.ts";
import { buildAssetGenerationSpec } from "../src/lib/asset-generation-spec.ts";
import { fromCreativePackageRow } from "../src/lib/creative-packages.ts";
import { GENERATED_ASSETS_BUCKET } from "../src/lib/asset-binary.ts";

const fixedNow = "2026-08-05T10:00:00.000Z";
const startedAt = "2026-08-05T10:01:00.000Z";
const finishedAt = "2026-08-05T10:05:00.000Z";

const png1080 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x38,
  0x00, 0x00, 0x04, 0x38,
  0x08, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v1",
    content: {
      output: { headline: "Launch-ready Brownies content", caption: "Brownies are ready." },
      metadata: {
        generatedFromOpportunity: "opportunity-1",
        generatorVersion: "1",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v1",
      },
      artifacts: [],
    },
    created_at: "2026-08-05T09:05:00.000Z",
    updated_at: "2026-08-05T09:05:00.000Z",
    ...overrides,
  };
}

function assetJobRow(overrides: Partial<AssetJobRow> = {}): AssetJobRow {
  return {
    id: "asset-job-1",
    creative_package_id: "package-1",
    status: "queued",
    worker_type: "external",
    asset_kind: "image",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-08-05T09:10:00.000Z",
    updated_at: "2026-08-05T09:10:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

// A focused fake -- proves the CLI's own wiring (reads before claiming, claims once, completes end
// to end), not every edge case of runAssetJobWithExecutors, which already has its own exhaustive
// suite in tests/asset-jobs.test.ts.
function makeClient(options: { creativePackages?: CreativePackageRow[]; jobs?: AssetJobRow[]; finishAttemptError?: { code?: string; message: string } } = {}) {
  const creativePackages = [...(options.creativePackages ?? [creativePackageRow()])];
  const jobs = [...(options.jobs ?? [assetJobRow()])];
  const attempts: AssetJobAttemptRow[] = [];
  const events: string[] = [];

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
      async maybeSingle() {
        return { data: rows.find((row) => matches(row as Record<string, unknown>, filters)) ?? null, error: null };
      },
      select() {
        return { maybeSingle: builder.maybeSingle };
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "creative_packages") {
        return { select: () => queryBuilder(creativePackages) };
      }
      assert.equal(table, "asset_jobs");
      return { select: () => queryBuilder(jobs) };
    },
    rpc(functionName: string, args: Record<string, unknown>) {
      if (functionName === "claim_asset_job_with_attempt") {
        return {
          async maybeSingle() {
            const index = jobs.findIndex((row) => row.id === (args.p_job_id as string) && row.status === "queued");
            if (index === -1) return { data: null, error: null };
            jobs[index] = { ...jobs[index], status: "running", attempt_count: jobs[index].attempt_count + 1, started_at: startedAt, updated_at: startedAt };
            events.push("claim-job");
            const attempt: AssetJobAttemptRow = {
              id: `attempt-${attempts.length + 1}`,
              asset_job_id: jobs[index].id!,
              attempt_number: jobs[index].attempt_count,
              worker_type: jobs[index].worker_type,
              status: "running",
              started_at: startedAt,
              completed_at: null,
              latency_ms: null,
              error_code: null,
              error_message: null,
              provider: null,
              model: null,
              created_at: fixedNow,
            };
            attempts.push(attempt);
            return { data: { ...jobs[index], attempt_id: attempt.id, attempt_number: attempt.attempt_number }, error: null };
          },
        };
      }

      if (functionName === "finish_asset_job") {
        return {
          async maybeSingle() {
            const outcome = args.p_outcome as string;
            const validOutcome = outcome === "completed" || outcome === "failed";
            const index = jobs.findIndex((row) => row.id === (args.p_job_id as string) && row.status === "running");
            if (index === -1 || !validOutcome) return { data: null, error: null };
            jobs[index] = {
              ...jobs[index],
              status: outcome as AssetJobRow["status"],
              result: outcome === "completed" ? (args.p_result as AssetJobRow["result"]) : jobs[index].result,
              last_error: outcome === "failed" ? (args.p_last_error as string | null) : null,
              completed_at: outcome === "completed" ? finishedAt : null,
              failed_at: outcome === "failed" ? finishedAt : null,
              updated_at: finishedAt,
            };
            events.push(outcome === "completed" ? "complete-job" : "fail-job");
            return { data: jobs[index], error: null };
          },
        };
      }

      if (functionName === "complete_asset_job_with_files") {
        return {
          async maybeSingle() {
            const index = jobs.findIndex((row) => row.id === (args.p_asset_job_id as string) && row.status === "running");
            if (index === -1) return { data: null, error: null };
            jobs[index] = { ...jobs[index], status: "completed", result: args.p_result as AssetJobRow["result"], last_error: null, completed_at: finishedAt, failed_at: null, updated_at: finishedAt };
            events.push("complete-job-with-files");
            const file = (args.p_files as Array<Record<string, unknown>>)[0];
            return {
              data: {
                job: jobs[index],
                asset: {
                  id: "asset-1",
                  asset_job_id: jobs[index].id,
                  status: "generated",
                  asset_kind: jobs[index].asset_kind,
                  schema_version: "v1",
                  content: { metadata: { generatedFromCreativePackage: jobs[index].creative_package_id, sourceAssetJobId: jobs[index].id, generatorVersion: "1" } },
                  created_at: finishedAt,
                  updated_at: finishedAt,
                },
                files: [
                  {
                    id: "file-1",
                    asset_id: "asset-1",
                    position: Number(file.position),
                    storage_bucket: String(file.storage_bucket),
                    storage_path: String(file.storage_path),
                    public_url: String(file.public_url),
                    mime_type: String(file.mime_type),
                    file_size_bytes: Number(file.file_size_bytes),
                    width: Number(file.width),
                    height: Number(file.height),
                    duration_ms: null,
                    checksum_sha256: String(file.checksum_sha256),
                    created_at: finishedAt,
                  },
                ],
              },
              error: null,
            };
          },
        };
      }

      // Both attempt-finish RPCs land here, exactly as in the other attempt fakes.
      assert.ok(
        functionName === "finish_asset_job_attempt" || functionName === "finish_asset_job_attempt_with_provenance",
        `unexpected attempt RPC: ${functionName}`,
      );
      return {
        async maybeSingle() {
          // Stands in for the most likely real failure: the provenance RPC has not been created yet
          // because supabase-add-asset-job-attempt-provenance.sql was never applied.
          if (options.finishAttemptError) {
            events.push("finish-attempt-error");
            return { data: null, error: options.finishAttemptError };
          }
          const outcome = args.p_outcome as string;
          const index = attempts.findIndex((row) => row.id === (args.p_attempt_id as string) && row.status === "running");
          if (index === -1) return { data: null, error: null };
          const carriesProvenance = functionName === "finish_asset_job_attempt_with_provenance";
          attempts[index] = {
            ...attempts[index],
            status: outcome as AssetJobAttemptRow["status"],
            completed_at: finishedAt,
            latency_ms: 0,
            error_code: null,
            error_message: null,
            provider: carriesProvenance ? ((args.p_provider as string | null) ?? attempts[index].provider ?? null) : attempts[index].provider,
            model: carriesProvenance ? ((args.p_model as string | null) ?? attempts[index].model ?? null) : attempts[index].model,
          };
          events.push("finish-attempt");
          return { data: attempts[index], error: null };
        },
      };
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, GENERATED_ASSETS_BUCKET);
        return {
          async upload(path: string) {
            events.push(`upload:${path}`);
            return { data: { path }, error: null };
          },
          async download() {
            return { data: null, error: { message: "not found" } };
          },
          async remove() {
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as AssetJobExecutionClient;

  return { client, jobs, attempts, events };
}

test("parseSubcommand recognizes export, import, and the bounded production run command", () => {
  assert.equal(parseSubcommand(["export"]), "export");
  assert.equal(parseSubcommand(["import"]), "import");
  assert.equal(parseSubcommand(["run"]), "run");
  assert.equal(parseSubcommand(["run-api"]), null);
  assert.equal(parseSubcommand([]), null);
  assert.equal(parseSubcommand(["anything-else"]), null);
});

test("buildAssetExportDocument wraps the canonical rendered brief with the job id and the exact import command", () => {
  const spec = buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image" });
  const document = buildAssetExportDocument({ id: "asset-job-1" }, spec);

  assert.match(document, /job asset-job-1/);
  assert.match(document, /Launch-ready Brownies content/);
  assert.match(document, /run\.ts import --job-id asset-job-1 --file <path-to-image> --workspace/);
});

test("runExportCommand reads a queued external job without claiming or mutating it", async () => {
  const store = makeClient();
  const outcome = await runExportCommand(store.client, "asset-job-1");

  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.document ?? "", /job asset-job-1/);
  assert.equal(store.events.length, 0);
  assert.equal(store.jobs[0].status, "queued");
  assert.equal(store.jobs[0].attempt_count, 0);
});

test("runExportCommand refuses a job that is not queued, and still does not mutate it", async () => {
  const store = makeClient({ jobs: [assetJobRow({ status: "running" })] });
  const outcome = await runExportCommand(store.client, "asset-job-1");

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message ?? "", /is not queued/);
  assert.equal(store.events.length, 0);
});

test("runExportCommand refuses a mock-worker job -- export is for external jobs only", async () => {
  const store = makeClient({ jobs: [assetJobRow({ worker_type: "mock" })] });
  const outcome = await runExportCommand(store.client, "asset-job-1");

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message ?? "", /not external/);
});

test("runExportCommand reports a missing Creative Package without claiming the job", async () => {
  const store = makeClient({ creativePackages: [] });
  const outcome = await runExportCommand(store.client, "asset-job-1");

  assert.equal(outcome.exitCode, 1);
  assert.equal(store.events.length, 0);
  assert.equal(store.jobs[0].status, "queued");
});

test("runImportCommand rejects invalid bytes before claiming the job -- failure costs nothing", async () => {
  const store = makeClient();
  const outcome = await runImportCommand(store.client, "asset-job-1", new Uint8Array([1, 2, 3]), "chatgpt");

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message ?? "", /invalid/i);
  assert.match(outcome.message ?? "", /NOT claimed/);
  assert.equal(store.events.length, 0);
  assert.equal(store.jobs[0].status, "queued");
});

test("runImportCommand completes an external job end to end from real, already-inspected bytes", async () => {
  const store = makeClient();
  const outcome = await runImportCommand(store.client, "asset-job-1", png1080, "chatgpt", "ai_generated");

  assert.equal(outcome.exitCode, 0);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.events[0], "claim-job");
  assert.equal(store.events.some((event) => event.startsWith("upload:")), true);
  assert.equal(store.events.includes("complete-job-with-files"), true);
  assert.equal(store.attempts[0].status, "completed");
});

test("runImportCommand works with sourceKind omitted -- it is optional, never guessed", async () => {
  const store = makeClient();
  const outcome = await runImportCommand(store.client, "asset-job-1", png1080, "camera");

  assert.equal(outcome.exitCode, 0);
  assert.equal(store.jobs[0].status, "completed");
});

// --- attempt finalization must never fail silently (P2-2) --------------------------------------------
//
// static_renderer is used throughout: it is deterministic, needs no credentials, and makes no network
// call, so these tests exercise the CLI's success/failure contract without touching a provider.

function v2TemplateOnlyPackageRow(): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format: "photo",
      subject: "Brownies",
      angle: "Fresh batch",
      hook: "Still warm.",
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am.",
      cta: "Order today",
      visualDirection: "Overhead on the wooden board, morning light",
      overlayText: null,
      productionSource: "template_only",
      visualBrief: {
        concept: "A neat tray of brownies on a wooden board",
        style: "Warm hand-drawn editorial bakery illustration",
        scene: ["Board centred", "Clean separated slices"],
        executionNotes: ["No readable text", "No photoreal product documentation"],
      },
      platformVariants: [{ platform: "instagram", caption: "Still warm.", hashtags: ["#brownies"] }],
      metadata: {
        generatedFromOpportunity: null,
        generatorVersion: "2",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v2",
        formatChosenBy: "ai",
        formatRationale: "A single hero shot suits one product.",
        subjectSource: "stated",
        subjectGrounding: null,
      },
    },
    created_at: "2026-08-05T09:05:00.000Z",
    updated_at: "2026-08-05T09:05:00.000Z",
  } as CreativePackageRow;
}

test("runProductionWorkerCommand exits 0 and reports the asset when everything succeeds", async () => {
  const store = makeClient({
    creativePackages: [v2TemplateOnlyPackageRow()],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
  });

  const outcome = await runProductionWorkerCommand(store.client, "asset-job-1", "static_renderer");

  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.message ?? "", /completed/);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.attempts[0].status, "completed");
  assert.ok(store.events.includes("finish-attempt"));
});

test("a completed asset with FAILED attempt bookkeeping is an operational failure, never silently green", async () => {
  const store = makeClient({
    creativePackages: [v2TemplateOnlyPackageRow()],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
    // The exact shape of "the provenance migration has not been applied yet".
    finishAttemptError: { code: "PGRST202", message: "Could not find the function public.finish_asset_job_attempt_with_provenance in the schema cache" },
  });

  const outcome = await runProductionWorkerCommand(store.client, "asset-job-1", "static_renderer");

  // NOT zero. This is the entire point: the old code returned 0 here.
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.exitCode, ATTEMPT_BOOKKEEPING_EXIT_CODE);

  // The operator must be able to tell, from the message alone, what happened and what to do.
  const message = outcome.message ?? "";
  assert.match(message, /attempt bookkeeping FAILED/i);
  assert.match(message, /do NOT re-run/i);
  assert.match(message, /still status='running'/i);
  assert.match(message, /supabase-add-asset-job-attempt-provenance\.sql/);
  assert.match(message, /Could not find the function/, "the underlying database error must be surfaced, not swallowed");

  // The asset and the job are NOT falsified to hide the bookkeeping problem.
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.events.includes("fail-job"), false);
  assert.equal(store.attempts[0].status, "running", "the attempt really is left running -- that is the condition being reported");

  // And nothing was retried.
  assert.equal(store.events.filter((event) => event === "finish-attempt-error").length, 1);
});

test("the bookkeeping failure exit code is distinct from a real job failure", async () => {
  // Different failures, different operator responses -- so they must not share an exit code.
  const bookkeeping = makeClient({
    creativePackages: [v2TemplateOnlyPackageRow()],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
    finishAttemptError: { message: "attempt write failed" },
  });
  const bookkeepingOutcome = await runProductionWorkerCommand(bookkeeping.client, "asset-job-1", "static_renderer");

  // A job that never completed at all: no such job to claim.
  const jobFailure = makeClient({ creativePackages: [v2TemplateOnlyPackageRow()], jobs: [] });
  const jobFailureOutcome = await runProductionWorkerCommand(jobFailure.client, "asset-job-1", "static_renderer");

  assert.equal(bookkeepingOutcome.exitCode, ATTEMPT_BOOKKEEPING_EXIT_CODE);
  assert.equal(jobFailureOutcome.exitCode, 1);
  assert.notEqual(bookkeepingOutcome.exitCode, jobFailureOutcome.exitCode);
  assert.match(jobFailureOutcome.message ?? "", /did not complete/);
  assert.doesNotMatch(jobFailureOutcome.message ?? "", /do NOT re-run/i, "a job that produced nothing is safe to re-run");
});

test("the bookkeeping check never fires when finalization succeeded", async () => {
  const store = makeClient({
    creativePackages: [v2TemplateOnlyPackageRow()],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
  });

  const outcome = await runProductionWorkerCommand(store.client, "asset-job-1", "static_renderer");

  assert.equal(outcome.exitCode, 0);
  assert.doesNotMatch(outcome.message ?? "", /bookkeeping/i);
  assert.doesNotMatch(outcome.message ?? "", /do NOT re-run/i);
});

test("static_renderer needs no Cloudflare credentials and records no provenance", async () => {
  const store = makeClient({
    creativePackages: [v2TemplateOnlyPackageRow()],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
  });

  const outcome = await runProductionWorkerCommand(store.client, "asset-job-1", "static_renderer");

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.provenance, undefined, "a deterministic local render contacted no provider");
  assert.equal(store.attempts[0].provider, null);
  assert.equal(store.attempts[0].model, null);
});
