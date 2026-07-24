import { SPECIALISTS } from "./specialists.ts";
import type { AiAction, AiAdvisorInput, SpecialistId } from "./types.ts";

// Condensed from ai-review/ORCHESTRATOR.md. The full file is written for a human/Codex session
// reading it directly; a prompt pasted into a separate AI chat can't read repo files, so the
// procedure this app actually needs is transcribed here instead of referenced by path.
const ORCHESTRATOR_ROLE =
  "You are the Aly & Shin Product Lab Orchestrator. Your job is to apply only the specialist " +
  "lens(es) listed below yourself, reconcile their judgment without averaging, and recommend " +
  "the smallest useful next action. Do not be a yes-man -- challenge weak assumptions and state " +
  "plainly what evidence would be needed to resolve uncertainty. Do not invent evidence: if " +
  "something isn't in the data below, say it's missing rather than guessing.";

const RECONCILIATION_RULES =
  "Reconcile per these rules, never by averaging: any VETO from any specialist blocks " +
  "advancement, full stop. Any UNDETERMINED on a dimension required for this decision keeps the " +
  "overall outcome undetermined -- never round it up to a pass. A FAIL requires a defined " +
  "corrective action or controlled test before it can be considered resolved. CONCERN items are " +
  "tracked but do not automatically block. A PASS from one specialist never overrides another " +
  "specialist's VETO, FAIL, or UNDETERMINED.";

// Condensed from ai-review/SPECIALIST_REVIEW_PROTOCOL.md.
const EVIDENCE_QUALITY =
  "Tag every fact you rely on with one of: Measured (read directly from the data below), " +
  "Observed (would have been seen directly but isn't captured as a record), Reported (told to " +
  "you with no underlying record), Estimated (an inference or calculation from partial data -- " +
  "show the calculation), or Missing (not available in any form -- list it anyway so the gap is " +
  "visible).";

const VERDICT_DEFINITIONS =
  "Use exactly one verdict per specialist lens, never blended: PASS (evidence supports moving " +
  "forward within that lens's scope), CONCERN (may proceed, but a non-blocking issue should be " +
  "tracked), FAIL (current evidence doesn't meet the requirement -- always pair with a defined " +
  "corrective action or controlled test), VETO (a hard blocker regardless of other lenses' " +
  "scores -- reserved for genuine blockers per that lens's own trigger, not strong disagreement), " +
  "UNDETERMINED (not enough evidence to issue a responsible verdict -- prefer this over a guess).";

const DISCIPLINE_RULES =
  "Do not recommend complexity inappropriate for a home-proofing, single-kitchen business. " +
  "Prefer one controlled experiment that answers one question over a broad list. Mark " +
  "scientific/accounting benchmarks as guidance, not as this business's stated rules, unless " +
  "the data below says otherwise. Never call the App gate result below \"definitive\" -- it is " +
  "preliminary app logic. State explicitly wherever your judgment differs from what it shows.";

const RULE_ENGINE_BOUNDARY =
  "CRITICAL: the \"App gate result\" section below was computed by this app's deterministic " +
  "Rule Engine (margin, yield, break-even, readiness, and every other checkable number). Do not " +
  "recompute, re-derive, or restate any of those numbers differently -- treat them as given " +
  "facts and add the judgment a deterministic check structurally can't provide. If you disagree " +
  "with a rule's result, say so explicitly as your own specialist judgment call; never silently " +
  "substitute a different number for the same thing it already measured.";

const ACTION_INSTRUCTIONS: Record<AiAction, { title: string; task: string }> = {
  "explain-status": {
    title: "Explain Current Status",
    task:
      "Explain, in plain language Aly and Shin would actually use, why this product's health " +
      "and readiness are what they currently are. Anchor the explanation in the App gate " +
      "result's nextBestAction and active blockers/warnings below -- don't introduce a " +
      "different framing of the same problem.",
  },
  "recommend-next-action": {
    title: "Recommend Next Action",
    task:
      "Recommend the single smallest useful next action for this product. Start from the App " +
      "gate result's nextBestAction as your anchor, then add the judgment a deterministic check " +
      "can't provide -- is this realistic at the business's current stage, what's the fastest " +
      "real way to resolve it. Recommend one action, not a list.",
  },
  "improve-product": {
    title: "Improve Product",
    task:
      "Suggest concrete ways to improve this recipe/product, grounded in the recent " +
      "experiments, tasting feedback, and costing data below. Any suggestion must change one " +
      "major variable at a time and must fit a home-proofing kitchen.",
  },
  "design-experiment": {
    title: "Design Experiment",
    task:
      "Design exactly one controlled experiment that answers one open question about this " +
      "product. Use this structure: Observation, Research question, Hypothesis, Control, Test " +
      "variable, Controlled variables, Measurements, Expected result, Next test if this one " +
      "fails. Change only one variable.",
  },
  "launch-review": {
    title: "Launch Review",
    task:
      "Evaluate whether this product is ready to launch. Apply " + RECONCILIATION_RULES + " " +
      "State the App gate result as preliminary app logic, never as a definitive readiness " +
      "score, and note explicitly wherever a rule's severity was escalated in this launch " +
      "context (see the launch category results below).",
  },
};

function renderSpecialists(specialists: SpecialistId[]): string {
  return specialists
    .map((id) => {
      const specialist = SPECIALISTS[id];
      return `### ${specialist.name}\nScope: ${specialist.scope}\nVerdict triggers: ${specialist.verdictTriggers}`;
    })
    .join("\n\n");
}

function renderOutputStructure(action: AiAction): string {
  if (action === "launch-review") {
    return (
      "Respond with exactly these 12 sections, in order: Decision; Selected specialist " +
      "lens(es) and why (including any deliberately excluded); Data completeness status; App " +
      "gate result (stated as preliminary app logic); Specialist verdict table (one row per " +
      "lens: verdict, confidence, one-line reason); Blocking issues; Non-blocking concerns; " +
      "Final verdict; Confidence (not higher than the lowest-confidence lens that's " +
      "load-bearing for it); Smallest useful next action; Exact success criteria; Deferred " +
      "issues."
    );
  }

  return (
    "Respond with these sections, in order: Scope reviewed; Evidence used (tag each fact per " +
    "the evidence-quality categories above); Answer (direct response to the task below); Risks " +
    "or open questions; Recommended next action; Success criteria (the exact measurement that " +
    "would resolve the next action)."
  );
}

// Renders AiAdvisorInput as plain, unmodified JSON -- no formatting logic touches a number
// between the Rule Engine's output and what the AI reads, so there's no place for a silent
// recalculation to sneak in.
function renderInputData(input: AiAdvisorInput): string {
  return [
    "## Business & product context",
    input.productContext,
    "",
    "## App gate result (from the Rule Engine -- do not recompute)",
    JSON.stringify(input.ruleEngineOutput, null, 2),
    "",
    "## Costing summary",
    JSON.stringify(input.costingSummary, null, 2),
    "",
    "## Tasting summary",
    JSON.stringify(input.tastingSummary, null, 2),
    "",
    "## Recent experiments (most recent first)",
    JSON.stringify(input.recentExperiments, null, 2),
  ].join("\n");
}

// Pure string assembly: same action + same specialists + same input always produces the exact
// same prompt. No network call, no randomness, no file I/O -- everything this needs is already
// in memory as TypeScript constants and the input object.
export function buildPrompt(action: AiAction, specialists: SpecialistId[], input: AiAdvisorInput): string {
  const instruction = ACTION_INSTRUCTIONS[action];

  return [
    `# ${instruction.title} -- ${input.product.name}`,
    "",
    ORCHESTRATOR_ROLE,
    "",
    `## Selected specialist lens(es)`,
    renderSpecialists(specialists),
    "",
    "## Evidence quality",
    EVIDENCE_QUALITY,
    "",
    "## Verdict definitions",
    VERDICT_DEFINITIONS,
    "",
    "## Discipline",
    DISCIPLINE_RULES,
    "",
    RULE_ENGINE_BOUNDARY,
    "",
    renderInputData(input),
    "",
    "## Task",
    instruction.task,
    "",
    "## Required response structure",
    renderOutputStructure(action),
  ].join("\n");
}
