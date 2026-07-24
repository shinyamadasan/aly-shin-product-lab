# Routing Rules

Determines which specialist module(s) `ORCHESTRATOR.md` engages for a given decision. Read
alongside `SPECIALIST_REVIEW_PROTOCOL.md`.

## Core rule

Use only the smallest relevant set of specialists. Six or seven independent opinions is not the
default output — it's the exception, reserved for a genuine cross-functional decision like a
full launch-readiness council. Most questions need one or two specialists.

## Single-domain routing

| Question is about | Route to |
|---|---|
| Costing, pricing, margin | Restaurant Accountant |
| Recipe flavor or technique | Product Development Chef |
| Ingredient behavior, shelf life, packaging stability, food safety, experimental design | Food Science & Quality Specialist |
| Batch workflow, labor time, waste, capacity, repeatability | Bakery Production Manager |
| Supplier, purchasing, pack size, stock, substitutions | Supply Chain Manager |
| KPIs, dashboards, trends, alerts | Business Intelligence Analyst |
| Branch standardization and expansion | Multi-Branch Operations Reviewer |

## Cross-functional routing

Use more than one specialist only when the decision creates a real trade-off across domains:

| Decision type | Specialists |
|---|---|
| Ingredient substitution | Product Development Chef + Food Science & Quality Specialist + Restaurant Accountant + Supply Chain Manager |
| Packaging change | Food Science & Quality Specialist + Supply Chain Manager + Restaurant Accountant |
| Recipe version readiness | Product Development Chef + Food Science & Quality Specialist + Bakery Production Manager |
| Launch readiness | Restaurant Accountant + Product Development Chef + Food Science & Quality Specialist + Bakery Production Manager, with Supply Chain Manager included only if availability or purchasing risk is actually relevant |

## Dormant by default

**Multi-Branch Operations Reviewer** stays out of the specialist set while the business remains
in home proofing, unless the current decision directly affects future scalability (e.g. a
recipe or process choice that would be hard to standardize across branches later). Don't include
it "just in case" — that's exactly the complexity `PRODUCT_LAB_CONTEXT.md` warns against at this
stage.

**Business Intelligence Analyst** is engaged only when the decision is genuinely about
dashboards, KPI tracking, or trend visibility — not as a default add-on to single-product
readiness questions, even though data quality is always relevant. If a readiness review turns up
a data-completeness gap, that's the Orchestrator's own "Data completeness" section, not
automatically a BI Analyst review.

## Fallback rule for anything not in the tables above

Map the decision's core question to the specialist whose domain owns that question. Add a second
specialist only when a real, specific trade-off crosses into a second domain — not by default,
and not "to be thorough." If it's genuinely unclear which single specialist owns a question, say
so in the Orchestrator's "Selected specialist modules and why" section rather than including
every plausible specialist to be safe.
