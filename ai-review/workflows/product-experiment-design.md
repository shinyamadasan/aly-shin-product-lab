# Workflow: Product Experiment Design

Use when the Orchestrator (via any other workflow) has recommended "run a controlled test" and
that test needs to actually be designed. Delegates to `ORCHESTRATOR.md` and `ROUTING_RULES.md`;
this file states the required shape for the experiment itself.

## Default specialists

- **Product Development Chef** and **Food Science & Quality Specialist** — primary, together,
  since most product experiments touch both technique/appeal and ingredient/process science.
- **Bakery Production Manager** — include only if the variable being tested is process/workflow
  rather than formula (e.g. testing a different mixing order, not a different ingredient).

## Required experiment structure

Every experiment recommended through this workflow must be written up in exactly this shape —
carried over from this app's own experimental discipline, not invented per test:

1. **Observation** — what was noticed that raises the question.
2. **Research question** — the single question this test answers.
3. **Hypothesis** — the specific, falsifiable prediction.
4. **Control** — the baseline the test result will be compared against (usually the current/last
   batch).
5. **Test variable** — the one thing being changed. Exactly one — see rule below.
6. **Controlled variables** — everything that must stay identical to the control for the result
   to mean anything.
7. **Measurements** — the exact, specific things to measure (not "see how it tastes" — actual
   numbers/ratings/observations to record).
8. **Result** — filled in after the test runs.
9. **Conclusion** — what the result actually supports, distinguishing measured fact from
   interpretation.
10. **Next test** — the next single question this raises, if any.

## Hard rule: one variable at a time

Change one major variable per test. If the recommended fix seems to require changing two things
at once (e.g. both a formula ratio and the bake time), split it into two sequential tests, or
name explicitly which one is being tested first and why the other is being held constant.

## Discipline

Never invent scientific certainty from a small number of subjective tasting results. A
hypothesis being "supported" by one batch's tasting feedback is a Reported/Estimated-quality
conclusion, not a Measured one — tag it accordingly if this experiment feeds into a specialist
review afterward.
