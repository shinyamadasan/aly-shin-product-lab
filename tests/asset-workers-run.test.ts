import test from "node:test";
import assert from "node:assert/strict";

import { buildAssetExportDocument, parseSubcommand, runExportCommand, runImportCommand } from "../scripts/asset-workers/run.ts";
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
function makeClient(options: { creativePackages?: CreativePackageRow[]; jobs?: AssetJobRow[] } = {}) {
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

      assert.equal(functionName, "finish_asset_job_attempt");
      return {
        async maybeSingle() {
          const outcome = args.p_outcome as string;
          const index = attempts.findIndex((row) => row.id === (args.p_attempt_id as string) && row.status === "running");
          if (index === -1) return { data: null, error: null };
          attempts[index] = { ...attempts[index], status: outcome as AssetJobAttemptRow["status"], completed_at: finishedAt, latency_ms: 0, error_code: null, error_message: null };
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

test("parseSubcommand recognizes only export and import -- no run-api, no API provider path exists", () => {
  assert.equal(parseSubcommand(["export"]), "export");
  assert.equal(parseSubcommand(["import"]), "import");
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
