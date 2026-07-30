import {
  buildMockCreativeJobResult,
  runCreativeJobWithExecutors,
  type CreativeJobExecutorMap,
  type CreativeJobResultEnvelope,
} from "../../src/lib/creative-jobs.ts";
import {
  createCreativePackageFromCompletedJob,
  type CreativePackageMaterializedRunResult,
  type CreativePackageRunnerClient,
} from "../../src/lib/creative-packages.ts";
import type { OpportunityRecord } from "../../src/lib/opportunities.ts";

export function buildProductTextWorkerReadinessResult(opportunity: OpportunityRecord): CreativeJobResultEnvelope {
  return {
    schemaVersion: "v1",
    worker: "product_text_worker",
    output: {
      headline: `NON-AI TEST - ${opportunity.title}`,
      caption: `NON-AI TEST - ${opportunity.summary || opportunity.reason}`,
    },
    metadata: {
      generatedFromOpportunity: opportunity.id,
      generatorVersion: "1",
    },
    artifacts: [],
  };
}

export function trustedCreativeJobExecutors(): CreativeJobExecutorMap {
  return {
    mock: (_job, opportunity) => buildMockCreativeJobResult(opportunity),
    product_text_worker: (_job, opportunity) => buildProductTextWorkerReadinessResult(opportunity),
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
