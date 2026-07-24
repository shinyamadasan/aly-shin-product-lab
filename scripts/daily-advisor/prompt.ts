// Pure string assembly, mirroring src/services/ai/prompts.ts's discipline: the deterministic
// content is embedded as-is and Claude is told explicitly it is final. Deliberately much smaller
// than the single-product Advisor's multi-specialist prompt -- this is a two-minute morning
// read, not a launch-readiness council, so it asks for exactly three narrow additions and nothing
// else (per the task's "Claude may add only" list).
export function buildPortfolioPrompt(deterministicMarkdown: string): string {
  return [
    "You are assisting with a short daily briefing for Aly & Shin Product Lab, a home-based",
    "coffee and bakery business in the proving stage (pre-launch, small-batch, single kitchen).",
    "",
    "A deterministic rule engine has already computed and ranked everything below. This ranking",
    "and every fact in it is FINAL. Do not recalculate any figure, do not reorder or remove any",
    "finding, and do not introduce a fact that isn't already present below.",
    "",
    "## Deterministic briefing (already complete; will be sent as-is if you are unavailable)",
    deterministicMarkdown,
    "",
    "## Your task",
    "Add, in under 120 words total, plain text only (no markdown headers):",
    "1. A concise, plain-language explanation of why today's highest-priority item matters.",
    "2. Practical sequencing advice, only if there is more than one action today.",
    "3. Exactly one optional improvement idea, clearly your own suggestion -- not a rule-engine",
    "   finding, and label it as such (e.g. start the sentence with \"AI suggestion:\").",
    "",
    "Do not restate the findings verbatim. Do not mention a margin, percentage, or any other",
    "calculated figure that isn't already shown above. Do not suggest a different priority order",
    "than the one already given.",
  ].join("\n");
}
