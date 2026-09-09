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
  // Wave D1 R1. A transport-safety flag, NOT a diagnostic -- which is why it is a sibling of
  // `diagnostics` rather than a key inside it.
  //
  // A provider failure message is one of two very different things. Some are authored by the
  // provider itself ("The Claude CLI did not respond within 120000ms.") and contain nothing but
  // provider vocabulary. Others are built by TRUNCATING the process's own output -- stdout, stderr,
  // a CLI error envelope, or a Node error string that echoes the offending argv entry back at you.
  // The second kind carries prompt text, model output and filesystem detail, and must never be
  // persisted.
  //
  // The distinction is NOT derivable from `reason`: `process_error` is produced both by a spawn
  // refusal (safe) and by a non-zero exit whose message is raw stdout+stderr (unsafe), and
  // `usage_limit`/`authentication` are classified by regex OVER those raw streams. So the provider
  // -- the only layer that knows how it built the string -- states it here explicitly.
  //
  // Absent is read as NOT safe. A caller that persists messages must require `=== true`.
  messageSafe?: boolean;
};

export type AiTextResult = AiTextSuccess | AiTextFailure;

export type AiTextProvider = {
  providerId: string;
  generate(request: AiTextRequest): Promise<AiTextResult>;
};

export function isAiTextFailureReason(value: string): value is AiTextFailureReason {
  return AI_TEXT_FAILURE_REASONS.includes(value as AiTextFailureReason);
}
