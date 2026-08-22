import { createHash } from "node:crypto";

import type { AssetJobExecutionClient, AssetJobRow } from "../../src/lib/asset-jobs.ts";

// Production MVP Wave C2A -- a CONTROLLED, in-process Asset Job store.
//
// WHAT IT IS FOR, precisely: proving the real worker process end to end -- queued, claimed, rendered,
// probed, validated, materialized, completed -- on this Windows workstation, WITHOUT touching live
// Supabase, without applying the video storage migration, and without uploading an MP4 to the live
// generated-assets bucket. C2A is explicitly forbidden from doing any of those, and C2B owns them.
//
// WHAT IT IS NOT: a second queue. It implements the SAME AssetJobExecutionClient interface the real
// Supabase client satisfies, and it reproduces the semantics of the three RPCs rather than inventing
// easier ones:
//
//   claim_asset_job_with_attempt   single atomic transition, guarded by status='queued'
//   finish_asset_job               guarded by status='running' and outcome in (completed, failed)
//   finish_asset_job_attempt       guarded by attempt status='running'
//
// Reproducing the GUARDS is the point. A permissive fake would let the worker pass here and fail
// against the real database, which is the specific way an integration proof becomes worthless. The
// same discipline the existing test fake in tests/asset-jobs.test.ts already applies.
//
// It lives under scripts/ rather than src/ because nothing shipped may import it, and beside the
// worker CLI because that is its only caller.

export type InMemoryStoreOptions = {
  creativePackageId?: string;
  now?: () => string;
};

export type InMemoryStore = {
  client: AssetJobExecutionClient;
  jobs: AssetJobRow[];
  attempts: Array<Record<string, unknown>>;
  uploadedObjects: Map<string, Uint8Array>;
  events: string[];
  seedJob(row: Partial<AssetJobRow> & { id: string }): AssetJobRow;
  seedCreativePackage(content: unknown): string;
};

export function createInMemoryAssetJobStore(options: InMemoryStoreOptions = {}): InMemoryStore {
  const now = options.now ?? (() => new Date().toISOString());
  const jobs: AssetJobRow[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  const creativePackages: Array<Record<string, unknown>> = [];
  const uploadedObjects = new Map<string, Uint8Array>();
  const assets: Array<Record<string, unknown>> = [];
  const events: string[] = [];

  function seedCreativePackage(content: unknown): string {
    const id = `pkg-${creativePackages.length + 1}`;
    creativePackages.push({ id, status: "ready", content, created_at: now(), updated_at: now() });
    return id;
  }

  function seedJob(row: Partial<AssetJobRow> & { id: string }): AssetJobRow {
    const job: AssetJobRow = {
      creative_package_id: row.creative_package_id ?? options.creativePackageId ?? "pkg-1",
      status: "queued",
      worker_type: "remotion",
      asset_kind: "short_video",
      attempt_count: 0,
      result: {},
      last_error: null,
      created_at: now(),
      updated_at: now(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      ...row,
    };
    jobs.push(job);
    return job;
  }

  // A minimal PostgREST-shaped query builder: enough for the reads asset-jobs.ts actually performs
  // (select -> eq -> order -> limit -> maybeSingle / await), and deliberately no more.
  function queryBuilder(rows: Array<Record<string, unknown>>) {
    let filtered = [...rows];
    const builder = {
      eq(column: string, value: string) {
        filtered = filtered.filter((row) => row[column] === value);
        return builder;
      },
      order() {
        return builder;
      },
      limit(count: number) {
        filtered = filtered.slice(0, count);
        return builder;
      },
      async maybeSingle() {
        return { data: filtered[0] ?? null, error: null };
      },
      then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: filtered, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "creative_packages") {
        return { select: () => queryBuilder(creativePackages) };
      }
      if (table === "asset_jobs") {
        return { select: () => queryBuilder(jobs as unknown as Array<Record<string, unknown>>) };
      }
      return { select: () => queryBuilder([]) };
    },

    rpc(functionName: string, args: Record<string, unknown>) {
      return {
        async maybeSingle() {
          events.push(functionName);

          if (functionName === "claim_asset_job_with_attempt") {
            // `status = 'queued'` is the whole guard, exactly as the SQL has it. A second claim of
            // the same job matches zero rows and returns null, which is how the real function
            // reports "somebody else already has it".
            const index = jobs.findIndex((row) => row.id === args.p_job_id && row.status === "queued");
            if (index === -1) {
              return { data: null, error: null };
            }
            const startedAt = now();
            jobs[index] = { ...jobs[index], status: "running", started_at: startedAt, attempt_count: jobs[index].attempt_count + 1, updated_at: startedAt };
            const attempt = {
              id: `attempt-${attempts.length + 1}`,
              asset_job_id: jobs[index].id,
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
              created_at: startedAt,
            };
            attempts.push(attempt);
            return { data: { ...jobs[index], attempt_id: attempt.id, attempt_number: attempt.attempt_number }, error: null };
          }

          if (functionName === "finish_asset_job") {
            const outcome = args.p_outcome as string;
            const index = jobs.findIndex((row) => row.id === args.p_job_id && row.status === "running");
            if (index === -1 || (outcome !== "completed" && outcome !== "failed")) {
              return { data: null, error: null };
            }
            const finishedAt = now();
            jobs[index] = {
              ...jobs[index],
              status: outcome as AssetJobRow["status"],
              result: outcome === "completed" ? (args.p_result as AssetJobRow["result"]) : jobs[index].result,
              last_error: outcome === "failed" ? (args.p_last_error as string | null) : null,
              completed_at: outcome === "completed" ? finishedAt : null,
              failed_at: outcome === "failed" ? finishedAt : null,
              updated_at: finishedAt,
            };
            return { data: jobs[index], error: null };
          }

          if (functionName === "complete_asset_job_with_files") {
            const index = jobs.findIndex((row) => row.id === args.p_asset_job_id && row.status === "running");
            if (index === -1) {
              return { data: null, error: null };
            }
            const finishedAt = now();
            jobs[index] = { ...jobs[index], status: "completed", result: args.p_result as AssetJobRow["result"], last_error: null, completed_at: finishedAt, updated_at: finishedAt };
            const asset = {
              id: `asset-${assets.length + 1}`,
              asset_job_id: jobs[index].id,
              status: "generated",
              asset_kind: jobs[index].asset_kind,
              schema_version: "v1",
              content: { metadata: { generatedFromCreativePackage: jobs[index].creative_package_id, sourceAssetJobId: jobs[index].id, generatorVersion: "1" } },
              created_at: finishedAt,
              updated_at: finishedAt,
            };
            assets.push(asset);
            const files = (args.p_files as Array<Record<string, unknown>>).map((file, position) => ({
              id: `file-${position + 1}`,
              asset_id: asset.id,
              position: Number(file.position),
              storage_bucket: String(file.storage_bucket),
              storage_path: String(file.storage_path),
              public_url: String(file.public_url ?? ""),
              mime_type: String(file.mime_type),
              file_size_bytes: Number(file.file_size_bytes),
              width: file.width === null ? null : Number(file.width),
              height: file.height === null ? null : Number(file.height),
              // Carried through rather than nulled: Wave C2A's whole point on this axis is that a
              // video's duration survives to the persisted AssetFile row.
              duration_ms: file.duration_ms === null || file.duration_ms === undefined ? null : Number(file.duration_ms),
              checksum_sha256: file.checksum_sha256 === null ? null : String(file.checksum_sha256),
              created_at: finishedAt,
            }));
            return { data: { job: jobs[index], asset, files }, error: null };
          }

          // Both attempt-finishing RPCs.
          const index = attempts.findIndex((row) => row.id === args.p_attempt_id && row.status === "running");
          const outcome = args.p_outcome as string;
          if (index === -1 || !["completed", "failed", "timed_out"].includes(outcome)) {
            return { data: null, error: null };
          }
          const carriesProvenance = functionName === "finish_asset_job_attempt_with_provenance";
          attempts[index] = {
            ...attempts[index],
            status: outcome,
            completed_at: now(),
            error_code: outcome === "completed" ? null : (args.p_error_code ?? null),
            error_message: outcome === "completed" ? null : (args.p_error_message ?? null),
            provider: carriesProvenance ? ((args.p_provider as string | null) ?? attempts[index].provider ?? null) : attempts[index].provider,
            model: carriesProvenance ? ((args.p_model as string | null) ?? attempts[index].model ?? null) : attempts[index].model,
          };
          return { data: attempts[index], error: null };
        },
      };
    },

    // A local stand-in for Supabase Storage. Nothing here reaches the network, and NOTHING here is
    // the live generated-assets bucket -- which is the specific thing C2A must not touch.
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: Uint8Array) {
            events.push(`upload:${bucket}:${path}`);
            if (uploadedObjects.has(path)) {
              return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            }
            uploadedObjects.set(path, body);
            return { data: { path }, error: null };
          },
          async download(path: string) {
            const data = uploadedObjects.get(path);
            return data ? { data, error: null } : { data: null, error: { message: "not found" } };
          },
          async remove(paths: string[]) {
            for (const path of paths) {
              uploadedObjects.delete(path);
            }
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as AssetJobExecutionClient;

  return { client, jobs, attempts, uploadedObjects, events, seedJob, seedCreativePackage };
}

// A stable, readable job id for the proof run. Derived from a label rather than random so a proof can
// be re-run and referred to by the same id in a report.
export function proofJobId(label: string): string {
  return `proof-${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}
