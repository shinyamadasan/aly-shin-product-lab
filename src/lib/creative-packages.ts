import {
  fromCreativeJobRow,
  isCreativeJobResultEnvelope,
  isCreativeJobWorkerType,
  runMockCreativeJob,
  type CreativeJobClient,
  type CreativeJobRecord,
  type CreativeJobRow,
  type CreativeJobRunnerResult,
  type CreativeJobWorkerType,
} from "./creative-jobs.ts";
import type { CreativeJobAttemptClient } from "./creative-job-attempts.ts";

export const CREATIVE_PACKAGE_STATUSES = ["ready"] as const;
export type CreativePackageStatus = (typeof CREATIVE_PACKAGE_STATUSES)[number];

export const CREATIVE_PACKAGE_SCHEMA_VERSIONS = ["v1"] as const;
export type CreativePackageSchemaVersion = (typeof CREATIVE_PACKAGE_SCHEMA_VERSIONS)[number];

export type CreativePackageContentV1 = {
  output: {
    headline: string;
    caption: string;
  };
  metadata: {
    generatedFromOpportunity: string;
    generatorVersion: "1";
    sourceCreativeJobId: string;
    sourceWorker: CreativeJobWorkerType;
    sourceJobResultSchemaVersion: "v1";
  };
  artifacts: unknown[];
};

export type CreativePackageRow = {
  id?: string;
  creative_job_id: string;
  status: CreativePackageStatus;
  schema_version: CreativePackageSchemaVersion;
  content: CreativePackageContentV1 | Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type CreativePackageRecord = {
  id: string;
  creativeJobId: string;
  status: CreativePackageStatus;
  schemaVersion: CreativePackageSchemaVersion;
  content: CreativePackageContentV1 | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

type QueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  eq(column: string, value: string): QueryBuilder<T>;
  maybeSingle(): QueryResult<T>;
  select(columns: string): {
    maybeSingle(): QueryResult<T>;
    single(): QueryResult<T>;
  };
};

export type CreativePackageClient = {
  from(table: "creative_packages"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
    insert(row: Partial<CreativePackageRow>): {
      select(columns: string): {
        single(): QueryResult<CreativePackageRow>;
      };
    };
  };
  from(table: "creative_jobs"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
  };
};

// Includes CreativeJobAttemptClient because runMockCreativeJob (called below) now also finishes
// the attempt row its atomic claim created -- this type has always meant "everything needed to
// run a job and materialize its package," and that now includes attempt-finishing.
export type CreativePackageRunnerClient = CreativePackageClient & CreativeJobClient & CreativeJobAttemptClient;

export type CreativePackageDetailResult =
  | { ok: true; creativePackage: CreativePackageRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type CreativePackageCreateResult =
  | { ok: true; outcome: "created" | "existing"; creativePackage: CreativePackageRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "invalid-job-status" | "unsupported-result" | "failed"; message: string; job?: CreativeJobRecord };

type CreativeJobRunnerFailure = Extract<CreativeJobRunnerResult, { ok: false }>;
type CreativePackageCreateFailure = Extract<CreativePackageCreateResult, { ok: false }>;

export type CreativePackageMaterializedRunResult =
  | { ok: true; job: CreativeJobRecord; packageOutcome: "created" | "existing"; creativePackage: CreativePackageRecord }
  | { ok: false; reason: CreativeJobRunnerFailure["reason"] | CreativePackageCreateFailure["reason"]; message: string; job?: CreativeJobRecord };

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function isUniqueViolationError(error: SupabaseErrorLike): boolean {
  return error.code === "23505" || /duplicate key value violates unique constraint/i.test(error.message);
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Creative Packages are not available yet. Verify supabase-add-creative-packages.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isCreativePackageStatus(value: string): value is CreativePackageStatus {
  return CREATIVE_PACKAGE_STATUSES.includes(value as CreativePackageStatus);
}

export function isCreativePackageContentV1(value: unknown): value is CreativePackageContentV1 {
  if (!isJsonObject(value)) {
    return false;
  }

  const output = value.output;
  const metadata = value.metadata;

  return (
    isJsonObject(output) &&
    typeof output.headline === "string" &&
    output.headline.trim().length > 0 &&
    typeof output.caption === "string" &&
    output.caption.trim().length > 0 &&
    isJsonObject(metadata) &&
    typeof metadata.generatedFromOpportunity === "string" &&
    metadata.generatedFromOpportunity.trim().length > 0 &&
    metadata.generatorVersion === "1" &&
    typeof metadata.sourceCreativeJobId === "string" &&
    metadata.sourceCreativeJobId.trim().length > 0 &&
    typeof metadata.sourceWorker === "string" &&
    isCreativeJobWorkerType(metadata.sourceWorker) &&
    metadata.sourceJobResultSchemaVersion === "v1" &&
    Array.isArray(value.artifacts)
  );
}

function parseCreativePackageStatus(value: string): CreativePackageStatus {
  return isCreativePackageStatus(value) ? value : "ready";
}

function parseCreativePackageSchemaVersion(value: string): CreativePackageSchemaVersion {
  return value === "v1" ? "v1" : "v1";
}

export function fromCreativePackageRow(row: CreativePackageRow): CreativePackageRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Creative Package row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    creativeJobId: row.creative_job_id,
    status: parseCreativePackageStatus(row.status),
    schemaVersion: parseCreativePackageSchemaVersion(row.schema_version),
    content: isJsonObject(row.content) ? row.content : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readCreativeJob(client: CreativePackageClient, creativeJobId: string) {
  const result = await client.from("creative_jobs").select<CreativeJobRow>("*").eq("id", creativeJobId).maybeSingle();
  if (result.error) {
    return { ok: false as const, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false as const, reason: "not-found" as const, message: "Creative Job not found." };
  }

  try {
    return { ok: true as const, job: fromCreativeJobRow(result.data) };
  } catch (err) {
    return { ok: false as const, reason: "failed" as const, message: err instanceof Error ? err.message : String(err) };
  }
}

export function buildCreativePackageContentFromCompletedJob(job: CreativeJobRecord): CreativePackageContentV1 {
  if (job.status !== "completed") {
    throw new Error(`Creative Packages can only be materialized from completed Creative Jobs. Current status: ${job.status}.`);
  }

  if (!isCreativeJobResultEnvelope(job.result)) {
    throw new Error("Creative Job result is not a supported v1 package source.");
  }

  return {
    output: {
      headline: job.result.output.headline,
      caption: job.result.output.caption,
    },
    metadata: {
      generatedFromOpportunity: job.result.metadata.generatedFromOpportunity,
      generatorVersion: job.result.metadata.generatorVersion,
      sourceCreativeJobId: job.id,
      sourceWorker: job.result.worker,
      sourceJobResultSchemaVersion: job.result.schemaVersion,
    },
    artifacts: [],
  };
}

export async function getCreativePackageById(client: CreativePackageClient, id: string): Promise<CreativePackageDetailResult> {
  const result = await client.from("creative_packages").select<CreativePackageRow>("*").eq("id", id).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "Creative Package not found." };
  }

  try {
    return { ok: true, creativePackage: fromCreativePackageRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getCreativePackageForJob(client: CreativePackageClient, creativeJobId: string): Promise<CreativePackageDetailResult> {
  const result = await client.from("creative_packages").select<CreativePackageRow>("*").eq("creative_job_id", creativeJobId).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "No Creative Package has been materialized yet." };
  }

  try {
    return { ok: true, creativePackage: fromCreativePackageRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function createCreativePackageFromCompletedJob(client: CreativePackageClient, creativeJobId: string): Promise<CreativePackageCreateResult> {
  const jobResult = await readCreativeJob(client, creativeJobId);
  if (!jobResult.ok) {
    return { ok: false, reason: jobResult.reason, message: jobResult.message };
  }

  if (jobResult.job.status !== "completed") {
    return {
      ok: false,
      reason: "invalid-job-status",
      message: `Creative Packages can only be materialized from completed Creative Jobs. Current status: ${jobResult.job.status}.`,
      job: jobResult.job,
    };
  }

  if (!isCreativeJobResultEnvelope(jobResult.job.result)) {
    return {
      ok: false,
      reason: "unsupported-result",
      message: "Creative Job result is not a supported v1 package source.",
      job: jobResult.job,
    };
  }

  const existing = await getCreativePackageForJob(client, creativeJobId);
  if (existing.ok) {
    return { ok: true, outcome: "existing", creativePackage: existing.creativePackage };
  }
  if (existing.reason !== "not-found") {
    return { ok: false, reason: existing.reason, message: existing.message, job: jobResult.job };
  }

  const content = buildCreativePackageContentFromCompletedJob(jobResult.job);
  const inserted = await client
    .from("creative_packages")
    .insert({ creative_job_id: creativeJobId, status: "ready", schema_version: "v1", content })
    .select("*")
    .single();

  if (!inserted.error && inserted.data) {
    return { ok: true, outcome: "created", creativePackage: fromCreativePackageRow(inserted.data) };
  }

  if (inserted.error && isUniqueViolationError(inserted.error)) {
    const reread = await getCreativePackageForJob(client, creativeJobId);
    if (reread.ok) {
      return { ok: true, outcome: "existing", creativePackage: reread.creativePackage };
    }
    return { ok: false, reason: reread.reason, message: reread.message, job: jobResult.job };
  }

  return { ok: false, ...dbErrorResult(inserted.error ?? { message: "Creative Package insert returned no row." }), job: jobResult.job };
}

export async function runMockCreativeJobAndMaterializePackage(
  client: CreativePackageRunnerClient,
  creativeJobId: string,
  options: { now?: () => string } = {},
): Promise<CreativePackageMaterializedRunResult> {
  const jobResult = await runMockCreativeJob(client, creativeJobId, options);
  if (!jobResult.ok) {
    return { ok: false, reason: jobResult.reason, message: jobResult.message, job: jobResult.job };
  }

  const packageResult = await createCreativePackageFromCompletedJob(client, jobResult.job.id);
  if (!packageResult.ok) {
    return { ok: false, reason: packageResult.reason, message: packageResult.message, job: jobResult.job };
  }

  return {
    ok: true,
    job: jobResult.job,
    packageOutcome: packageResult.outcome,
    creativePackage: packageResult.creativePackage,
  };
}
