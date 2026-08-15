import type { AiTextFailureReason, AiTextProvider, AiTextRequest } from "../ai/ai-text-provider.ts";
import type { CreativeFormat } from "../creative-formats.ts";
import type { CreativeBody, CreativeFormatDecision } from "./contracts.ts";
import {
  buildUserFormatDecision,
  resolveCreativeProductionConstraint,
  validateCreativeBody,
  validateFormatDecision,
  type CreativeProductionConstraint,
} from "./contracts.ts";
import { buildCreativeBodyRequest, buildFormatDecisionRequest, type CreativeGenerationContext } from "./prompt.ts";

export type CreativeAiStage = "format_decision" | "creative_body";

export type CreativeAiRoute = {
  provider: AiTextProvider;
  model: string;
};

export type CreativeAiTraceAction = "accepted" | "retry_same_provider" | "fallback" | "stop";

export type CreativeAiInvocationTraceEntry = {
  stage: CreativeAiStage;
  providerId: string;
  model: string | null;
  invocationNumber: number;
  providerInvocationNumber: number;
  outcome: "success" | "failure";
  failureReason?: AiTextFailureReason;
  durationMs: number | null;
  action: CreativeAiTraceAction;
};

export type CreativeAiOrchestratorOptions = {
  routes?: readonly CreativeAiRoute[];
  now?: () => number;
};

export type RunCreativeGenerationInput = {
  context: CreativeGenerationContext;
  configuredPlatforms: readonly string[];
};

export type CreativeAiOrchestrationSuccess = {
  ok: true;
  formatDecision: CreativeFormatDecision;
  formatChosenBy: "ai" | "user";
  body: CreativeBody;
  trace: CreativeAiInvocationTraceEntry[];
};

export type CreativeAiOrchestrationFailure = {
  ok: false;
  failedStage: CreativeAiStage;
  reason: AiTextFailureReason;
  trace: CreativeAiInvocationTraceEntry[];
};

export type CreativeAiOrchestrationResult = CreativeAiOrchestrationSuccess | CreativeAiOrchestrationFailure;

export const CREATIVE_AI_CLAUDE_MODEL = "opus";
export const CREATIVE_AI_CODEX_MODEL = "gpt-5.6-sol";

const RETRYABLE_REASONS = new Set<AiTextFailureReason>(["malformed_response", "schema_invalid"]);
const SUPPRESSING_REASONS = new Set<AiTextFailureReason>([
  "usage_limit",
  "authentication",
  "timeout",
  "provider_unavailable",
  "process_error",
  "output_too_large",
  "configuration_error",
]);

type StageSuccess<T> = { ok: true; value: T; acceptedRouteIndex: number };
type StageFailure = { ok: false; reason: AiTextFailureReason };
type StageResult<T> = StageSuccess<T> | StageFailure;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: AiTextFailureReason };

export function buildDefaultCreativeAiRoutes(providers: { claude: AiTextProvider; codex: AiTextProvider }): CreativeAiRoute[] {
  return [
    { provider: providers.claude, model: CREATIVE_AI_CLAUDE_MODEL },
    { provider: providers.codex, model: CREATIVE_AI_CODEX_MODEL },
  ];
}

function toAiTextRequest(request: { system: string; user: string; jsonSchema: Record<string, unknown> }, model: string): AiTextRequest {
  return {
    systemPrompt: request.system,
    userPrompt: request.user,
    structuredOutput: { schema: request.jsonSchema },
    model,
  };
}

function validateFormatDecisionResult(value: unknown, constraint: CreativeProductionConstraint): ValidationResult<CreativeFormatDecision> {
  const validation = validateFormatDecision(value, constraint);
  return validation.ok ? { ok: true, value: validation.decision } : { ok: false, reason: "schema_invalid" };
}

function validateBodyResult(format: CreativeFormat, value: unknown, constraint: CreativeProductionConstraint): ValidationResult<CreativeBody> {
  const validation = validateCreativeBody(format, value, constraint);
  return validation.ok ? { ok: true, value: validation.body } : { ok: false, reason: "schema_invalid" };
}

function fallbackAction(hasNextRoute: boolean, reason: AiTextFailureReason): CreativeAiTraceAction {
  if (reason === "cancelled") return "stop";
  return hasNextRoute ? "fallback" : "stop";
}

async function executeStage<T>(input: {
  stage: CreativeAiStage;
  request: { system: string; user: string; jsonSchema: Record<string, unknown> };
  routes: readonly CreativeAiRoute[];
  startRouteIndex: number;
  suppressedRouteIndexes: Set<number>;
  trace: CreativeAiInvocationTraceEntry[];
  maxInvocations: number;
  providerInvocationCounts: Map<string, number>;
  now: () => number;
  validate: (value: unknown) => ValidationResult<T>;
}): Promise<StageResult<T>> {
  const { stage, request, routes, suppressedRouteIndexes, trace, maxInvocations, providerInvocationCounts, now, validate } = input;
  let routeIndex = input.startRouteIndex;

  while (routeIndex < routes.length) {
    if (suppressedRouteIndexes.has(routeIndex)) {
      routeIndex += 1;
      continue;
    }

    const route = routes[routeIndex];
    let retryUsed = false;

    while (true) {
      if (trace.length >= maxInvocations) {
        return { ok: false, reason: "process_error" };
      }

      const startedAt = now();
      const result = await route.provider.generate(toAiTextRequest(request, route.model));
      const durationMs = result.metadata?.durationMs ?? now() - startedAt;
      const invocationNumber = trace.length + 1;
      const providerInvocationNumber = (providerInvocationCounts.get(route.provider.providerId) ?? 0) + 1;
      providerInvocationCounts.set(route.provider.providerId, providerInvocationNumber);

      if (result.ok) {
        const validation = validate(result.structuredValue);
        if (validation.ok) {
          trace.push({
            stage,
            providerId: route.provider.providerId,
            model: route.model,
            invocationNumber,
            providerInvocationNumber,
            outcome: "success",
            durationMs,
            action: "accepted",
          });
          return { ok: true, value: validation.value, acceptedRouteIndex: routeIndex };
        }

        const hasRetry = !retryUsed;
        const hasFallback = routeIndex + 1 < routes.length;
        trace.push({
          stage,
          providerId: route.provider.providerId,
          model: route.model,
          invocationNumber,
          providerInvocationNumber,
          outcome: "failure",
          failureReason: validation.reason,
          durationMs,
          action: hasRetry ? "retry_same_provider" : fallbackAction(hasFallback, validation.reason),
        });

        if (hasRetry) {
          retryUsed = true;
          continue;
        }
        routeIndex += 1;
        break;
      }

      const hasRetry = RETRYABLE_REASONS.has(result.reason) && !retryUsed;
      const hasFallback = result.reason !== "cancelled" && routeIndex + 1 < routes.length;
      trace.push({
        stage,
        providerId: route.provider.providerId,
        model: route.model,
        invocationNumber,
        providerInvocationNumber,
        outcome: "failure",
        failureReason: result.reason,
        durationMs,
        action: hasRetry ? "retry_same_provider" : fallbackAction(hasFallback, result.reason),
      });

      if (result.reason === "cancelled") {
        return { ok: false, reason: result.reason };
      }
      if (SUPPRESSING_REASONS.has(result.reason)) {
        suppressedRouteIndexes.add(routeIndex);
      }
      if (hasRetry) {
        retryUsed = true;
        continue;
      }
      routeIndex += 1;
      break;
    }
  }

  const finalFailure = [...trace].reverse().find((entry) => entry.outcome === "failure" && entry.stage === stage);
  return { ok: false, reason: finalFailure?.failureReason ?? "process_error" };
}

export async function runCreativeGenerationWithProviders(
  input: RunCreativeGenerationInput,
  options: CreativeAiOrchestratorOptions,
): Promise<CreativeAiOrchestrationResult> {
  const routes = options.routes ?? [];
  const trace: CreativeAiInvocationTraceEntry[] = [];
  const maxInvocations = input.context.creativeInput.formatHint === null ? 6 : 4;
  const suppressedRouteIndexes = new Set<number>();
  const providerInvocationCounts = new Map<string, number>();
  const now = options.now ?? Date.now;
  // H1-B -- derived once from the owner's own sentence and used by BOTH stages, so the format the
  // generator is allowed to choose and the production source it is allowed to author can never
  // disagree about what the request permits.
  const constraint = resolveCreativeProductionConstraint(input.context.creativeInput);
  let startRouteIndex = 0;

  if (routes.length === 0) {
    return { ok: false, failedStage: input.context.creativeInput.formatHint === null ? "format_decision" : "creative_body", reason: "provider_unavailable", trace };
  }

  let formatDecision: CreativeFormatDecision;
  let formatChosenBy: "ai" | "user";

  if (input.context.creativeInput.formatHint === null) {
    const stageResult = await executeStage({
      stage: "format_decision",
      request: buildFormatDecisionRequest(input.context),
      routes,
      startRouteIndex,
      suppressedRouteIndexes,
      trace,
      maxInvocations,
      providerInvocationCounts,
      now,
      validate: (value) => validateFormatDecisionResult(value, constraint),
    });
    if (!stageResult.ok) {
      return { ok: false, failedStage: "format_decision", reason: stageResult.reason, trace };
    }
    formatDecision = stageResult.value;
    formatChosenBy = "ai";
    startRouteIndex = stageResult.acceptedRouteIndex;
  } else {
    formatDecision = buildUserFormatDecision(input.context.creativeInput.formatHint);
    formatChosenBy = "user";
  }

  const bodyResult = await executeStage({
    stage: "creative_body",
    request: buildCreativeBodyRequest(input.context, formatDecision, input.configuredPlatforms),
    routes,
    startRouteIndex,
    suppressedRouteIndexes,
    trace,
    maxInvocations,
    providerInvocationCounts,
    now,
    validate: (value) => validateBodyResult(formatDecision.format, value, constraint),
  });
  if (!bodyResult.ok) {
    return { ok: false, failedStage: "creative_body", reason: bodyResult.reason, trace };
  }

  return {
    ok: true,
    formatDecision,
    formatChosenBy,
    body: bodyResult.value,
    trace,
  };
}
