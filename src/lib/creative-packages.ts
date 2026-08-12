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
import { isCreativeFormat, isCreativePlatform, type CreativePlatform } from "./creative-formats.ts";

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

// Carries the same provenance v1 does, plus the two decisions a generator makes that would be
// unreconstructable afterwards: which format it picked and why, and whether the subject was stated
// by the source or assumed by the system. S2 defines these structurally; S3 populates them.
export type CreativePackageMetadataV2 = {
  // Null for a request-backed job, exactly as in v1 since S1. A v2 package produced from a manual
  // Creative Job is structurally legitimate -- Opportunity is not mandatory anywhere in v2.
  generatedFromOpportunity: string | null;
  generatorVersion: "2";
  sourceCreativeJobId: string;
  sourceWorker: CreativeJobWorkerType;
  sourceJobResultSchemaVersion: "v2";
  formatChosenBy: "ai" | "user";
  formatRationale: string;
  subjectSource: "stated" | "assumed";
  // Required to be non-empty when subjectSource is "assumed": an assumption presented without its
  // grounding is indistinguishable from a fact, which is the failure this field exists to prevent.
  subjectGrounding: string | null;
};

export const CREATIVE_FORMAT_CHOSEN_BY = ["ai", "user"] as const;
export const CREATIVE_SUBJECT_SOURCES = ["stated", "assumed"] as const;

// A small adaptation of one canonical creative, never a separate creative. Caption and hashtags
// only -- a per-platform hook or CTA would be fake differentiation, since the hook IS the idea and
// does not change because the app changed. No scheduling, publishing or platform post identifiers.
export type PlatformVariantV2 = {
  platform: CreativePlatform;
  caption: string;
  hashtags: string[];
};

type CreativePackageBaseV2 = {
  schemaVersion: "v2";
  subject: string;
  angle: string;
  hook: string;
  // Retained from v1 deliberately, even though `subject` and `hook` overlap it: the asset-generation
  // path reads headline directly, and keeping it is what lets a v2 package feed the existing Asset
  // Job pipeline without inventing a second media-generation system. See asset-generation-spec.ts.
  headline: string;
  caption: string;
  cta: string;
  platformVariants: PlatformVariantV2[];
  metadata: CreativePackageMetadataV2;
};

export type CreativePhotoPackageV2 = CreativePackageBaseV2 & {
  format: "photo";
  visualDirection: string;
  overlayText: string | null;
};

export type CreativeReelPackageV2 = CreativePackageBaseV2 & {
  format: "reel";
  shots: Array<{ direction: string; onScreenText: string | null }>;
  // Nullable because a visual-only Reel is the normal case for a bakery, not an exception.
  // Requiring speech would produce ignored filler on most Reels.
  spokenScript: string | null;
  audioDirection: string;
  targetDurationSeconds: number;
};

export type CreativeCarouselPackageV2 = CreativePackageBaseV2 & {
  format: "carousel";
  slides: Array<{ heading: string; body: string; visualDirection: string }>;
};

export type CreativeStoryPackageV2 = CreativePackageBaseV2 & {
  format: "story";
  frames: Array<{ visualDirection: string; text: string }>;
  interaction: string | null;
};

export type CreativePackageContentV2 =
  | CreativePhotoPackageV2
  | CreativeReelPackageV2
  | CreativeCarouselPackageV2
  | CreativeStoryPackageV2;

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

// --- v2 validation ------------------------------------------------------------------------------
//
// Mirrors validateCreativeJobResultEnvelope's shape (ok/reason/message) rather than introducing a
// second validation style. Reasons are coarse enough to act on and specific enough to debug.
export type CreativePackageContentV2Validation =
  | { ok: true; content: CreativePackageContentV2 }
  | { ok: false; reason: "unsupported-schema-version" | "unsupported-format" | "malformed-base" | "malformed-metadata" | "malformed-platform-variants" | "malformed-format-fields"; message: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validatePlatformVariants(value: unknown): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "Creative Package v2 platformVariants must be an array." };
  }
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return { ok: false, message: "Creative Package v2 platformVariants entries must be objects." };
    }
    if (!isCreativePlatform(entry.platform)) {
      return { ok: false, message: `Creative Package v2 platformVariants has an unsupported platform: ${String(entry.platform)}.` };
    }
    if (!isNonEmptyString(entry.caption)) {
      return { ok: false, message: "Creative Package v2 platformVariants entries require a non-empty caption." };
    }
    if (!Array.isArray(entry.hashtags) || entry.hashtags.some((tag) => typeof tag !== "string")) {
      return { ok: false, message: "Creative Package v2 platformVariants hashtags must be an array of strings." };
    }
  }
  return { ok: true };
}

function validateMetadataV2(value: unknown): { ok: true } | { ok: false; message: string } {
  if (!isJsonObject(value)) {
    return { ok: false, message: "Creative Package v2 metadata must be an object." };
  }
  // Same rule as v1: a non-empty id, or explicitly null. Empty/whitespace is never an absence.
  if (!(value.generatedFromOpportunity === null || isNonEmptyString(value.generatedFromOpportunity))) {
    return { ok: false, message: "Creative Package v2 metadata generatedFromOpportunity must be a non-empty id or null." };
  }
  if (value.generatorVersion !== "2") {
    return { ok: false, message: "Creative Package v2 metadata generatorVersion must be \"2\"." };
  }
  if (!isNonEmptyString(value.sourceCreativeJobId)) {
    return { ok: false, message: "Creative Package v2 metadata requires a non-empty sourceCreativeJobId." };
  }
  if (typeof value.sourceWorker !== "string" || !isCreativeJobWorkerType(value.sourceWorker)) {
    return { ok: false, message: "Creative Package v2 metadata sourceWorker is not a supported worker type." };
  }
  if (value.sourceJobResultSchemaVersion !== "v2") {
    return { ok: false, message: "Creative Package v2 metadata sourceJobResultSchemaVersion must be v2." };
  }
  if (!(CREATIVE_FORMAT_CHOSEN_BY as readonly unknown[]).includes(value.formatChosenBy)) {
    return { ok: false, message: "Creative Package v2 metadata formatChosenBy must be \"ai\" or \"user\"." };
  }
  if (!isNonEmptyString(value.formatRationale)) {
    return { ok: false, message: "Creative Package v2 metadata requires a non-empty formatRationale." };
  }
  if (!(CREATIVE_SUBJECT_SOURCES as readonly unknown[]).includes(value.subjectSource)) {
    return { ok: false, message: "Creative Package v2 metadata subjectSource must be \"stated\" or \"assumed\"." };
  }
  if (!isNullableString(value.subjectGrounding)) {
    return { ok: false, message: "Creative Package v2 metadata subjectGrounding must be a string or null." };
  }
  // An assumption without its grounding is indistinguishable from a fact.
  if (value.subjectSource === "assumed" && !isNonEmptyString(value.subjectGrounding)) {
    return { ok: false, message: "Creative Package v2 metadata requires a non-empty subjectGrounding when subjectSource is \"assumed\"." };
  }
  return { ok: true };
}

function validateFormatFields(value: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  if (value.format === "photo") {
    if (!isNonEmptyString(value.visualDirection)) {
      return { ok: false, message: "Creative Package v2 photo requires a non-empty visualDirection." };
    }
    if (!isNullableString(value.overlayText)) {
      return { ok: false, message: "Creative Package v2 photo overlayText must be a string or null." };
    }
    return { ok: true };
  }

  if (value.format === "reel") {
    if (!Array.isArray(value.shots) || value.shots.length === 0) {
      return { ok: false, message: "Creative Package v2 reel requires at least one shot." };
    }
    for (const shot of value.shots) {
      if (!isJsonObject(shot) || !isNonEmptyString(shot.direction) || !isNullableString(shot.onScreenText)) {
        return { ok: false, message: "Creative Package v2 reel shots require a non-empty direction and a string-or-null onScreenText." };
      }
    }
    if (!isNullableString(value.spokenScript)) {
      return { ok: false, message: "Creative Package v2 reel spokenScript must be a string or null." };
    }
    if (!isNonEmptyString(value.audioDirection)) {
      return { ok: false, message: "Creative Package v2 reel requires a non-empty audioDirection." };
    }
    if (typeof value.targetDurationSeconds !== "number" || !Number.isFinite(value.targetDurationSeconds) || value.targetDurationSeconds <= 0) {
      return { ok: false, message: "Creative Package v2 reel targetDurationSeconds must be a positive finite number." };
    }
    return { ok: true };
  }

  if (value.format === "carousel") {
    if (!Array.isArray(value.slides) || value.slides.length === 0) {
      return { ok: false, message: "Creative Package v2 carousel requires at least one slide." };
    }
    for (const slide of value.slides) {
      if (!isJsonObject(slide) || !isNonEmptyString(slide.heading) || !isNonEmptyString(slide.body) || !isNonEmptyString(slide.visualDirection)) {
        return { ok: false, message: "Creative Package v2 carousel slides require non-empty heading, body and visualDirection." };
      }
    }
    return { ok: true };
  }

  // story -- the only remaining member, already narrowed by the format check in the caller.
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    return { ok: false, message: "Creative Package v2 story requires at least one frame." };
  }
  for (const frame of value.frames) {
    if (!isJsonObject(frame) || !isNonEmptyString(frame.visualDirection) || !isNonEmptyString(frame.text)) {
      return { ok: false, message: "Creative Package v2 story frames require non-empty visualDirection and text." };
    }
  }
  if (!isNullableString(value.interaction)) {
    return { ok: false, message: "Creative Package v2 story interaction must be a string or null." };
  }
  return { ok: true };
}

export function validateCreativePackageContentV2(value: unknown): CreativePackageContentV2Validation {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Package v2 content must be an object." };
  }
  if (value.schemaVersion !== "v2") {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Package content schemaVersion must be v2." };
  }
  if (!isCreativeFormat(value.format)) {
    return { ok: false, reason: "unsupported-format", message: `Creative Package v2 format is not supported: ${String(value.format)}.` };
  }

  for (const field of ["subject", "angle", "hook", "headline", "caption", "cta"] as const) {
    if (!isNonEmptyString(value[field])) {
      return { ok: false, reason: "malformed-base", message: `Creative Package v2 requires a non-empty ${field}.` };
    }
  }

  const metadata = validateMetadataV2(value.metadata);
  if (!metadata.ok) {
    return { ok: false, reason: "malformed-metadata", message: metadata.message };
  }

  const variants = validatePlatformVariants(value.platformVariants);
  if (!variants.ok) {
    return { ok: false, reason: "malformed-platform-variants", message: variants.message };
  }

  const formatFields = validateFormatFields(value);
  if (!formatFields.ok) {
    return { ok: false, reason: "malformed-format-fields", message: formatFields.message };
  }

  return { ok: true, content: value as unknown as CreativePackageContentV2 };
}

export function isCreativePackageContentV2(value: unknown): value is CreativePackageContentV2 {
  return validateCreativePackageContentV2(value).ok;
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
