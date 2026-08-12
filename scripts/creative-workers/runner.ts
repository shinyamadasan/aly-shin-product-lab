import {
  buildMockCreativeJobResult,
  buildOpportunityBriefCreativeJobResult,
  runCreativeJobWithExecutors,
  type CreativeJobExecutorMap,
  type CreativeJobResultEnvelope,
} from "../../src/lib/creative-jobs.ts";
import {
  createCreativePackageFromCompletedJob,
  type CreativePackageMaterializedRunResult,
  type CreativePackageRunnerClient,
} from "../../src/lib/creative-packages.ts";
import type { CreativeInput } from "../../src/lib/creative-input.ts";

// Reads from CreativeInput as of S1 (the executor contract changed); the produced envelope is
// otherwise identical, so an Opportunity-backed job still yields the same strings it always did.
export function buildProductTextWorkerReadinessResult(input: CreativeInput): CreativeJobResultEnvelope {
  return {
    schemaVersion: "v1",
    worker: "product_text_worker",
    output: {
      headline: `NON-AI TEST - ${input.subject ?? input.requestText ?? ""}`,
      caption: `NON-AI TEST - ${input.evidenceSummary || input.reason || input.requestText || ""}`,
    },
    metadata: {
      generatedFromOpportunity: input.origin.kind === "opportunity" ? input.origin.opportunityId : null,
      generatorVersion: "1",
    },
    artifacts: [],
  };
}

export function trustedCreativeJobExecutors(): CreativeJobExecutorMap {
  return {
    mock: (_job, input) => buildMockCreativeJobResult(input),
    product_text_worker: (_job, input) => buildProductTextWorkerReadinessResult(input),
    opportunity_brief: (_job, input) => buildOpportunityBriefCreativeJobResult(input),
  };
}

export async function runTrustedCreativeJobAndMaterializePackage(
  client: CreativePackageRunnerClient,
  creativeJobId: string,
  options: { now?: () => string; executors?: CreativeJobExecutorMap } = {},
): Promise<CreativePackageMaterializedRunResult> {
  const jobResult = await runCreativeJobWithExecutors(client, creativeJobId, options.executors ?? trustedCreativeJobExecutors(), options);
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
