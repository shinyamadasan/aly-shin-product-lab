import {
  fromCreativeJobRow,
  isCreativeJobResultEnvelope,
  isCreativeJobResultEnvelopeV2,
  runMockCreativeJob,
  validateCreativeJobResultEnvelopeV2,
  type CreativeJobClient,
  type CreativeJobRecord,
  type CreativeJobRow,
  type CreativeJobRunnerResult,
  type CreativeJobWorkerType,
} from "./creative-jobs.ts";
import { isCreativeJobWorkerType } from "./creative-worker-types.ts";
import type { CreativeJobAttemptClient } from "./creative-job-attempts.ts";
import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "./creative-package-content-v2.ts";

export const CREATIVE_PACKAGE_STATUSES = ["ready"] as const;
export type CreativePackageStatus = (typeof CREATIVE_PACKAGE_STATUSES)[number];

export const CREATIVE_PACKAGE_SCHEMA_VERSIONS = ["v1", "v2"] as const;
export type CreativePackageSchemaVersion = (typeof CREATIVE_PACKAGE_SCHEMA_VERSIONS)[number];

// --- v2 vocabulary (Content Creation MVP S2) ----------------------------------------------------
//
// Moved to the leaf module ./creative-formats.ts in S3B and re-exported here unchanged, so every
// existing importer and the S2 contract stay exactly as they were. The move exists only to let
// CreativeInput validate a human-supplied formatHint without closing a runtime import cycle --
// see creative-formats.ts for the full reasoning.
export {
  CREATIVE_FORMATS,
  CREATIVE_PLATFORMS,
  isCreativeFormat,
  isCreativePlatform,
  type CreativeFormat,
  type CreativePlatform,
} from "./creative-formats.ts";

// Same move, same reasoning, one slice later. The S2 v2 content contract and its authoritative
// validator moved to the leaf module ./creative-package-content-v2.ts in S3E-A1 and are re-exported
// here unchanged, so every existing importer keeps working against this module exactly as before.
// The move exists only so creative-jobs.ts can validate the v2 content carried by a v2 result
// envelope without closing a runtime import cycle -- see creative-package-content-v2.ts.
export {
  CREATIVE_FORMAT_CHOSEN_BY,
  CREATIVE_SUBJECT_SOURCES,
  isCreativePackageContentV2,
  validateCreativePackageContentV2,
  type CreativeCarouselPackageV2,
  type CreativePackageContentV2,
  type CreativePackageContentV2Validation,
  type CreativePackageMetadataV2,
  type CreativePhotoPackageV2,
  type CreativeReelPackageV2,
  type CreativeStoryPackageV2,
  type CreativeVisualBrief,
  type PlatformVariantV2,
} from "./creative-package-content-v2.ts";

export type CreativePackageContentV1 = {
  output: {
    headline: string;
    caption: string;
  };
  metadata: {
    // Nullable as of S1, mirroring CreativeJobResultEnvelope's own metadata: this field is copied
    // verbatim from the job envelope, so it has to be able to represent the same absence. A
    // request-backed job was genuinely not generated from an Opportunity. Widening only -- the
    // output contract and every other field are untouched, and this is NOT the v2 content shape.
    generatedFromOpportunity: string | null;
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
  content: CreativePackageContentV1 | CreativePackageContentV2 | Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type CreativePackageRecord = {
  id: string;
  creativeJobId: string;
  status: CreativePackageStatus;
  schemaVersion: CreativePackageSchemaVersion;
  content: CreativePackageContentV1 | CreativePackageContentV2 | Record<string, unknown>;
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
    // Either a non-empty opportunity id, or explicitly null for a request-backed job. An empty or
    // whitespace-only string is still rejected: absence must be stated, never implied.
    (metadata.generatedFromOpportunity === null ||
      (typeof metadata.generatedFromOpportunity === "string" && metadata.generatedFromOpportunity.trim().length > 0)) &&
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

// Previously collapsed every value to "v1", which would have silently reinterpreted a stored v2
// package as v1 -- exactly the misreading the two-version contract exists to prevent. Unknown
// values still fall back to "v1" (the historical default for rows written before the column meant
// anything), but a genuine "v2" is now carried through.
function parseCreativePackageSchemaVersion(value: string): CreativePackageSchemaVersion {
  return value === "v2" ? "v2" : "v1";
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

// The v2 counterpart of buildCreativePackageContentFromCompletedJob above. Deliberately thin: the
// v2 package content IS the envelope's already-S2-validated `content`, copied through unchanged.
// Nothing is rebuilt from execution metadata, and the envelope's executionTrace is dropped rather
// than merged -- execution history is attempt state (creative_job_attempts.ai_execution_trace), not
// creative content, and a package that carried it would be claiming provider history as authorship.
export function buildCreativePackageContentV2FromCompletedJob(job: CreativeJobRecord): CreativePackageContentV2 {
  if (job.status !== "completed") {
    throw new Error(`Creative Packages can only be materialized from completed Creative Jobs. Current status: ${job.status}.`);
  }

  const envelope = validateCreativeJobResultEnvelopeV2(job.result);
  if (!envelope.ok) {
    throw new Error(`Creative Job result is not a supported v2 package source: ${envelope.message}`);
  }

  // Re-run the authoritative S2 validator on the content itself, even though the envelope validator
  // already ran it. Persistence must not accept malformed v2 content on an upstream caller's word.
  const content = validateCreativePackageContentV2(envelope.result.content);
  if (!content.ok) {
    throw new Error(`Creative Package v2 content failed validation: ${content.message}`);
  }

  // The content states which job produced it. If that disagrees with the job actually being
  // materialized, one of the two is wrong and persisting either would record a false provenance.
  if (content.content.metadata.sourceCreativeJobId !== job.id) {
    throw new Error(
      `Creative Package v2 content names a different source Creative Job (${content.content.metadata.sourceCreativeJobId}) than the one being materialized (${job.id}).`,
    );
  }

  return content.content;
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

  // Version is decided once, here, from the job result's own stated schemaVersion -- never sniffed
  // from content shape and never defaulted. A v1 result produces a v1 package exactly as it always
  // did; a v2 result produces a v2 package; anything else is refused rather than coerced into
  // either. Both land in the same table, through the same insert, under the same unique
  // creative_job_id -- one materialization system, two versions of content.
  const isV1 = isCreativeJobResultEnvelope(jobResult.job.result);
  const isV2 = isCreativeJobResultEnvelopeV2(jobResult.job.result);
  if (!isV1 && !isV2) {
    const v2Detail = validateCreativeJobResultEnvelopeV2(jobResult.job.result);
    return {
      ok: false,
      reason: "unsupported-result",
      message: isJsonObject(jobResult.job.result) && jobResult.job.result.schemaVersion === "v2"
        ? `Creative Job result is not a supported v2 package source: ${v2Detail.ok ? "unknown reason" : v2Detail.message}`
        : "Creative Job result is not a supported v1 package source.",
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

  let schemaVersion: CreativePackageSchemaVersion;
  let content: CreativePackageContentV1 | CreativePackageContentV2;
  try {
    schemaVersion = isV2 ? "v2" : "v1";
    content = isV2 ? buildCreativePackageContentV2FromCompletedJob(jobResult.job) : buildCreativePackageContentFromCompletedJob(jobResult.job);
  } catch (err) {
    return {
      ok: false,
      reason: "unsupported-result",
      message: err instanceof Error ? err.message : String(err),
      job: jobResult.job,
    };
  }

  const inserted = await client
    .from("creative_packages")
    .insert({ creative_job_id: creativeJobId, status: "ready", schema_version: schemaVersion, content })
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
