# Business Context Builder — Signals & State Layer Review

**Reviews:** `planning/BUSINESS_CONTEXT_BUILDER_DESIGN.md`
**Question:** does the approved architecture need two new explicit deterministic layers — Business Signals and Business State?
**Status:** review only. No code, no implementation tasks, no redesign. Amendments are specified, not applied.

---

## 1. Executive verdict

**Split decision, and the split is not where the question assumed it was.**

| Proposal | Verdict |
|---|---|
| **Business Signals** as a *new layer* | **No** — the concept already exists as `Signal`. But **cross-domain signal composition is required**, and not as an enhancement: the approved design already specifies two cross-domain rules that have **no legal home under P11 as currently written**. This is closing a latent contradiction, not extending scope. |
| **Business State** as a first-class deterministic object | **No.** Of the eight proposed fields, zero justify a new persisted, versioned shape. Two are already facts, four are one-line selectors over signals, one is an owner-declared constant, and one (`highest-value opportunity`) is **uncomputable in this database at any level of effort**. |
| **The underlying need** — one shared definition of "what's wrong," reusable by dashboards, alerts, reports, and AI | **Real and currently unmet.** Solved by **named selectors** (pure accessors, no schema, no version, no digest) plus a **typed signal-id vocabulary**. Total schema cost: two fields. |

The decisive fact: **there is no sales, orders, revenue, or customer table anywhere in this schema.** 27 tables, zero commercial. A `BusinessState` claiming to describe "the business's current operating condition" would systematically overstate what the data supports — it would describe the condition of *product development*, and call it the business.

**Recommended addition, in full:** one composer stage, one new envelope field, one typed id union, one selectors module, and a digest split. Everything else in the request is either already handled or should stay with the AI.

---

## 2. What the current design already supports

Re-read before proposing anything. The approved design already covers more of this request than the framing suggests.

- **`Signal` is already the signal type.** `{ id, domain, severity, status: "pass" | "fail" | "insufficient_data", message, recommendation, provenance }` (§4.3). Severity-graded, provenance-carrying, and mapped 1:1 from `RuleResult`. A second "signal" type would be a synonym.
- **`DomainContext.signals`** already gives every domain a place to publish assessments — inventory health, pipeline health, and data quality are already listed as domain outputs in §3 (D6, D11, D6's `flaggedIngredients`).
- **The Rule Engine already is the signal engine** for the product domain: ~26 rules across six categories, severity-weighted, with `passed: null` for insufficient data and `nextBestAction` per product. §2 P4 already forbids reimplementing it.
- **§5 already permits ranking inside views** — *"A view is a projection with a budget. It selects, ranks, and truncates."* Ordering is not computation, so a ranked "what matters most" list is already architecturally legal without any new layer.
- **§4.5 `coverage`** already makes absence explicit, which is most of what a "state" object would be asked to report about itself.
- **Provenance (§4.2, §7)** already carries `inputs: string[]` — *fact paths this was computed from*. Cross-domain traceability is already designed for; it just has nothing producing it yet.

**Conclusion:** the vocabulary, the type, the traceability, and the ranking permission all exist. What is missing is a **place to stand** for a calculation that spans two domains, and a **stable name** for a signal so a dashboard can bind to it.

---

## 3. Business Signals assessment

### 3.1 The gap is real, and the approved design already fell into it

Two rules in the approved document cannot be implemented as written:

**D3 (Costing), Freshness:** *"A costing whose `updated_at` predates the latest `supply_entries`/`inventory_transactions` purchase for its ingredients is `stale` — this is the one domain where staleness is derivable from data rather than from a fixed budget, and it is the highest-value freshness signal in the system."*

**§2 P11:** *"An adapter reads only its own tables."*

The Costing adapter may not read `supply_entries` or `inventory_transactions`. So the highest-value freshness signal in the system, by the document's own assessment, **has no owner**. Same for D4's `snapshotDivergence` (selling-format snapshot vs current ingredient cost) and D5's willingness-to-pay-versus-price — the last of which the document already flags as *"cross-domain — composed at the envelope, not inside this adapter, per P11"* while never defining what "composed at the envelope" means, who does it, or where the result lives.

**This is not a speculative future need. Three already-specified outputs are unimplementable without it.**

### 3.2 What to add — and what not to

**Add:** a `SignalComposer` — a pure function over *finished domain contexts*, registered exactly like an adapter.

```
SignalComposer (pure)
  compose(domains: Readonly<Record<DomainId, DomainContext>>, env: BuildEnv) → Signal[]
```

It reads `DomainContext.facts`, never raw rows, never a client. This preserves P11 exactly as written — adapters read only their own tables; composers read only already-built facts — and it makes cross-domain provenance mechanical, because `inputs` names fact paths that already exist in the same snapshot.

**Do not add:** a distinct `BusinessSignal` type, a signal severity scale separate from the existing one, or a signal "engine" with its own rule DSL. The `Signal` type is correct; only its *owner* is new.

### 3.3 The gap nobody named: `Signal.id` is a free-form string

§4.3 types it as `id: string`. That is fine for a prompt renderer and fatal for a dashboard or an alert, both of which must bind to a stable identifier. A dashboard tile that string-matches `"inventory.expiring"` breaks silently when someone writes `"inventory.expiringSoon"`.

**Amend to a closed union** derived from a published constant, following the exact precedent already in this repo (`OPPORTUNITY_STATUSES`, `RECOMMENDATION_TYPES`, `CANONICAL_UNITS`):

```
SIGNAL_IDS = [ "FIN-001", …, "inventory.expiring", "costing.staleVsPurchases", … ] as const
SignalId = (typeof SIGNAL_IDS)[number]
```

Rule-Engine ids pass through unchanged; composed ids are namespaced. **Once published, a signal id is never renamed or re-meant — only deprecated.** This is the single cheapest thing in this review and the one that most directly serves "reusable by dashboards, reports, alerts, and AI."

Also add `subject?: { kind: "product" | "ingredient" | "costing" | "business"; id: string }` — a dashboard must be able to group signals by what they are *about*, and today `Signal` only records which domain emitted it.

---

## 4. Cross-domain signal ownership

**Both, with a hard line between them.**

| | Domain signals | Composed signals |
|---|---|---|
| Owner | `DomainAdapter` | `SignalComposer` |
| Reads | Its own raw rows | Finished `DomainContext.facts` only |
| Lives in | `domains[d].signals` | `BusinessContext.signals` |
| Provenance `inputs` | Paths within one domain | Paths across domains — **must name ≥ 2 domains** |
| Example | `inventory.outOfStock` | `costing.staleVsPurchases` |

**Testable invariant:** a composed signal whose `inputs` all resolve to a single domain is a defect — it belongs in that domain's adapter. This prevents the composer stage from becoming a dumping ground for logic that had a proper home.

**Composers never read rows.** If a composer needs a value no adapter publishes, the correct fix is to publish that fact from the owning adapter, not to widen the composer's reach. This keeps exactly one path from row to fact.

### 4.1 A correction to D3 that this exposes

`CostingEntry` (`src/lib/product-lab-types.ts`) has `ingredientName: string` and **no `ingredientId`**. There is no foreign key from a costing line to the ingredient master. So D3's freshness rule as written — *"the latest purchase **for its ingredients**"* — requires a name-based join through `ingredient-matching.ts`, which would make the signal `inferred` (confidence ≤ medium, `basis` required), not `calculated`.

**Recommended v1 scoping:** compare `costing.updated_at` against `max(inventory_transactions.created_at where transaction_type = 'purchase')` **business-wide**, not per-ingredient. Coarser, but genuinely `calculated`, no fuzzy join, and still answers the real question: *"this costing is older than your last shopping trip."* Per-ingredient precision becomes available if and when a real `ingredient_id` link exists on costing lines.

The approved document's D3 freshness paragraph currently over-promises. It should be corrected regardless of whether composers are adopted.

---

## 5. Business State assessment

### 5.1 Field-by-field, against the honesty test

The test: *can this be computed from data in this database, by a rule someone has actually stated, without inventing a model?*

| Proposed field | Computable? | Verdict |
|---|---|---|
| **current business stage** | No model exists. "Proving stage, pre-launch" is a **prose constant** in two hand-maintained strings (§1.1). Deriving it would require inventing stage boundaries no document defines. | **Owner-declared static fact.** Not derived. Belongs in the Brand/Business domain as an entered value, versioned — which is honest, and is already how it works. |
| **critical blockers** | Yes, trivially — `evaluateProduct` already returns `blockers`, rolled up across products. | **Already exists.** `signals.filter(s => s.severity === "blocker" && s.status === "fail")`. A **selector**, not state. |
| **active risks** | "Risk" decomposes into expiring stock, out-of-stock, stale costing, negative margin — each already a signal. | **Redundant.** A second name for a filter over signals. |
| **momentum** | Counts are computable (`contentDaysThisWeek` already exists; batches per 30 days). The **verdict label** ("good"/"stalled") requires a threshold nobody has defined. | **Split.** Publish counts and trends as facts. **Refuse the label.** |
| **current bottleneck** | Requires a throughput model and counterfactual reasoning. Neither exists. | **Rename, don't compute.** See §5.2. |
| **recently completed milestone** | Last completed batch, last asset created — both already facts in D2/D11. | **Already facts.** No new field. |
| **areas needing attention** | Signals grouped by domain. | **Selector.** |
| **highest-value opportunity / top priority** | **Structurally impossible.** See §5.3. | **AI-owned.** |

**Score: 0 of 8 fields justify a new first-class deterministic object.**

### 5.2 "Current bottleneck" — the trap, with evidence from this repo

A bottleneck is *the constraint that, if removed, most increases throughput.* That is a claim about a system with a measured flow rate. This app has no throughput model.

What **can** be computed is "the highest-severity finding under a stated ordering." That already exists: `scripts/daily-advisor/portfolio-ranking.ts`'s `rankPortfolio()` returns `topFinding` and `highestPriorityProduct`, ordered by an eight-tier `PORTFOLIO_TIER_ORDER`.

**And that ordering has already failed silently once, in production, in this repo.** From `classifyTier`'s own comment:

> *"Defensive net, found necessary by an independent review: any remaining ACTIVE blocker-severity result … must never fall through to `"improvement"`, the lowest tier. **That exact fallthrough is what silently buried DEV-001/DEV-002** before the explicit branch above was added."*

`scripts/daily-advisor/types.ts` is equally candid that the ordering is **"task-specified"** — handed down, not derived — and that it *"genuinely disagrees"* with the Rule Engine's own within-product ordering. Two defensible orderings, both correct for different questions, neither derivable from first principles.

So: a hand-ordered taxonomy, acknowledged as arbitrary, that has already buried the highest-severity signal in the system once. **Publishing its first element as `currentBottleneck` would launder a defensible sort order into an analytical claim about the business.** The name asserts far more than the computation earns.

**Recommendation:** publish `rankedFindings` and `highestSeverityFinding`, with the ordering **named and versioned** (`orderingId: "portfolio-tier-v2"`) so a consumer can see which ranking produced it. Let the AI say *"your bottleneck is X"* given that ranked evidence. That is exactly the division of labour the request asks for: deterministic evidence, AI interpretation.

### 5.3 "Highest-value opportunity" — decisive and worth stating plainly

Every table in the schema:

```
ai_reviews · asset_files · asset_job_attempts · asset_jobs · assets · batch_photos
brand_profiles · content_drafts · content_journal · costing_entries · costing_summaries
creative_job_attempts · creative_jobs · creative_packages · equipment · ingredient_aliases
ingredients · inventory_transactions · opportunities · product_batches · products
purchase_import_rows · purchase_imports · selling_format_packaging_lines · selling_formats
supply_entries · tasting_feedback
```

**No sales. No orders. No revenue. No customers.** The only price-adjacent numbers in the system are `suggestedPrice` (an intention), `sellingPrice` per format (an intention), and `willingToPay` from tasting panels (a stated hypothetical from a handful of friends and family).

"Value" cannot be estimated. Not approximately, not with a proxy, not with more rules. Any deterministic `highestValueOpportunity` would be a ranking of intentions dressed as a ranking of returns — and because it would be deterministic and traceable, it would be *trusted more* than a hedged AI judgement, not less. **That is the failure mode this whole architecture exists to prevent, arriving through the front door.**

This also constrains "business stage" and "momentum": a business whose commercial output is entirely absent from its database cannot have its *business* condition computed. It can have its *product-development* condition computed, which is genuinely valuable and should be named as such.

### 5.4 What replaces `BusinessState`: selectors

The real need behind the request is legitimate — dashboards, alerts, reports, and AI should not each re-derive "what are the blockers." But the answer is not a new persisted shape. It is **named pure accessors over a built context**:

```
src/lib/business-context/selectors.ts   — pure, no schema, no version, no digest
  getBlockers(context)            → Signal[]
  getSignalsByDomain(context)     → Record<DomainId, Signal[]>
  getInsufficientData(context)    → Signal[]
  getRankedFindings(context)      → { orderingId, findings: Signal[] }
  getContextQuality(context)      → { byState, byKind, byConfidence }   (§10's quality report)
```

Why this beats a `BusinessState` object on every axis that matters here:

- **Nothing to version** — a selector *is* the single definition; it cannot drift from itself.
- **Nothing to invalidate** — computed at call time from the snapshot in hand.
- **Cannot hide facts** — a selector returns references into the context; there is no parallel summary to disagree with the source.
- **Cannot silently rot** — no persisted shape means no stale copy, and no digest churn when a threshold is tuned.
- **Free to delete** — an unused selector costs nothing; an unused state field lives in every snapshot forever.

**Concrete recommendation:** promote `classifyTier`/`rankPortfolio` from `scripts/daily-advisor/` into `src/lib/`, unchanged, as the `getRankedFindings` selector. It is already pure, already tested, and already the exact "reusable across consumers" ranking the request describes — it is simply trapped in a worker script where the app, dashboards, and alerts cannot reach it. This is a **move, not a rewrite**; the daily advisor keeps importing it.

### 5.5 When to revisit

A flat "no" is less useful than a trigger. Reopen the `BusinessState` question when **either** holds:

1. **Sales or order data enters the schema.** "Value," "momentum," and "stage" all become computable the moment real commercial output is recorded, and a state object stops being a guess.
2. **The owner declares an explicit stage model** — named stages with stated entry criteria. Then `businessStage` becomes a *derived* fact against a real rubric rather than an invented one.

Until one of those, every field belongs to facts, selectors, or the AI.

---

## 6. Deterministic versus AI-owned decisions

The line: **deterministic systems answer "what is measured and by what rule"; AI answers "what does it mean and what should we do."**

| Question | Owner | Why |
|---|---|---|
| Which rules currently fail, at what severity | **Deterministic** | Rule Engine, already built |
| Which ingredients are out of stock / expiring | **Deterministic** | `inventory-status.ts`, exact |
| Which costings are unreadable or stale | **Deterministic** | Composed signal, exact comparison |
| Margin, food-cost %, break-even | **Deterministic** | `getCostingTotals`, arithmetic |
| Ranked list of active failures under a named ordering | **Deterministic** | `rankPortfolio` — *provided the ordering is named* |
| Counts and trends (batches/30d, content days/week) | **Deterministic** | Counting |
| How complete and fresh our data is | **Deterministic** | `Fact.state` census (§10) |
| **Which of three blockers to fix first, given limited time** | **AI** | Requires weighing effort against payoff; no effort data exists |
| **What the real bottleneck is** | **AI**, given ranked findings | Requires a throughput model the data cannot supply |
| **Whether momentum is good or bad** | **AI**, given counts | Requires a target cadence nobody has stated |
| **What stage the business is in** | **Owner**, declared | Not a measurement; a decision |
| **Highest-value opportunity** | **AI**, and it must be told revenue data is absent | Value is unmeasurable here |
| **Whether to launch** | **AI + owner**, given launch gates | `LAUNCH-001..004` supply evidence, not the verdict |

The rule that keeps this stable: **if answering it requires a threshold, a weighting, or a counterfactual that no document in this repo states, it is not deterministic — it is a hardcoded opinion wearing a function signature.**

---

## 7. Recommended revised architecture flow

```
Database
  → Domain Readers            (I/O, raw rows, nullability preserved)      [unchanged]
  → Domain Adapters           (pure; own tables only)                     [unchanged]
       ↓ DomainContext { facts, signals }
  → Signal Composers          (pure; read finished facts across domains)  ← NEW, one stage
       ↓ BusinessContext { domains, signals, factsDigest, signalsDigest }
  → Selectors                 (pure accessors; no schema, no version)     ← NEW, not a layer
  → Purpose-Specific Views    (project + rank + budget)                   [unchanged]
  → Renderer                                                              [unchanged]
  → AI                        (interprets: bottleneck, priority, stage, momentum)
```

Two additions, one of which is not a layer at all. `BusinessState` does not appear. The interpretive fields it was meant to carry are either facts (counts), selectors (blockers, ranked findings), owner-declared constants (stage), or AI output (bottleneck, priority, value).

---

## 8. Exact amendments to `BUSINESS_CONTEXT_BUILDER_DESIGN.md`

Targeted. Nine edits, one new short section. The document's structure, principles, and first milestone survive intact.

### 8.1 Sections that change

**§2 — Principles.** Amend **P11** and add **P12**:

> **P11 — Domains are independent.** *(existing text)* … Cross-domain facts and signals are composed by a **Signal Composer** (§8), never inside an adapter.
>
> **P12 — Composers read facts, never rows.** A composer receives finished `DomainContext` objects and may read only their published `facts`. If a composer needs a value no adapter publishes, the fix is to publish it from the owning adapter — never to widen the composer's reach. Exactly one path exists from row to fact.

Add **P13**:

> **P13 — No whole-business verdicts.** The builder publishes measurements, graded signals, and named rankings. It never publishes `bottleneck`, `topPriority`, `businessStage`, `momentum`, or `highestValueOpportunity` as computed facts. Each requires a threshold, weighting, or counterfactual that no document in this repo states; computing one converts a hardcoded opinion into an authoritative-looking claim. Interpretation is the AI's job, on top of this evidence.

**§3 D3 — Costing, "Freshness."** Correct the over-promise. `CostingEntry` has `ingredientName` but **no `ingredientId`**, so per-ingredient staleness needs a fuzzy name join and would be `inferred`. Scope v1 to a business-wide comparison of `costing.updated_at` against the latest `inventory_transactions` purchase timestamp — `calculated`, exact, no join. Note per-ingredient precision as available only if a real ingredient link is added to costing lines.

**§3 D4, D5 — cross-domain notes.** Retarget `snapshotDivergence` (D4) and willingness-to-pay-versus-price (D5) at the composer stage by name, replacing the current undefined phrase *"composed at the envelope."*

**§4.3 — `Signal`.** Three changes:

```
Signal = {
  id: SignalId                  // ← was `string`; now a closed union from SIGNAL_IDS
  domain: DomainId              // emitting domain, or "cross-domain"
  scope: "domain" | "cross-domain"          // ← new
  subject?: { kind: "product" | "ingredient" | "costing" | "business"; id: string }   // ← new
  severity: "blocker" | "warning" | "info"
  status: "pass" | "fail" | "insufficient_data"
  message: string
  recommendation: string
  provenance: Provenance
}
```

Plus the vocabulary rule: `SIGNAL_IDS` is a published `as const` array (precedent: `OPPORTUNITY_STATUSES`, `RECOMMENDATION_TYPES`, `CANONICAL_UNITS`). **A published signal id is never renamed or re-meant — only deprecated.**

**§4.5 — `BusinessContext`.** Two changes:

```
  signals: Signal[]        // ← new: cross-domain composed signals (scope === "cross-domain")
  factsDigest: string      // ← replaces `digest`: hash over facts only
  signalsDigest: string    // ← new: hash over domain + composed signals
```

Rationale for the split: `digest` currently means *"has the business changed?"* If signals share it, tuning a staleness threshold changes the digest while no business data moved, and the invalidation rule in §6 silently becomes wrong. Two digests answer two different questions — *has the data changed* and *has our reading of it changed* — and both are worth knowing.

**§5 — Views.** Two clarifications: a view may project `context.signals` alongside `domains[d].signals`; and any ranking must use a **named, versioned comparator** (carrying its `orderingId`), never an inline ad-hoc sort. Ranking remains projection, not computation — §5 already permits it.

**§6 — Freshness.** Update the invalidation rule to compare `factsDigest` (not `digest`).

**§9 — Versioning.** No fourth version number. Add the rules: adding a signal id is additive and free; removing or re-meaning one is a `contextSchemaVersion` bump; a comparator's `orderingId` is versioned in its own name (`portfolio-tier-v2`).

**§12 — First milestone.** See §9 of this review.

**§13 — Open owner decisions.** Add two:
- **Q10.** Should `businessStage` exist as an **owner-declared, entered** fact (with the current prose constant as its first value), rather than being derived or duplicated across two hand-maintained strings? This also resolves part of §1.1's drift problem.
- **Q11.** Who owns signal thresholds, and where are they reviewed? Every composed signal introduces one; §11's R14 is the failure mode if they accumulate unowned.

**§14 — Must never do.** Add item 16: *"Publish a whole-business verdict — bottleneck, top priority, business stage, momentum, or highest-value opportunity — as a deterministic fact."* Add item 17: *"Let a composer read raw rows, or a selector persist anything."*

### 8.2 New section

**§8.3 — Selectors** (short, inside the existing §8). Defines selectors as pure accessors over a built `BusinessContext`: no schema, no version, no digest participation, no persistence, returning references into the context rather than copies. Names the initial set (§5.4 above) and records that `getRankedFindings` is `rankPortfolio` promoted from `scripts/daily-advisor/`, unchanged, with the daily advisor continuing to import it.

**Explicitly no new top-level section for Business State.** Its absence is recorded in §11 as an anti-pattern with the two revisit triggers from §5.5.

### 8.3 Schema shapes that change

| Shape | Change |
|---|---|
| `Signal` | `id` → `SignalId` union; add `scope`, `subject?` |
| `BusinessContext` | add `signals: Signal[]`; `digest` → `factsDigest` + `signalsDigest` |
| `SIGNAL_IDS` | new published constant |
| `SignalComposer` | new pure-function contract in §8 |
| `DomainContext` | **unchanged** |
| `Fact` / `Provenance` | **unchanged** |
| `ContextView` | **unchanged** (may now project `context.signals`) |

`Fact` and `Provenance` — the load-bearing core — do not move at all.

### 8.4 Invariants to add (§10)

1. A composer receives no client and no clock; same `(domains, env)` ⇒ identical `Signal[]`.
2. A composed signal's `provenance.inputs` must resolve to **≥ 2 distinct domains**. One-domain inputs are a defect — the logic belongs in that adapter.
3. Every emitted `Signal.id` is a member of `SIGNAL_IDS`.
4. `factsDigest` is unchanged when only a signal threshold changes; `signalsDigest` changes.
5. A selector never mutates the context and never appears in a serialised artifact — it returns references, not copies.
6. Every signal with `severity: "blocker"` survives every view's budget (P7 already forbids dropping one; this makes it testable).
7. No `Signal` carries a field named `bottleneck`, `priority`, `stage`, `momentum`, or `value` — a cheap denylist guard against P13 eroding over time.

### 8.5 Tests to add (§10)

- **Composer purity** — same finished domains twice ⇒ identical signals.
- **Composer isolation** — the composer's type does not expose a client; passing raw rows is a type error.
- **Cross-domain input assertion** — invariant 2 above, over every composed signal.
- **Signal vocabulary** — every emitted id ∈ `SIGNAL_IDS`; no duplicates.
- **Digest independence** — tune a threshold in a fixture, assert `factsDigest` stable and `signalsDigest` moved.
- **Selector fidelity** — `getBlockers(ctx)` returns exactly the signals that satisfy the predicate in the full context; no additions, no reordering surprises.
- **Ranking stability** — a fixture with two equal-tier findings produces a deterministic order; the comparator's `orderingId` is recorded in the output.
- **Regression, ported from `portfolio-ranking.ts`** — an active blocker in an unhandled category must never land in the lowest tier. This is the DEV-001/DEV-002 bug the daily advisor already hit once; if the ranking is promoted to `src/lib`, its regression test comes with it.

---

## 9. Impact on the first milestone

**Keep the milestone. Add exactly one composed signal. Add no state, no selectors beyond one.**

The reason this is not scope creep: **the composer is already required by M1's own contents.** M1 ships Costing (D3), Inventory (D6), and Readiness (D13). D3's freshness rule — the design's self-declared *"highest-value freshness signal in the system"* — needs Costing's `updated_at` and Inventory's purchase timestamps from `inventory_transactions`. **Both domains are already in M1.** Under P11 as currently written, that signal cannot be built, so M1 would ship a documented rule it structurally cannot implement.

**Amended M1 (additions only, in bold):**

1. `types.ts` — `Fact`, `Provenance`, `Signal`, **`SignalId`/`SIGNAL_IDS`**, `DomainContext`, `BusinessContext`.
2. `supabase-mappers.ts` — nullability-preserving extraction. *(unchanged)*
3. Three adapters — Costing, Inventory, Readiness. *(unchanged)*
4. Envelope builder + coverage manifest, **plus the composer registry (one composer registered)**.
5. **One composed signal: `costing.staleVsPurchases`** — business-wide comparison per §4.1 above. Exercises the composer contract, cross-domain provenance, the id vocabulary, and the digest split, end to end.
6. **One selector: `getBlockers(context)`** — proves the accessor pattern without building the library.
7. Tests — as approved, plus composer purity, cross-domain input assertion, and digest independence.

**Still explicitly out of M1:** views, renderer, persistence, the other eleven adapters, `getRankedFindings` / the `rankPortfolio` promotion, and any `BusinessState`.

**Why one composed signal rather than zero or several.** Zero leaves the composer contract unproven until eleven adapters have already been written against a schema that may need to change to accommodate it — the exact "wrong cheaply, early" argument the approved milestone makes for the `Fact` envelope. Several would turn a spine milestone into a signal-authoring milestone, which is how R14's signal sprawl starts. One is the smallest thing that proves the contract.

Cost: roughly one pure function, one registry entry, one constant, three tests. It also closes a hole M1 would otherwise ship with.

---

## 10. Risks and anti-patterns

Additions to §11 of the design document.

**R13 — Bottleneck laundering.** Publishing the first element of a hand-ordered list as `currentBottleneck`, `topPriority`, or `highestValueOpportunity`. The name asserts throughput analysis; the computation is a sort. Because the output is deterministic and traceable, it will be trusted *more* than a hedged AI judgement — the precise inversion this architecture exists to prevent. **Mitigation:** P13; honest names (`rankedFindings`, `highestSeverityFinding`); `orderingId` in the output.

**R14 — Signal sprawl into a disguised recommendation engine.** Each individual signal is defensible; forty of them, each with an unowned threshold, is a rules engine nobody designed and nobody can reason about. The tell is thresholds accumulating with no owner and no review. **Mitigation:** every signal id published in `SIGNAL_IDS` with a stated threshold and rationale; Q11 assigns ownership; new signals are reviewed as schema changes, not as bug fixes.

**R15 — State that shadows facts.** Any summary object that consumers read *instead of* the facts will eventually disagree with them, and the disagreement will be invisible because the summary looks authoritative. **Mitigation:** no `BusinessState`; selectors return references into the context, never copies.

**R16 — Composer creep into a second adapter layer.** A composer that reads rows, or holds a client, or computes what one domain could have published, quietly becomes a parallel data path — and then there are two answers again. **Mitigation:** P12; invariant 2 (≥ 2 domains in `inputs`); the composer's type simply does not accept a client.

**R17 — Digest conflation.** Leaving signals inside a single `digest` makes §6's invalidation rule silently wrong: tuning a threshold would read as "the business changed." **Mitigation:** the `factsDigest` / `signalsDigest` split.

**R18 — Computing the business from product-development data.** Publishing `businessStage` or `momentum` from a database with no sales, orders, or customers describes product development and calls it the business. **Mitigation:** P13; `businessStage` as an owner-declared fact (Q10); the §5.5 revisit triggers.

---

## 11. Final recommendation

**Adopt cross-domain signal composition. Reject the `BusinessState` object. Replace it with selectors and one honest rename.**

The request correctly identified that something is missing — but it is smaller than a layer, and the part that felt most valuable is the part the data cannot support.

**What is genuinely missing and should be added now:**

1. A **`SignalComposer`** stage — required to implement three rules the approved design already specifies and currently cannot build.
2. A **typed `SIGNAL_IDS` vocabulary** plus `Signal.subject` — the actual prerequisite for dashboards and alerts, and the cheapest item here.
3. **Selectors** — one shared definition of "the blockers," reusable by every consumer, with no schema, no version, and nothing to invalidate.
4. The **`factsDigest` / `signalsDigest`** split — keeps "has the business changed?" answerable once interpretations exist.

**What should not be added, and why it is a rejection rather than a deferral:**

`BusinessState`'s eight fields resolve to two facts, four selectors, one owner-declared constant, and one field that is uncomputable in this database. Building the object would mean building `currentBottleneck` from an ordering this repo has **already watched fail silently in production**, and `highestValueOpportunity` from a schema with **no sales data of any kind**. Both would be deterministic, traceable, well-tested — and wrong in a way that is harder to notice precisely because of those properties.

The strongest version of the request's own instinct is this: *compute once, share everywhere, and let the AI reason.* Signals and selectors deliver that completely. A state object would deliver it for the measurable fields — which selectors already cover — while smuggling in the unmeasurable ones under the same authority.

**Preserve the boundary the design already draws.** It publishes what is measured, grades it by severity, ranks it under a named ordering, and states plainly what it does not know. The judgement of what matters most stays with the AI and the owner, where the evidence actually supports it being made.
