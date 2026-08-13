import type { BrandBible } from "../marketing-advisor-context.ts";
import type { CreativeInput } from "../creative-input.ts";
import type { CreativePlatform } from "../creative-formats.ts";
import type { MarketingRecommendation } from "../marketing-recommendations.ts";
import type { ContentJournalEntry, Product } from "../product-lab-types.ts";
import { resolveCreativeGrounding } from "../creative-subject-resolution.ts";
import {
  sanitizeCreativeJobErrorMessage,
  type CreativeJobExecutor,
  type CreativeJobExecutorFailure,
  type CreativeJobResultEnvelopeV2,
} from "../creative-jobs.ts";
import { assembleCreativePackageV2 } from "./assemble.ts";
import {
  runCreativeGenerationWithProviders,
  type CreativeAiInvocationTraceEntry,
  type CreativeAiRoute,
} from "./ai-orchestrator.ts";
import type { CreativeGenerationContext } from "./prompt.ts";

// Content Creation MVP S3E-A2 -- the real creative_ai executor.
//
// This module CONNECTS already-built pieces and owns no generation architecture of its own:
//
//   CreativeInput -> S3A grounding -> S3B context -> S3C-D routing -> S3B assembly -> v2 envelope
//
// What it deliberately does NOT do:
//   * choose or order providers, retry, or fall back    -- S3C-D owns routing, and this file never
//                                                          inspects a provider or a failure reason
//                                                          to decide what to try next.
//   * re-rank or re-score marketing recommendations     -- they arrive already ordered by the
//                                                          engine's own comparator.
//   * reinterpret S3A's resolution order                -- it supplies data to the resolver and
//                                                          uses whatever the resolver returns.
//   * touch the database                                -- grounding arrives through an injected
//                                                          loader, which is what makes every test
//                                                          below deterministic and offline.
//
// It is identical for both job origins. An Opportunity-backed and a request-backed job converge at
// CreativeInput before this executor is ever called, so there is exactly one AI generation path.

export type CreativeAiGroundingInputs = {
  // Already ranked by buildMarketingRecommendations' comparator. Never re-sorted here.
  recommendations: MarketingRecommendation[];
  journal: ContentJournalEntry[];
  products: Product[];
  brandBible: BrandBible;
  // Derived from real Brand Presence configuration, never assumed. May legitimately be empty --
  // S2/S3B permit platformVariants to be a subset, including none.
  configuredPlatforms: CreativePlatform[];
};

export type CreativeAiExecutorDeps = {
  loadGrounding: (input: CreativeInput) => Promise<CreativeAiGroundingInputs>;
  // Built by buildDefaultCreativeAiRoutes from the configured providers. Passed straight to S3C-D.
  routes: readonly CreativeAiRoute[];
  now?: () => number;
};

// The compatibility summary for creative_job_attempts.provider/model, per the frozen S3E-A1
// interpretation: ai_execution_trace is the AUTHORITATIVE multi-provider history, and provider/model
// are a summary of it -- never a replacement for it.
//
// The accepted CREATIVE BODY is the right summary because that is the invocation that produced the
// package content. A format decision accepted by Claude followed by a body accepted by Codex
// summarizes as codex-cli, and the trace still holds both.
//
// Returns null when no creative body was accepted. A failed run has no authoring model, and naming
// one would be a fabrication.
export function summarizeCreativeAiCompatibility(
  trace: readonly CreativeAiInvocationTraceEntry[],
): { provider: string; model: string | null } | null {
  const acceptedBody = [...trace].reverse().find((entry) => entry.stage === "creative_body" && entry.outcome === "success" && entry.action === "accepted");
  return acceptedBody ? { provider: acceptedBody.providerId, model: acceptedBody.model } : null;
}

function expectedFailure(input: {
  code: string;
  message: string;
  attemptOutcome?: "failed" | "timed_out";
  executionTrace: CreativeAiInvocationTraceEntry[];
}): CreativeJobExecutorFailure {
  return {
    creativeJobExecutorFailure: true,
    code: input.code,
    // Sanitized here as well as by the runner: this message is built from provider-neutral reason
    // codes and stage names only, never from raw provider output.
    message: sanitizeCreativeJobErrorMessage(input.message),
    attemptOutcome: input.attemptOutcome ?? "failed",
    executionTrace: input.executionTrace,
  };
}

export function createCreativeAiExecutor(deps: CreativeAiExecutorDeps): CreativeJobExecutor {
  return async function creativeAiExecutor(job, input): Promise<CreativeJobResultEnvelopeV2 | CreativeJobExecutorFailure> {
    const now = deps.now ?? Date.now;
    const loaded = await deps.loadGrounding(input);

    // S3A, unmodified. A stated subject still wins outright; only when none is stated does the
    // resolver fall through to a qualifying recommendation, then Journey, then the brand moment.
    const grounding = resolveCreativeGrounding({
      creativeInput: input,
      recommendations: loaded.recommendations,
      journal: loaded.journal,
      products: loaded.products,
      brandBible: loaded.brandBible,
      now: now(),
    });

    const context: CreativeGenerationContext = { creativeInput: input, grounding, brandBible: loaded.brandBible };

    // S3C-D owns everything about which provider runs, in what order, with which retries. This call
    // is the whole of this executor's provider logic.
    const orchestration = await runCreativeGenerationWithProviders(
      { context, configuredPlatforms: loaded.configuredPlatforms },
      { routes: deps.routes, now },
    );

    if (!orchestration.ok) {
      // Ordinary AI exhaustion -- both providers refused, hit a usage limit, or kept returning
      // unusable output. This is an operational outcome, not a defect, so it is RETURNED with its
      // trace rather than thrown. "timed_out" is used only when the AI itself reported a timeout.
      return expectedFailure({
        code: `ai_${orchestration.reason}`,
        message: `Creative AI generation failed at the ${orchestration.failedStage} stage: ${orchestration.reason}.`,
        attemptOutcome: orchestration.reason === "timeout" ? "timed_out" : "failed",
        executionTrace: orchestration.trace,
      });
    }

    // S3B assembly. The application owns every factual and provenance field here; nothing the model
    // returned can reach subject, subjectSource, subjectGrounding or metadata. assembleCreativePackageV2
    // runs the authoritative S2 validator as its final step, so a package that fails validation
    // never becomes a result.
    const assembled = assembleCreativePackageV2({
      creativeInput: input,
      grounding,
      decision: orchestration.formatDecision,
      formatChosenBy: orchestration.formatChosenBy,
      body: orchestration.body,
      sourceCreativeJobId: job.id,
      sourceWorker: "creative_ai",
    });

    if (!assembled.ok) {
      // The AI answered, but what it produced cannot become a valid Creative Package. Still an
      // expected outcome with real history behind it, so the trace travels with the failure.
      return expectedFailure({
        code: `assembly_${assembled.reason}`,
        message: `Creative AI output could not be assembled into a valid Creative Package: ${assembled.message}`,
        executionTrace: orchestration.trace,
      });
    }

    // The trace rides on the envelope only to cross the executor boundary; the runner lifts it off
    // and persists it on the attempt. It is never part of package content.
    return {
      schemaVersion: "v2",
      worker: "creative_ai",
      content: assembled.content,
      executionTrace: orchestration.trace,
    };
  };
}
