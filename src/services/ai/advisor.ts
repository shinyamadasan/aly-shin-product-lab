import type { Product } from "../../lib/product-lab-types.ts";
import type { RuleEngineContext } from "../../lib/rule-engine/index.ts";
import { buildAdvisorInput } from "./context.ts";
import { buildPrompt } from "./prompts.ts";
import { selectSpecialists } from "./routing.ts";
import type { AiAction, AiPromptResult } from "./types.ts";

// The single entry point the UI calls, and the one place a future live provider gets wired in.
// Today this always returns a Copy-Prompt result (see AiAdvisorPanel: copy the prompt, paste
// the reply back). Adding a real AI provider later means implementing AiProvider (types.ts) and
// changing only the body of this function to call it -- no other file in the app needs to know
// a provider exists.
export function generateAdvisorPrompt(action: AiAction, product: Product, context: RuleEngineContext): AiPromptResult {
  const input = buildAdvisorInput(product, context, action);
  const specialists = selectSpecialists(action, input.ruleEngineOutput);
  const prompt = buildPrompt(action, specialists, input);

  return { action, input, prompt, specialists };
}

// The fixed, complete set of AI actions this app exposes -- see RULE_ENGINE.md/ai-review/ for
// why this list is deliberately not extensible from the UI. Buttons iterate this array, so the
// UI can never expose an action this service doesn't define.
export const AI_ACTIONS: ReadonlyArray<{ action: AiAction; label: string; question: string }> = [
  { action: "explain-status", label: "Explain", question: "Why is this product blocked?" },
  { action: "recommend-next-action", label: "Recommend Next Step", question: "What should I do next?" },
  { action: "improve-product", label: "Suggest Improvements", question: "How can I improve this recipe?" },
  { action: "design-experiment", label: "Design Experiment", question: "What experiment should I run next?" },
  { action: "launch-review", label: "Launch Review", question: "Is this ready for launch?" },
];
