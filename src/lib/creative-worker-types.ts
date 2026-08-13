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
// No worker type is added here. `creative_ai` belongs to S3E-A2, which is the slice that actually
// builds the executor -- listing a worker with nothing behind it would be a promise, not a fact.

export const CREATIVE_JOB_WORKER_TYPES = ["mock", "product_text_worker", "opportunity_brief"] as const;
export type CreativeJobWorkerType = (typeof CREATIVE_JOB_WORKER_TYPES)[number];

export function isCreativeJobWorkerType(value: string): value is CreativeJobWorkerType {
  return CREATIVE_JOB_WORKER_TYPES.includes(value as CreativeJobWorkerType);
}
