# Workflow: Product Readiness Review

Use for "is this product ready to advance to the next stage" — a single-product review, narrower
than a full launch-readiness council (no Supply Chain or Multi-Branch unless routing rules pull
them in). Delegates to `ORCHESTRATOR.md` and `ROUTING_RULES.md`.

## Default specialists

Restaurant Accountant + Product Development Chef + Bakery Production Manager + Food Science &
Quality Specialist. This is the same set used for the first Brownies readiness review this
session — it maps directly onto the Rule Engine's Financial, Product Development, Production, and
Quality categories (`RULE_ENGINE.md`), including the packaging/stress-test dimension (QUAL-002)
that a cost-presence check alone can't verify.

## Required shape

Follow this exact sequence — do not skip straight to a verdict:

1. **Data completeness** — what evidence exists vs. is missing, before anything else. Try
   available read-only retrieval (live query, exported report, application state) before asking
   the user to gather data manually; report what was attempted and why it failed if it did.
2. **App gate result** — call the Rule Engine and read its `RuleEngineResult` for this product
   (mark each relevant rule Pass / Fail / `null`=insufficient data — never guess a rule's result
   yourself). State plainly that this is preliminary app logic, not a definitive readiness score,
   and flag any rule whose default severity differs from what it becomes in this context (QUAL-002
   is the known example — see `specialists/food-science-quality-specialist.md` and
   `RULES/quality.md`).
3. **Specialist assessment** — each engaged specialist's full review, kept visibly separate from
   the app gate result above. These can and will disagree with the boolean gates — that
   disagreement is the point.
4. **Orchestrator decision** — reconciled per `ORCHESTRATOR.md`'s rules (never average, any VETO
   blocks, any UNDETERMINED on a required dimension keeps the whole thing undetermined).

## If evidence is incomplete

Do not force a verdict. Produce the compact missing-evidence list and a fill-in template instead
of guessing — see the discipline rules in `SPECIALIST_REVIEW_PROTOCOL.md`. A clearly-stated
"undetermined pending X" is a complete, useful answer, not a stall.
