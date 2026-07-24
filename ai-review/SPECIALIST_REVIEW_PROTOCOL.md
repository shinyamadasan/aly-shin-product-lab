# Specialist Review Protocol

Shared by every file in `ai-review/`. This is the one place these definitions live — the
Orchestrator and every specialist module reference this file instead of restating it. If a rule
here needs to change, change it here only.

Before applying this protocol, read `PRODUCT_LAB_CONTEXT.md` (repo root). It is the source of
truth for business stage, page purposes, and workflow rules. Nothing in this framework overrides
it.

Specialist modules deliberately hold only scope and verdict triggers — domain expertise
(accounting principles, food science, product-specific science, packaging) lives under
`knowledge/` and is referenced by whichever specialist needs it. Read every knowledge file a
specialist module points to before producing that specialist's assessment; don't skip it because
the specialist file "looks complete" on its own.

## Required output structure for every specialist

Every specialist review — regardless of which specialist module produced it — returns exactly
these 12 sections, in this order:

1. **Scope reviewed** — what part of the decision this specialist actually looked at.
2. **Decision being evaluated** — restated in this specialist's own terms.
3. **Evidence used** — the specific facts/records/numbers relied on.
4. **Evidence quality** — every fact in section 3 tagged with one of the five categories below.
5. **Verified findings** — conclusions that follow directly from the evidence.
6. **Assumptions** — anything treated as true without direct evidence, stated explicitly.
7. **Risks** — what could go wrong if this specialist's assessment is acted on and is wrong.
8. **Verdict** — one of the five values below.
9. **Confidence** — High / Medium / Low.
10. **Missing evidence** — exactly what's needed to raise confidence or resolve UNDETERMINED.
11. **Recommended next action** — the smallest useful action, not a broad list.
12. **Success criteria** — the exact measurement that would resolve the next action.

## Evidence quality categories

Tag every fact used in "Evidence used" with one of these. Do not leave evidence untagged.

- **Measured** — read directly from a real record: a saved costing, a logged batch, an exported
  report, a live query result.
- **Observed** — seen directly by Aly or Shin, but not captured as a record (e.g. "it looked
  under-baked" with no batch note logged).
- **Reported** — told to the reviewer by the user, with no underlying record to check it against.
- **Estimated** — a stated inference or calculation made from partial data (label it as such,
  and show the calculation).
- **Missing** — not available in any form. Still list it here so the gap is visible, not silently
  dropped.

## Verdict definitions

Use exactly one per specialist review. Do not blend or average.

- **PASS** — Evidence supports moving forward within this specialist's scope.
- **CONCERN** — The product may proceed, but a non-blocking issue should be tracked.
- **FAIL** — Current evidence does not meet this specialist's requirement and needs correction or
  another test. Always pair a FAIL with a defined corrective action or controlled test — a FAIL
  with no next step is not a complete review.
- **VETO** — A hard safety, financial, quality, legal, or operational blocker prevents
  advancement regardless of other specialists' scores. VETO is reserved for genuine blockers, not
  strong disagreement — see each specialist module's own VETO triggers before using it.
- **UNDETERMINED** — Not enough evidence exists to issue a responsible verdict. This is not a
  failure to produce an opinion — inventing certainty from incomplete evidence is the failure
  mode this exists to prevent. Prefer UNDETERMINED over a guess.

## Confidence levels

Driven by the evidence-quality mix behind the verdict, not by how strongly the specialist feels:

- **High** — Measured evidence covers the full scope of this specialist's review.
- **Medium** — Coverage is partial, or leans on Reported evidence for load-bearing facts.
- **Low** — Mostly Estimated or Missing evidence, or the verdict rests on Reported claims alone.

## Shared discipline rules

These apply to every specialist review and to the Orchestrator's reconciliation of them:

- Do not append superseded audits or historical deliverables to a current response.
- Do not repeat historical findings unless directly required for the current decision.
- Do not invent evidence. If it isn't Measured/Observed/Reported/Estimated with a shown basis,
  it goes under Missing.
- Before asking the user to gather data manually, try available read-only retrieval first
  (database query, application state, an exported report already on disk, a screenshot already
  provided). Only ask manually once those have genuinely been tried.
- When data access fails, report exactly what was attempted and why it failed — not just "data
  unavailable."
- Prefer a compact evidence request (a short list of exact fields) over a long repeated audit.
- Do not recommend complexity inappropriate for the current home-proofing stage (see
  `PRODUCT_LAB_CONTEXT.md`).
- Prefer one controlled experiment that answers one question over a broad list of experiments.
  Change one major variable at a time.
- Mark scientific or accounting benchmarks (target food cost %, a specific shelf-life duration,
  an industry margin norm) as guidance, not as this business's explicit rules, unless
  `PRODUCT_LAB_CONTEXT.md` or the user has stated them as an actual business rule.
- Never call an app-computed gate (the Rule Engine — `RULE_ENGINE.md`, `RULES/` — or its current
  partial implementation, `readiness.ts`'s 6 checks) "definitive." It is preliminary app logic.
  Always state explicitly where a specialist's real judgment differs from what a rule's result
  would show. Never recompute a deterministic rule yourself — read the Rule Engine's output and
  add judgment on top of it, don't re-derive the number.
