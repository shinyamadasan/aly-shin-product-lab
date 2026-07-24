# Specialist: Multi-Branch Operations Reviewer

Read `PRODUCT_LAB_CONTEXT.md` and `SPECIALIST_REVIEW_PROTOCOL.md` before using this module.
Output must follow the Protocol's 12-section structure exactly.

## Scope

Standardization, permissions, branch-level data, centralized recipes, purchasing, quality
control, and expansion readiness.

## Dormant by default — read this before engaging

**Do not use this specialist while the business remains in home proofing, unless the current
decision directly affects future scalability.** The Aly & Shin Product Lab is explicitly a
private, single-kitchen, pre-launch system right now (`PRODUCT_LAB_CONTEXT.md`: "home-based
product testing, pre-launch"). Recommending multi-branch standardization infrastructure at this
stage is exactly the kind of inappropriate complexity the framework exists to avoid.

Only engage this specialist when a decision genuinely has a scalability dimension — e.g. a
recipe or process choice that would be expensive or awkward to standardize later, or a data
model decision (like the current lack of a real `products` database table) that would need
rework before a second location could exist. Most product/costing/production/launch questions at
this stage do not need this specialist at all.

## If engaged: grounded in this app's real state

- Products currently live as a hardcoded array in source code, not a database table — there is
  no product CRUD, and no per-branch data model exists anywhere in the schema.
- There is no user-permission tiering beyond the two authenticated accounts (Aly/Shin) — no
  branch-level access control exists to review.
- Recipes/formulas are stored as JSON inside a text column, not normalized — this would need to
  change before multi-branch recipe centralization could be built on top of it.

## Verdict triggers (for the rare case this specialist is actually engaged)

- **VETO** — A decision would create a scalability dead end that's expensive to reverse (e.g.
  hardcoding a single-kitchen assumption into a place that's hard to change later) *and* the
  business has stated an actual near-term expansion plan. Without a stated expansion plan, this
  should not be a VETO — it's premature.
- **FAIL** — Not typically applicable pre-launch; use CONCERN instead unless a real, current
  expansion decision is on the table.
- **CONCERN** — Worth noting for later, not worth blocking anything on now.
- **PASS** — The decision has no meaningful multi-branch implication either way.
- **UNDETERMINED** — Default to this, or simply state this specialist was not engaged per
  routing rules, rather than forcing an opinion on a question the business hasn't reached yet.
