# Aly & Shin Product Lab — AI Review Framework

A reusable set of plain instruction files for getting a disciplined, evidence-based review of a
product decision (costing, an experiment, production, readiness, launch) out of Claude Code or
Codex — without spinning up autonomous agents or touching the app itself.

This is **not** the `AI-DEV-OS.md` / `WORKFLOW.md` / `tools/` system also present in this repo.
That system is build/deploy process automation (Claude plans, Codex builds, a Telegram-driven
pipeline) and is currently dormant. This framework is unrelated to it: it's for getting a
business/product decision reviewed, on demand, in a normal conversation.

**Layering:** Orchestrator (procedure + reconciliation) → Specialists (scope + verdict triggers)
→ Knowledge (domain expertise specialists reference rather than embed) → Workflows (pre-picked
specialist sets for recurring review types). Each layer only knows about the one below it, so
domain knowledge can grow (more product-specific `knowledge/*.md` files) without editing every
specialist that might eventually need it.

## How to invoke it

There is no slash command and no registered subagent here on purpose — "one orchestrator, not
seven autonomous agents" means these are files you point an assistant at, not agents that run on
their own. Works the same way in Claude Code and in Codex, since both can read a file by path.

**Claude Code**, at the start of a session:
> Using `ai-review/ORCHESTRATOR.md`, evaluate [your decision].

**Codex**, the same way:
> Read `ai-review/ORCHESTRATOR.md` and evaluate [your decision].

For a recurring task type, name the workflow directly instead — e.g. *"Using
`ai-review/workflows/launch-readiness-council.md`, evaluate whether Brownies is ready to
launch."* The Orchestrator will still read `PRODUCT_LAB_CONTEXT.md` first and select specialists
via `ROUTING_RULES.md` either way; naming a workflow just pre-picks sensible defaults for that
recurring situation.

## Folder map

```
ai-review/
  README.md                              — this file
  ORCHESTRATOR.md                         — the orchestrator: procedure, reconciliation rules, final output shape
  SPECIALIST_REVIEW_PROTOCOL.md           — shared output structure, verdict definitions, evidence-quality tags, discipline rules
  ROUTING_RULES.md                        — which specialist(s) a decision routes to
  specialists/                            — one file per specialist lens: scope + verdict triggers only
    restaurant-accountant.md
    bakery-production-manager.md
    product-development-chef.md
    food-science-quality-specialist.md
    supply-chain-manager.md
    business-intelligence-analyst.md
    multi-branch-operations-reviewer.md
  knowledge/                              — domain expertise specialists reference instead of embedding
    restaurant-accounting.md
    food-science.md
    brownie-science.md
    coffee-extraction.md
    packaging.md
    fda-guidelines.md
  workflows/                              — ready-made recipes for recurring review types
    costing-audit.md
    product-experiment-design.md
    production-review.md
    product-readiness-review.md
    launch-readiness-council.md
```

## Source of truth

`PRODUCT_LAB_CONTEXT.md` (repo root) is the business-context source of truth for every module in
this framework — business stage, roles, page purposes, workflow rules. This framework reviews
decisions against it; it never overrides it.

`RULE_ENGINE.md` (repo root, plus `RULES/`) is the deterministic-check source of truth. This
framework never recomputes a margin, yield, or any other rule the engine already defines — it
reads the engine's output as evidence and adds judgment on top. See
`ORCHESTRATOR.md`'s "App gate result" step.

## What this framework will not do

Per its own discipline rules (`SPECIALIST_REVIEW_PROTOCOL.md`): invent evidence, treat the Rule
Engine's app gates as definitive, recompute a deterministic rule instead of reading its output,
average conflicting specialist verdicts into one score, or recommend complexity inappropriate for
the current home-proofing stage. It will tell you when evidence is missing instead of guessing.
