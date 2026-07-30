// Pure gate logic, deliberately separate from the smoke test file itself so it can be unit
// tested from the deterministic suite without importing (and thereby registering) the smoke
// test's own `test()` call. An API key being present is never sufficient on its own -- both
// conditions are required, and the opt-in must match exactly "1".

export type PaidSmokeGateResult = { ok: true } | { ok: false; message: string };

export function resolvePaidAnthropicSmokeGate(env: Record<string, string | undefined>): PaidSmokeGateResult {
  const hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
  const optedIn = env.RUN_PAID_ANTHROPIC_SMOKE === "1";

  if (!hasApiKey || !optedIn) {
    return {
      ok: false,
      message:
        "Skipped: this test makes one real, billable request to the Anthropic API. " +
        "It requires BOTH ANTHROPIC_API_KEY and RUN_PAID_ANTHROPIC_SMOKE=1 set explicitly in the environment -- " +
        "an API key being present by itself is never enough to trigger it.",
    };
  }

  return { ok: true };
}
