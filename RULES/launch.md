# Rule Category: Launch

Part of the Product Lab Rule Engine — see `RULE_ENGINE.md`. Unlike every other category, Launch
Rules are **composite gates** — they don't read raw data directly, they aggregate the results of
rules from the other five categories. They only run when a launch/preorder decision is actually
being evaluated (e.g. via `ai-review/workflows/launch-readiness-council.md`), not on every
routine dashboard load.

There is no category priority weight — Launch Rules aren't ranked against Financial/Quality/etc.
for `nextBestAction` purposes the way normal rules are. Instead, each Launch Rule's own failure
directly names which underlying rule(s) need to be resolved, and `nextBestAction` in a launch
context is always the highest-priority underlying blocker, not the Launch Rule itself.

---

### LAUNCH-001 — Required Data Complete

- **Purpose:** Confirm the minimum evidence set exists before a launch decision is even
  attempted — this is a data-completeness gate, separate from whether the evidence looks good.
- **Inputs:** Results of DEV-001 (batches), FIN-005 (selling price), PROD-001 (yield), and
  whether a costing exists at all.
- **Evaluation logic:** All four inputs must be Pass (not just non-Fail).
- **Pass:** Batches exist, yield is set, selling price is set, a costing is saved.
- **Warning:** Not applicable — this is a hard gate.
- **Fail:** Any input is missing.
- **Severity:** Blocker.
- **Output message:** *"Launch decision can't be evaluated yet — missing: {list of failing
  inputs}."*
- **Next action:** *"Resolve {highest-priority missing input} first."*

### LAUNCH-002 — Required Experiments Complete

- **Purpose:** Confirm the product has been through enough controlled testing to trust a launch
  call, not just enough batches to exist.
- **Inputs:** DEV-002 (customer tastings), DEV-005 (recipe locked), QUAL-001 (shelf-life test,
  when applicable), QUAL-003 (temperature test, when applicable).
- **Evaluation logic:** All applicable inputs (QUAL-001/QUAL-003 only apply when relevant per
  their own rules) must be Pass.
- **Pass:** All applicable inputs Pass.
- **Fail:** Any applicable input is Fail; DEV-002/QUAL-001/QUAL-003 at Warning keep this rule at
  Warning, not Fail, but still block per their own severities inside a launch context.
- **Severity:** Blocker.
- **Output message:** *"Launch readiness incomplete — {list of failing/warning inputs}."*
- **Next action:** *"Resolve {highest-priority input} — see its own rule for the exact next
  action."*

### LAUNCH-003 — No Blocking Financial Issues

- **Purpose:** The financial veto gate for launch — mirrors the Restaurant Accountant specialist
  module's VETO trigger exactly, so the deterministic rule and the AI specialist can never
  disagree about this specific fact.
- **Inputs:** FIN-001 (negative margin), FIN-005 (missing price), FIN-007 (target margin).
- **Evaluation logic:** Any Blocker-severity result among the inputs fails this rule.
- **Pass:** No Blocker-severity financial result.
- **Fail:** FIN-001 or FIN-005 at Blocker.
- **Severity:** Blocker.
- **Output message:** *"{product} cannot launch with a {margin}% margin at PHP {price} — see
  FIN-001."*
- **Next action:** *"Same as FIN-001's next action — fix pricing or cost before re-evaluating
  launch."*

### LAUNCH-004 — No Blocking Quality Issues

- **Purpose:** The quality/safety veto gate for launch — mirrors the Food Science & Quality
  specialist's VETO trigger exactly, for the same reason as LAUNCH-003.
- **Inputs:** QUAL-005 (food safety) always; QUAL-002 (packaging validation) and QUAL-001
  (shelf-life) escalate to Blocker specifically in this launch context even though their default
  severity elsewhere is Warning.
- **Evaluation logic:** Any Blocker-severity result among the inputs (using the launch-context
  escalated severities) fails this rule.
- **Pass:** No Blocker-severity quality result.
- **Fail:** QUAL-005 at Blocker, or QUAL-001/QUAL-002 at Fail with no test evidence at all.
- **Severity:** Blocker.
- **Output message:** *"{product} cannot launch — {failing quality rule}'s condition is
  unresolved."*
- **Next action:** *"Same as the failing quality rule's next action."*
