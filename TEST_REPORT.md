# TEST REPORT

> **Codex owns this file. Append-only.** Claude never edits it.
> One entry per task: what was run, what passed, what failed. A task with no test evidence
> is not reviewable.

## 2026-07-24 — Rule Engine implementation

**Ran:** `npx eslint .`, `npm run build` (includes `tsc` type-check), `npm test`
(`node --test tests/*.test.ts`).

**Result:** All clean/passing.
- Lint: 0 errors, 0 warnings.
- Build: compiled successfully, TypeScript check passed, all 14 routes generated.
- Tests: 69/69 passing (26 pre-existing + 43 new in `tests/rule-engine.test.ts`).

**New test coverage** (`tests/rule-engine.test.ts`): Pass/Warning/Fail/insufficient-data cases
for representative rules across all six categories (FIN-001/002/003/004/005/006/007,
PROD-001/002/004/005, DEV-001/002/003/004/005/006, QUAL-001/002/003/005, SUP-001/003/004,
LAUNCH-001/003/004), priority-ordering tests (financial blocker outranks quality warning; food
safety outranks a same-tier quality rule), `getReadinessPercentage`/`getProductHealth`
aggregation tests, a determinism test (same input twice → deep-equal output), and a regression
test that locks in the real Brownies costing recovered earlier this session (PHP 50 price
against PHP 52.33 cost, -4.7% margin) still resolving to `productHealth: "blocked"` with
`nextBestAction.id === "FIN-001"`.

**Not run:** no UI/browser verification — this is a pure calculation-layer change with no UI
surface of its own; `getReadinessScore`'s new output values will render through existing
Dashboard/Products/Product Detail UI on next deploy, not independently verified in a browser
this session.

## 2026-07-24 — Integrate the AI Advisor into Product Lab

**Ran:** `npx eslint .`, `npm run build` (includes `tsc` type-check), `npm test`
(`node --test tests/*.test.ts`).

**Result:** All clean/passing.
- Lint: 0 errors, 0 warnings (including the React purity rule, which initially flagged a
  `Date.now()` call inside `AiAdvisorPanel`'s render-scoped handler — fixed by moving the call
  into the `onClick` expression itself).
- Build: compiled successfully, TypeScript check passed, all 16 routes generated.
- Tests: 90/90 passing (72 pre-existing + 18 new in `tests/ai-advisor.test.ts`).

**New test coverage** (`tests/ai-advisor.test.ts`): context assembly matches `evaluateProduct`
and `getCostingTotals` called directly (byte-for-byte `deepEqual`, not just similar values);
`includeLaunch` only turns on for the `launch-review` action; honest nulls when no costing
exists; tasting/experiment summaries match raw data; routing tests for all 5 actions including a
caught bug (see below); a determinism test (same input twice → identical prompt string); a
synchronous-return test (`typeof result.then === "undefined"`, proving no network call exists to
be "unavailable"); a test asserting all 5 actions produce distinct prompts; and a test that
locates the Rule Engine's exact `nextBestAction.message` and `margin` value verbatim inside the
generated prompt text, proving the prompt quotes the engine rather than re-deriving a number.

**Bug caught by this test suite, fixed before commit:** `hasUnresolvedSupplyRisk` (routing.ts)
originally treated `passed: null` (insufficient purchase history — the common case at this
scale) the same as an active failure, which would have pulled the Supply Chain Manager into
almost every Launch Review regardless of whether there was a real problem. Fixed to only count
an active, non-info-severity failure as risk, matching the Rule Engine's own null-safety
discipline and `ROUTING_RULES.md`'s "actually relevant" bar.

**Not run:** no UI/browser verification — no Playwright/browser-automation tool is available in
this environment; `AiAdvisorPanel`'s button/copy/paste/save flow was verified at the
type-check/build level, not clicked through live. No AI provider is configured (by design this
phase — see `docs/ARCHITECTURE.md` "AI Advisor"), so there is no live-response path to test.
