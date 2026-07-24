# REVIEW

> Claude's review verdicts. Append-only. Never rubber-stamp.
>
> Each entry ends by stating which merge gate was chosen (`done` = reversible, auto-merges ·
> `approved` = red-zone, HELD for human merge) and why. See CLAUDE.md "Risk-gated merge".

## 2026-07-24 — Rule Engine implementation

**Scope:** new `src/lib/rule-engine/` module, `readiness.ts` refactor, `batches.ts` extraction,
`costing.ts` target-food-cost fix, `tsconfig.json` change, 43 new tests.

**Verdict:** Sound. The engine is genuinely pure (no I/O, verified by a determinism test), every
category module reuses existing calculation functions instead of duplicating them
(`getCostingTotals`, `getMatchingSupplies`, `diffFormulaRows`), and the `readiness.ts` delegation
preserves every existing call site's function signature — confirmed by grepping all ~12 call
sites in `product-lab.tsx` before changing anything, not assumed.

**Not rubber-stamped — one real behavior change flagged, not hidden:**
`getReadinessScore()`'s `passed`/`total` numbers (rendered as "X/Y gates passed" on Dashboard and
Products) will show larger, more granular counts than the previous fixed "/6" once this ships,
because the engine evaluates ~26 applicable rules instead of 6. The `percent` itself is now
severity-weighted rather than a flat pass count — an intentional, documented upgrade (see
`docs/ARCHITECTURE.md`), not a bug, but it is a visible change to a number the business owner
looks at.

Several rules (QUAL-001/002/003/005, FIN-003/004/007, PROD-004) are simplified relative to their
full `RULES/*.md` spec because the finer distinction they describe needs data that only exists
inside free-text/JSON-in-notes columns, not structured fields — each documented inline with
`passed: null` used honestly rather than a fabricated heuristic pretending to be precise.

**Merge gate: `done`.** No data, auth, or security surface touched; no Supabase schema change;
fully covered by 69 passing automated tests (lint + typecheck + `node --test`); reversible via
git. The one flagged behavior change (gate-count display) is cosmetic/numeric, not a data
integrity or access-control concern, so it doesn't meet the red-zone bar on its own — but it's
called out above so a human reviewing this entry isn't surprised by it after deploy.

## 2026-07-24 — Integrate the AI Advisor into Product Lab

**Scope:** new `src/services/ai/` module, `src/components/ai-advisor-panel.tsx`, new
`ai_reviews` table (proposed SQL, not applied), `rule-engine/index.ts` export widening,
`product-lab.tsx` wiring, 18 new tests.

**A real architectural blocker was found and surfaced before writing code, not worked around
silently.** This app has zero server-side execution boundary — every component under `src/app`
is `"use client"`, and Supabase is called directly from the browser with its public anon key. An
AI provider's API key is a real secret; wiring a live call the same way the rest of the app talks
to Supabase would have shipped that key into the browser bundle. I stopped, explained this, and
asked the user how to proceed (add a Route Handler vs. something else; which provider) rather
than picking a default and building it. The user's answer changed the scope entirely: no live
provider, no Route Handler, no API keys, no server-side AI at all — a Copy-Prompt architecture
instead, with the response pasted back in manually. Everything in this entry reflects that
descoped, explicitly-approved design, not the original task text's literal ask for a wired
provider.

**Verdict:** Sound within that descoped design. `generateAdvisorPrompt()` is genuinely pure and
synchronous — verified by a determinism test and a same-input-produces-`deepEqual`-output test —
and every number that reaches the prompt is sourced from an existing calculation
(`evaluateProduct`, `getCostingTotals`), never a second one; a test locates the engine's exact
`nextBestAction.message` and `margin` value verbatim inside the assembled prompt text as direct
proof, not an assumption.

**Not rubber-stamped — one real bug this review's own test suite caught before commit:**
`hasUnresolvedSupplyRisk` (the Launch Review specialist-routing check) originally treated
`passed: null` (insufficient purchase history, the normal state at this business's scale) the
same as an active failure, which would have pulled the Supply Chain Manager into nearly every
Launch Review regardless of whether a real problem existed — violating the Rule Engine's own
null-safety discipline one layer up. Caught by a routing test, fixed before this entry was
written, re-verified: 90/90 passing.

**A known, undocumented-enforcement data gap, flagged not hidden:** `specialists.ts` is a
condensed, prompt-sized re-transcription of `ai-review/specialists/*.md`'s scope and verdict
triggers — necessary because a prompt pasted into a separate AI chat has no filesystem access to
read the real files, but it means two representations of the same specialists now exist. Nothing
currently enforces they stay in sync; a future edit to a specialist's `.md` file could silently
drift from its `.ts` counterpart. Documented in `docs/ARCHITECTURE.md`, not solved here.

**Merge gate: `done`.** No existing table, column, or call site was changed — `ai_reviews` is a
new, additive table proposed as SQL that has not been run, and the app functions identically
before and after it exists (the same `isSuppliesTableMissing`-style graceful-degradation pattern
already trusted elsewhere in this codebase). No AI provider, API key, or network call exists
anywhere in this change, so there is no new external-service or credential-handling risk to
red-zone. Fully covered by 90 passing automated tests; reversible via git. The one open item
before this is genuinely useful is running `supabase-add-ai-reviews.sql` — Copy Prompt works
without it, but Save Review does not.
