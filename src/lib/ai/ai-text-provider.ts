export type JsonSchemaObject = Record<string, unknown>;

export type AiTextStructuredOutputRequest = {
  schema: JsonSchemaObject;
  schemaName?: string;
};

export type AiTextRequest = {
  systemPrompt?: string;
  userPrompt: string;
  structuredOutput?: AiTextStructuredOutputRequest;
  timeoutMs?: number;
  model?: string;
};

export type AiTextUsageMetadata = {
  inputTokens?: number;
  outputTokens?: number;
};

export type AiTextResultMetadata = {
  providerId: string;
  model: string | null;
  durationMs: number | null;
  usage?: AiTextUsageMetadata;
};

export const AI_TEXT_FAILURE_REASONS = [
  "usage_limit",
  "authentication",
  "timeout",
  "provider_unavailable",
  "process_error",
  "malformed_response",
  "schema_invalid",
  "output_too_large",
  "cancelled",
  "configuration_error",
] as const;

export type AiTextFailureReason = (typeof AI_TEXT_FAILURE_REASONS)[number];

export type AiTextSuccess = {
  ok: true;
  text: string;
  structuredValue?: unknown;
  metadata: AiTextResultMetadata;
};

export type AiTextFailure = {
  ok: false;
  reason: AiTextFailureReason;
  message: string;
  metadata?: Partial<AiTextResultMetadata>;
  diagnostics?: Record<string, unknown>;
};

export type AiTextResult = AiTextSuccess | AiTextFailure;

export type AiTextProvider = {
  providerId: string;
  generate(request: AiTextRequest): Promise<AiTextResult>;
};

export function isAiTextFailureReason(value: string): value is AiTextFailureReason {
  return AI_TEXT_FAILURE_REASONS.includes(value as AiTextFailureReason);
}
