# Workflow: Launch-Readiness Council

The fullest cross-functional review this framework runs — use only for an actual launch/preorder
decision, not a routine progress check (use `product-readiness-review.md` for that). Delegates to
`ORCHESTRATOR.md` and `ROUTING_RULES.md`.

## Default specialists

Always: Restaurant Accountant + Product Development Chef + Food Science & Quality Specialist +
Bakery Production Manager.

Conditionally: Supply Chain Manager, only if availability or purchasing risk is actually
relevant to the launch (e.g. a launch-critical ingredient with thin supply history). Multi-Branch
Operations Reviewer, only if scalability is explicitly the question being asked — not by default,
per its module's dormancy rule.

## Required shape

Same four-part separation as `product-readiness-review.md` (data completeness → app gate result
→ specialist assessment → orchestrator decision), plus:

- The system's core launch questions must all be addressed, explicitly, even if some answers are
  UNDETERMINED: Should we keep testing this product? Can it make money? Can we make it
  consistently? Is it safe and stable for its intended sale method? Is there sufficient buying
  signal? Is it ready for preorder or launch?
- A single VETO from any engaged specialist ends the council's recommendation at "not ready" —
  do not let a strong PASS from three specialists soften a fourth's VETO.
- If any required dimension (cost, taste, production, safety) is UNDETERMINED, the council's
  final verdict is UNDETERMINED for launch, not a partial "ready with caveats." Launch is a
  binary decision; readiness review for continued testing is not.

## Output

Always the full Final Orchestrator output (all 12 sections) — a launch decision is exactly the
case this structure exists for. Do not shortcut to a single specialist's output here even if only
one specialist ends up with anything blocking; the council format itself (showing all engaged
specialists' verdicts side by side) is part of what makes the decision trustworthy.
