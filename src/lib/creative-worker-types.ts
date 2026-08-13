// The Creative Job worker vocabulary, extracted verbatim from creative-jobs.ts in S3E-A1 and
// re-exported from there unchanged, so every existing importer and every existing value stays
// exactly as it was.
//
// The move exists for one reason only: the v2 Creative Job result envelope carries validated
// CreativePackageContentV2, so creative-jobs.ts has to be able to run the v2 content validator at
// runtime. That validator checks metadata.sourceWorker against this list, so leaving the list in
// creative-jobs.ts would close a runtime import cycle (creative-jobs -> v2 content -> creative-jobs).
// Same reasoning, and same shape of fix, as the S3B extraction of ./creative-formats.ts.
//
// `creative_ai` is added by S3E-A2, the slice that actually builds the executor behind it -- it was
// deliberately absent in S3E-A1 because listing a worker with nothing behind it would be a promise,
// not a fact.
//
// No SQL migration accompanies it: creative_jobs.worker_type and creative_job_attempts.worker_type
// are plain `text` with no CHECK constraint and no enum (worker validity is application-owned by
// design -- see supabase-add-creative-job-attempts.sql's "keeps status app-validated" note), so
// this list is the only place a worker type is declared.

export const CREATIVE_JOB_WORKER_TYPES = ["mock", "product_text_worker", "opportunity_brief", "creative_ai"] as const;
export type CreativeJobWorkerType = (typeof CREATIVE_JOB_WORKER_TYPES)[number];

export function isCreativeJobWorkerType(value: string): value is CreativeJobWorkerType {
  return CREATIVE_JOB_WORKER_TYPES.includes(value as CreativeJobWorkerType);
}
