# Selling MVP — Implementation Plan (Revision 3)

> ## ✅ FROZEN — APPROVED FOR IMPLEMENTATION
>
> **Status:** Architecture approved and frozen at Revision 3. **Verdict: GO WITH PREREQUISITES.**
> Do not reopen or redesign the Selling MVP. Changes from here require an explicit owner decision
> recorded as a new revision in §0, not an in-place edit.
>
> **Both prerequisites (P1, P2) are satisfied — see "Implementation status" below. Implementation
> begins at S1.** Slices S1–S6 are the approved MVP scope; S7–S10 are planned, sequenced, and
> explicitly not authorised.

## Implementation status

> **Status annotations, not architectural revisions.** This section records what has changed in the
> *repository* since Revision 3 was frozen. It deliberately does not edit the frozen sections below,
> so the original reasoning stays readable as the historical record it is. Where a later section
> still describes P2 as future work, it carries a pointer back here rather than being rewritten.

**Last verified:** 2026-08-07, against `origin/main` @ `956c802de28b2a53632c1425501f1ea48503a3eb`.

| Prerequisite | Status | Evidence |
|---|---|---|
| **P1** — merge Business Context Builder M1 PR #4 | ✅ **Satisfied** | PR #30 merged `feat/business-context-m1-pr4` into `main` at `956c802`. `git merge-base --is-ancestor 97c6b2d origin/main` confirms it. BCB M1 is complete |
| **P2** — a timezone-aware business-day helper in `src/lib/` | ✅ **Satisfied — already present, no work required** | `src/lib/business-day.ts` was introduced by commit `c5e0ef2` ("feat(business-context): add raw row mappers, canonical types, digest, business day") as part of the M1 chain that satisfied P1 |

**P2 was satisfied as a side effect of P1, not by a separate change.** When Revision 3 was written, `origin/main` did not yet contain M1, and the finding recorded in §1 — *"the only correct implementation, `formatDateInTimezone`, is trapped in `scripts/daily-advisor/run.ts` and unreachable from the app"* — was true at that time. Merging M1 made it stale. The helper now exists:

- **`src/lib/business-day.ts`** exports `resolveBusinessDay(nowMs, timeZone): string`, returning `YYYY-MM-DD` via `Intl.DateTimeFormat("en-CA")`. Pure, reads no clock, and the timezone is always an explicit argument — exactly the behaviour P2 required.
- **`tests/business-day.test.ts`** already proves the Manila boundary in six tests, including `15:59Z → 2026-08-06` / `16:01Z → 2026-08-07` (the boundary is 16:00Z, not midnight UTC), the eight-hour Manila-vs-UTC disagreement, timezone-is-never-a-process-default, and no-DST across both solstices.

**Consequences for whoever implements this plan:**

1. **Do not create a second business-day helper**, and do not modify the existing one. Selling code calls `resolveBusinessDay` from `src/lib/business-day.ts`.
2. **There is no P2 code PR.** §15's PR-A is already delivered by the M1 merge — see the note in that section.
3. **The `getToday()` prohibition still stands in full.** `src/lib/lab-state.ts`'s `getToday()` remains UTC-based and is still forbidden in Selling code. P2 being satisfied means the *correct* helper exists, not that the *incorrect* one was removed.
4. **One known duplicate is deliberately left alone.** `scripts/daily-advisor/run.ts` still carries its own identical `formatDateInTimezone`, and `src/lib/business-day.ts` documents why it does not import from that file (`run.ts` is a CLI entry point importing `node:path`/`node:util`; importing it from `src/` would pull node builtins into the browser bundle). Deduplicating it — having `run.ts` import from `src/lib/`, which is the sanctioned direction — is a valid, small, separate change. **It is not part of this plan and must not be bundled into any Selling slice.**
5. **Implementation proceeds to S0 (isolation and baseline), then S1.** The only remaining prerequisite is this document's own registration in the repository, so that the approved architecture is available in-repo per `AGENTS.md`'s Architecture Protection rule.

**S0 was executed on 2026-08-07** against `956c802`, producing this measured baseline — recorded here so a later slice can compare against a number rather than a prediction:

```
npm test          1719 tests · 1716 pass · 2 fail · 1 skipped
npx tsc --noEmit  0 errors
npm run lint      1 error, 0 warnings
```

The 2 failures are both in `tests/creative-package-asset-create.test.ts` (`[static] … resolveBrief`, `[static] … uploadImage`) and are the CRLF line-ending fixture artifact documented in `planning/BUSINESS_CONTEXT_BUILDER_M1-IMPLEMENTATION-PLAN.md` §2.2 — not code defects. The 1 lint error is pre-existing at `main`: `src/components/bake-page.tsx:58`, `react-hooks/set-state-in-effect`. **The acceptance gate for every Selling slice is exactly these 2 test failures, 0 type errors, and exactly this 1 lint error — never "all green."** None of the three is to be fixed by Selling work.

> ### ⚠ Environment-specific baseline note — measured 2026-08-08 during S7 PR-G1
>
> **The known-failure count is environment-dependent. It is not universally 4.**
>
> On the **Windows / `core.autocrlf` checkout** this work was done in, a clean `origin/main`
> @ `b35b488` — no S7 files present, `git status` clean — produces:
>
> ```
> npm test          2103 tests · 2098 pass · 4 fail · 1 skipped
> npx tsc --noEmit  0 errors
> npm run lint      1 error, 0 warnings          (unchanged: bake-page.tsx:58)
> ```
>
> Of those four:
>
> - **Two are the previously known fixture failures** in `tests/creative-package-asset-create.test.ts`
>   (`[static] … resolveBrief`, `[static] … uploadImage`) — the artifact already documented above.
> - **Two are additional line-ending-sensitive S9 static tests**:
>
>   | Test | File it reads |
>   |---|---|
>   | `no website-user credential can reach client code` (`tests/public-order-form.test.ts`) | `src/components/public-order-form.tsx` |
>   | `the server credential module is server-only and its secrets are not public` (`tests/public-submission.test.ts`) | `src/lib/supabase-server.ts` |
>
>   Both perform an anchored first-line match such as `/^"use client";$/` and receive
>   `'"use client";\r'`. The files are committed with LF and rewritten with CRLF **in the working
>   tree** by autocrlf on checkout; `file src/components/public-order-form.tsx` reports *"with CRLF
>   line terminators"*.
>
> **This is a checkout artifact, not a security regression and not a code defect.** The server-only
> boundary is unchanged and still verified in Production. **An LF checkout or a CI runner may
> continue to show only the original 2 failures** — that is expected, not a discrepancy to
> reconcile, and neither count should be hardcoded as *the* repository baseline.
>
> **The acceptance rule is therefore comparative, not absolute: a Selling slice must add zero new
> failures relative to a clean `origin/main` run in the same environment**, alongside 0 type errors
> and the single known lint error. Measure the baseline in your own environment before judging a
> slice; do not carry a number across environments.
>
> Proven pre-existing rather than assumed: both tests fail identically with every S7 file removed and
> the tree clean. S7 PR-G1 reports **2138 · 2133 pass · 4 fail · 1 skip** in this environment —
> exactly +35 tests and +35 passes, zero new failures.
>
> **Not fixed in G1.** The repair is a repo-wide `.gitattributes` / renormalisation change touching
> S9 files, out of scope for a Selling read-layer slice and deserving its own review.

---

## Context

Aly & Pon is about to take its first real bakery orders. The app (`05_App_And_Tech/aly-shin-product-lab`) currently proves products — batches, costing, tasting, inventory, readiness — and has **zero** concept of a customer, order, sale, payment, or revenue. Verified: no such table, type, or function exists anywhere in `src/`, `scripts/`, or the 40+ `supabase-*.sql` files.

That gap is the reason `BUSINESS_CONTEXT_BUILDER_DESIGN.md` §P13 forbids the builder from ever publishing a "highest-value opportunity": *"this schema contains no sales, order, revenue, or customer table, so commercial value is not measurable here at any level of effort."* The Selling MVP is the work that changes that — and §12.1's first reconsideration trigger is literally "sales or order data enters the schema."

**Owner decisions taken in planning:** 5 order states · revenue recognized on payment received · customers as their own table, required on every order · MVP scope = record → fulfil (slices S1–S6).

**Revision history.** R1 = first draft. **R2** = seven review findings resolved (§0.1). **R3** = three final integrity corrections before freeze (§0.2). Every section below is the revised text, not a diff.

---

## 0. Change log

### 0.2 Revision 3 — final corrections before freeze

Three targeted integrity corrections. **No architectural change.** The domain model, slice plan, scope, and verdict are unchanged from Revision 2.

| # | Correction | Decision | Sections changed |
|---|---|---|---|
| **C1** | The refunded invariant did not require `paid_amount`, and `paid_amount` had no sign constraint | **Accepted.** `refunded` now requires `paid_at` **and** `paid_amount` **and** `refunded_at`. Added `orders_paid_amount_nonnegative`. **This also closes a real hole in §6.1:** without `paid_amount` guaranteed present on a refunded order, `refunds(range)` could sum a NULL and silently overstate net revenue | §4.2, §5.2, §6.1, §11.1, §13, §14 (S1) |
| **C2** | `save_order` did not enforce parent–child ownership | **Accepted.** Every submitted line must carry the `order_id` being saved (raises on mismatch); the delete is scoped `and order_id = v_order_id` so a foreign id cannot be deleted even if passed. Referential integrity, not business logic — and the exact shape `apply_inventory_adjustment` already uses for its cross-payload identity check | §11.4, §13, §14 (S1, S2), §16 |
| **C3** | The divergence UX implied that editing lines meant money was received | **Accepted.** "Update recorded payment" is removed. The banner is informational only; the sole action is **"Correct payment record"**, which asserts the prior record was *wrong* and is pre-filled from the **recorded** payment, never from the current total. A changed order total never alters a payment fact. Actual additional money is a **second payment** — unsupported in MVP, and the documented trigger for the deferred `payments` table | §5.2, §10, §16, §17 |

### 0.1 Revision 2 — seven review findings resolved

| # | Finding | Decision | Sections changed |
|---|---|---|---|
| **1** | `pieces_per_unit` not snapshotted; S7's "to prepare" breaks once `selling_format_id` goes null | **Accepted.** Add nullable `pieces_per_unit_snapshot`. NULL means *not recorded*, never 1 and never 0 | §4.3, §7, §11, §13, §14 |
| **2** | Revenue required `status != 'cancelled'`, contradicting "cancellation does not change payment" | **Accepted.** `status` removed from the revenue definition entirely. Revenue is defined over payment **timestamps**, never over current lifecycle state | §5.2, §6, §16 |
| **3** | `refunded_at` missing; refund timing unknowable and revenue retroactively mutable | **Accepted.** Add `refunded_at`. `paid_at` is never cleared by a refund, so a past period's gross revenue is immutable | §4.2, §5.2, §6, §11 |
| **4** | Revenue computed from mutable current lines is untrustworthy after payment | **Accepted, via snapshot.** Add authoritative `paid_amount`, frozen at `paid_at`. Revenue reads it and never touches lines. Line edits on a paid order stay legal but surface the divergence | §4.2, §4.3, §6, §10, §16 |
| **5** | Sequential order + lines writes | **Reversed.** `save_order` RPC ships in **S1/S2**, not after an incident. An order is one logical transaction and a *partial* line write is invisible, not visibly broken | §11, §12, §14, §15, §16 |
| **6** | `source = 'manual'` conflates acquisition channel with record-entry method | **Accepted, plus a tightening.** Split into `source` (default **`unknown`**) and `entry_method`. **`repeat` also removed from the source union** — it is derivable from order count and must not be an entered value that can disagree | §4.2, §8, §16 |
| **7** | `quantity numeric` permits nonsense like 2.5 boxes | **Accepted.** `integer not null default 1 check (quantity > 0)` | §4.3, §11, §13 |

Everything not listed above is unchanged from Revision 1.

---

## 1. Executive Decision

**GO WITH PREREQUISITES.**

**What the Selling MVP contains.** Three new tables (`customers`, `orders`, `order_lines`), one atomic `save_order` RPC, one pure domain module (`src/lib/orders/`), one repository module, one new nav entry `/orders` with a list + inline detail + new-order form. Manual order entry only. Order lifecycle, payment, pickup/delivery, and channel attribution all ship in the first pass.

**What it does not contain.** No inventory writes of any kind. No finished-goods stock. No reservations. No customer accounts, logins, loyalty, discounts, or subscriptions. No payment gateway. No Lead entity. No separate payments or fulfillment tables. No sales analytics. No coupling to Content, Opportunities, or Creative Packages.

**Where it lives.** One new top-level nav item **Orders** at `/orders`, rendered through `ProductLab` (`view: "orders"`) so it stays behind the existing `LoginScreen` session gate — exactly how `/opportunities` is wired. The page component lives in `src/components/orders-page.tsx` and fetches its own data through a repository module. It does **not** join `LabState`.

**Is the repository ready?** Yes. The schema conventions, the repository idiom, the atomic-RPC template, the pure-calculator discipline, the double-submit guard, the test harness, and the reference-gated-delete pattern all already exist and are directly reusable. Nothing has to be invented.

**Prerequisites that must land first:**

> **Status (2026-08-07): both are satisfied.** See "Implementation status" above. The table below is the frozen Revision 3 text; the "Why" for P2 describes the repository as it stood before M1 merged and is retained as historical reasoning. **Do not implement P2 — it already exists.**

| # | Prerequisite | Why | Size |
|---|---|---|---|
| **P1** ✅ | Merge Business Context Builder M1 **PR #4** (`feat/business-context-m1-pr4` @ `97c6b2d`, slice S9) | Owner's own priority #1. Selling must branch from a `main` that is not mid-milestone. Selling does not otherwise depend on it | Merge only — **done, PR #30 @ `956c802`** |
| **P2** ✅ | Extract a timezone-aware business-day helper into `src/lib/business-day.ts` | `getToday()` (`src/lib/lab-state.ts`) is **UTC**. Manila is UTC+8, so a 7am order is dated *yesterday* for the first eight hours of every working day. The only correct implementation, `formatDateInTimezone`, is trapped in `scripts/daily-advisor/run.ts` and unreachable from the app. Orders must never use `getToday()` | ~30 lines + test, own PR — **no longer required; delivered by P1 via commit `c5e0ef2` as `resolveBusinessDay`, with `tests/business-day.test.ts`. The `getToday()` prohibition is unaffected and still binding** |

---

## 2. Current Repository Findings

Verified against the working tree at `feat/unsaved-changes-protection` (`ba8d471`), `origin/main` (`5972b21`), and the `.worktrees/bcb-m1` checkout. Facts, not assumptions.

### 2.1 Nothing selling-related exists

A repo-wide search for `order|sale|sales|customer|contact|lead|payment|revenue|fulfillment|delivery|pickup|checkout|transaction|selling|campaign|source|attribution` returns only: `sortOrder`/`sort_order` (display ordering), `wouldReorder` (a tasting question), `recommendedAction`/`OpportunitySourceType` (the Opportunity pipeline), `inventory_transactions` (the raw-ingredient ledger), `selling_formats` (pack sizes and prices on a costing), and "customers" in brand prose.

**Selling is genuinely greenfield.** There is no structure to extend, only structures to reference.

### 2.2 The entity chain Selling must attach to

```
products (id TEXT)              ← human slug for seeded rows, UUID string otherwise
   └─ product_batches (uuid)    ← one real kitchen test; usable_pieces recorded, not stocked
        └─ costing_summaries    ← FK batch_id ON DELETE SET NULL
             └─ selling_formats ← FK costing_id ON DELETE **CASCADE**
                  └─ selling_format_packaging_lines
```

**`products.id` is `text`, not `uuid`.** Any FK from an order line must be `product_id text references products(id)`. Getting this wrong fails the migration.

**`selling_formats.costing_id` is `ON DELETE CASCADE`.** Deleting a costing silently deletes its selling formats — including `name`, `selling_price`, and `pieces_per_unit`. **This is the most important finding in this document:** a hard FK from `order_lines` to `selling_formats` would let a routine costing cleanup destroy financial history, and *any* fact an order line needs that lives only on that row must be snapshotted (§4.3, finding 1).

### 2.3 Selling formats already model pack sizes and prices — correctly

`selling_formats(costing_id, name, pieces_per_unit, selling_price, is_active, sort_order)` plus `selling_format_packaging_lines`. `getSellingFormatMetrics()` (`src/lib/selling-formats.ts`) computes cost/profit/margin and takes `baseProductionCostPerPiece` as a **parameter** rather than recomputing it — with an explicit comment: *"there is deliberately no second base-cost formula."* Selling consumes this, never re-derives it.

Scoping consequence: a format is owned by a **costing**, owned by a **batch version**. "Box of 6 Brownies" as costed for V3 and for V4 are two different rows with two different ids.

### 2.4 Inventory deducts at Bake, and there is no finished-goods stock

- `applyBakeConfirmation` (`src/lib/bake-confirm.ts`) is the single implementation of ingredient consumption: `transaction_type: 'consume'`, `source_type: 'bake'`.
- `product_batches.usable_pieces` is an `integer` yield record with no ledger and no balance.
- `inventory_transactions` tracks **raw ingredients only**.

No table anywhere answers "how many brownies do I have right now."

### 2.5 Two data-access idioms; the newer one is right for this

| | `LabState` monolith | Repository modules |
|---|---|---|
| Where | `loadSupabaseData()` in `src/app/product-lab.tsx` (7,862 lines) | `opportunity-review.ts`, `creative-packages.ts`, `assets.ts`, `asset-jobs.ts` |
| Shape | 18 tables loaded eagerly into one object | Narrow injected `client` type per module |
| Failure | `isXTableMissing` boolean | `{ ok: true, … } \| { ok: false, reason: "missing-table" \| "failed", message }` |
| localStorage mirror | Yes | No |

Opportunities, Creative Packages, Assets and Asset Jobs are **not** in `LabState`. `BUSINESS_CONTEXT_BUILDER_DESIGN.md` §1.6 calls the repository idiom "strictly better for this boundary."

### 2.6 Schema conventions, verified across 40+ migration files

- File named `supabase-add-<feature>.sql`, idempotent, purely additive.
- `id uuid primary key default gen_random_uuid()`; `created_at`/`updated_at timestamptz not null default now()`.
- **Classification columns are plain `text` with no CHECK constraint** — the TypeScript union is the source of truth (`docs/DATA_MODEL.md`). Narrow deliberate exceptions exist where ambiguity caused real bugs (`ingredients.base_unit`) or for numeric sanity (`pieces_per_unit > 0`, `selling_price >= 0`, `quantity > 0`).
- RLS enabled, `grant … to authenticated`, one `for all … using (true) with check (true)` policy.
- Guarded `do $$ … raise …` preflight blocks verifying column shape and aborting on mismatch (`supabase-add-opportunities.sql`).
- **`updated_at` is not trigger-maintained anywhere.** Finding F1 of the M1 plan: only `opportunities` and (since PR0) `costing_summaries` write it from the app payload.

### 2.6b The atomic-RPC template — five existing instances, one shape

`confirm_bake`, `confirm_purchase_import`, `apply_inventory_adjustment`, **`save_supply_with_inventory_effect`**, `complete_asset_job_with_files`. Every one: `language plpgsql security invoker`, takes **already-computed `jsonb` payloads**, validates payload *shape* with `raise exception`, applies the writes, and contains **zero business logic** — `docs/ARCHITECTURE.md` (Milestone 5) is explicit that the pure functions in `src/lib` "remain the only place those rules are decided."

`save_supply_with_inventory_effect` is the direct precedent for an atomic composite **save** (not merely a ledger confirm), which is exactly the `save_order` case (§11, finding 5).

### 2.7 App architecture facts

- Entire app is `"use client"`; Supabase is called from the browser with the anon key. **No server execution boundary exists.**
- Auth is real: `supabase.auth.signInWithPassword`; `ProductLab` returns `<LoginScreen>` when there is no session.
- Routes are thin: `src/app/<name>/page.tsx` renders `<ProductLab view="…" />`. Nav is `navItems` in `src/lib/lab-state.ts`; titles in `src/components/app-shell.tsx`.
- Sub-page consolidation precedent: `inventory-tabs.ts` + `resolveInventoryTab(searchParams)` + `route-redirects.ts`.
- `createMutationGuard` (`src/lib/mutation-guard.ts`) is the established synchronous double-submit guard, written after a real double-click doubled a bake deduction.
- Reference-gated delete: `canDeleteProduct`/`getProductReferenceCount` (`product-safety.ts`), `canHardDeleteItem` (`inventory-safety.ts`).
- Client-generated stable ids: `resolveCostingId()` mints the id once per save so an upsert reconciles instead of inserting a duplicate.
- Save-time reconciliation: `getRemovedSellingFormatIds` / `getRemovedSellingFormatPackagingLineIds` compute "what disappeared" so the save is upsert-current + delete-missing.
- Tests: `node --test tests/*.test.ts`, ~110 files, pure-function-first, hand-built stubs. **Schema tests assert against the migration file's text.**
- "No answer" is already a first-class union member elsewhere, not a null: `MatchMethod`'s `"none"`, `getExpirationStatus`'s `"none"`.

### 2.8 Business Context Builder M1 is essentially complete

`src/lib/business-context/` is on `main`. PR0–PR3 merged (#26–#29). **PR4 (S9) is committed on `feat/business-context-m1-pr4` @ `97c6b2d`, unmerged.** `DOMAIN_IDS` is a closed 14-value array with no selling member; adding one is additive per design §9.

### 2.9 Assumptions, stated as assumptions

Order volume is tens per week. Payment is cash / GCash / bank transfer, settled out-of-band, **one payment per order**. One operator; no multi-user concurrency. Delivery is self-performed and ad-hoc.

---

## 3. Existing Domain Integration

| Existing domain | How Selling integrates | What Selling must never do |
|---|---|---|
| **Products** | `order_lines.product_id text references products(id) on delete set null` — a pointer for analysis, not the line's identity | Change `Product`, its status union, or `product-safety.ts` |
| **Batches** | **No relationship at all.** A batch is a kitchen test; an order is a sale | Add `batch_id` to an order or a line |
| **Costing** | Read-only, through `selling_formats`. A format supplies the *suggested* price and `pieces_per_unit`; the order snapshots both | Write to `costing_summaries`, or recompute a price |
| **Inventory** | **Zero writes.** §7 | Touch `ingredients` or `inventory_transactions` |
| **Business Context Builder** | Deferred slice S8: a `selling` domain adapter. Enabled now by nullability-preserving row mappers (design §1.3) and by `paid_amount` being an unambiguous financial fact | Bypass the adapter contract or publish a whole-business verdict (P13) |
| **Content / Creative / Opportunities** | **No FK, no import, no shared module.** One opaque `source_ref` string | `import` anything from `opportunities.ts`, `creative-jobs.ts`, or `content-drafts.ts` |

The Launch Offer page (`LaunchOfferBuilder`) is a **non-functional stub** — a `<form>` with no `action` and no persistence. Selling must not be built inside it, and must not delete it.

---

## 4. Proposed MVP Domain Model

```
customers
    │  1
    │  N
  orders ─── payment: payment_status · payment_method · paid_at · paid_amount* · refunded_at
    │    ├── fulfilment: fulfillment_method · fulfillment_at · address · notes
    │    └── attribution: source · source_ref · entry_method
    │  1
    │  N
order_lines ──▶ products        (nullable pointer, ON DELETE SET NULL)
            └─▶ selling_formats (nullable pointer, ON DELETE SET NULL)
                + item_name · unit_price · pieces_per_unit_snapshot   ← authoritative
```

`*` `paid_amount` is the one frozen money value. Everything else about money is computed.

### 4.1 `customers`

**Purpose.** The minimum identity needed to associate orders with a person and make "repeat buyer" computable without a later migration and backfill. Not a CRM.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | |
| `name` | `text not null` | The only required field |
| `phone` | `text` | Optional |
| `messaging_handle` | `text` | Optional — most orders arrive via Messenger, where a display name is the real identifier |
| `email` | `text` | Optional |
| `notes` | `text` | Optional |
| `created_at` / `updated_at` | `timestamptz not null default now()` | `updated_at` written by the app payload (§2.6) |

**No unique index on name or phone** — real people share names and change numbers, and a unique constraint would surface as a raw Postgres error on a legitimate save. Duplicate detection is a **UI warning** at entry time (`findConflictingSellingFormatName`'s "check before the round-trip" approach), never a hard block.

**Source of truth.** The customer row is the identity; the order never snapshots the name. A renamed customer correctly shows the new name on historical orders — a name is not a financial term.

### 4.2 `orders`

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | **Client-mints it once per form** (`resolveOrderId`, mirroring `resolveCostingId`) — the duplicate-submission defence |
| `customer_id` | `uuid not null references customers(id) on delete restrict` | Reference-gated delete, matching `canDeleteProduct` |
| `status` | `text not null default 'new'` | `new \| confirmed \| ready \| completed \| cancelled` |
| `payment_status` | `text not null default 'unpaid'` | `unpaid \| paid \| refunded` |
| `payment_method` | `text` | `cash \| gcash \| bank_transfer \| other`; null until paid |
| `paid_at` | `timestamptz` | When money arrived. **Never cleared by a refund** (finding 3) |
| **`paid_amount`** | `numeric` | **NEW (finding 4). The authoritative revenue figure**, frozen at `paid_at`. Never recomputed from lines |
| **`refunded_at`** | `timestamptz` | **NEW (finding 3).** When money left. A full refund of `paid_amount` |
| `fulfillment_method` | `text not null default 'pickup'` | `pickup \| delivery` |
| `fulfillment_at` | `timestamptz` | Agreed handover time; null = not scheduled yet |
| `fulfillment_address` | `text` | Meaningful only for delivery |
| `fulfillment_notes` | `text` | |
| **`source`** | `text not null default 'unknown'` | **CHANGED (finding 6).** Acquisition channel. Default is `unknown`, never `manual` |
| `source_ref` | `text` | Opaque, never joined, never parsed |
| **`entry_method`** | `text not null default 'manual'` | **NEW (finding 6).** How the record entered the app: `manual \| website`. Constant today by design |
| `notes` | `text` | |
| `placed_at` | `timestamptz not null default now()` | When the order was taken; editable (backfilling yesterday's order is normal) |
| `completed_at` / `cancelled_at` | `timestamptz` | Set by the transition, null otherwise |
| `cancel_reason` | `text` | |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

**No CHECK constraints on `status`, `payment_status`, `payment_method`, `fulfillment_method`, `source`, or `entry_method`** — repo convention; TS unions are the source of truth. This is what makes adding `preparing`, `pending`, or a new channel a one-line TypeScript change with zero migration.

**Three CHECK constraints, deliberately** — the money invariants, and only those (**C1**):

```sql
constraint orders_paid_fields_present
  check (payment_status <> 'paid'
         or (paid_at is not null and paid_amount is not null)),

constraint orders_refund_fields_present
  check (payment_status <> 'refunded'
         or (paid_at is not null and paid_amount is not null and refunded_at is not null)),

constraint orders_paid_amount_nonnegative
  check (paid_amount is null or paid_amount >= 0)
```

**Why `paid_amount` belongs in the refund predicate (C1).** A refund is the reversal of a payment, so the payment's amount must still be on the row — otherwise `refunds(range) = Σ paid_amount where refunded_at ∈ range` (§6.1) sums a NULL, that order contributes nothing to the refund total, and **net revenue is silently overstated by exactly the refunded amount**. The constraint makes the second revenue formula total by construction rather than by convention.

**Why the nonnegative check is written `is null or >= 0`.** NULL is legitimate — an unpaid order has no amount — so a bare `>= 0` would reject every unpaid order. The nullable-safe form mirrors `order_lines.unit_price >= 0` while leaving the unset case alone. A negative `paid_amount` has no meaning: money going out is a refund, recorded by `refunded_at`, not by a negative payment.

These constrain a *relationship between columns*, not a classification's domain, so they do not contradict §2.6's convention — and they are safe in a way `ingredients_base_unit_check` was not: this is a brand-new table, so no row can ever be created in violation, so the whole-row revalidation documented in `docs/DATA_MODEL.md` can never block an unrelated update. All three predicates tolerate a future `pending` status without modification.

**No `order_code`.** At tens of orders a week the operator identifies an order by customer + date. A `bigint generated by default as identity` column is the additive fix when it is actually wanted.

**Indexes.** `orders(status)`, `orders(customer_id)`, `orders(placed_at desc)`, `orders(payment_status)`, **`orders(paid_at)`**, **`orders(refunded_at)`** — the last two because §6's revenue query filters on them, not on `payment_status`.

### 4.3 `order_lines`

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | |
| `order_id` | `uuid not null references orders(id) on delete cascade` | A line has no life without its order |
| `product_id` | `text references products(id) on delete set null` | Nullable pointer. **`text`, not `uuid`** (§2.2) |
| `selling_format_id` | `uuid references selling_formats(id) on delete set null` | Nullable pointer. `set null`, never cascade (§2.2) |
| `item_name` | `text not null` | **Snapshot. Authoritative for display** |
| `unit_price` | `numeric not null check (unit_price >= 0)` | **Snapshot. Authoritative for the quote.** Full precision, never rounded before storage |
| **`pieces_per_unit_snapshot`** | `numeric check (pieces_per_unit_snapshot > 0)` | **NEW (finding 1). Nullable.** Copied from `selling_formats.pieces_per_unit` for a catalog line. **NULL means "not recorded," never 1 and never 0** |
| **`quantity`** | `integer not null default 1 check (quantity > 0)` | **CHANGED (finding 7).** Discrete selling units |
| `sort_order` | `integer not null default 0` | |
| `note` | `text` | |
| `created_at` | `timestamptz not null default now()` | |

**Why `pieces_per_unit_snapshot` (finding 1).** Revision 1 snapshotted the name and the price but left the pack size behind on a row that is explicitly allowed to disappear. That was an incomplete application of its own principle. Deleting a costing cascades its `selling_formats` away (§2.2), and with them the only record that "Box of 6" meant six — so `2 × Box of 6 = 12 pieces` becomes permanently uncomputable for every historical order. The rule, stated properly: **any fact an order line needs for later computation, which lives only on a row the line points at with `ON DELETE SET NULL`, must be snapshotted onto the line.** Today that set is exactly `{name, unit_price, pieces_per_unit}`.

**Why nullable, and why NULL ≠ 1.** A manual line ("delivery fee") has no pieces. A product line with a hand-entered price may or may not — the operator has not said. Defaulting either to 1 would invent data, which is precisely the `""`/`0` flattening trap of design §1.3. NULL is `unset`; consumers must report it as unknown rather than assume (§7).

**Three legitimate line shapes**, mirroring the catalog-vs-manual split the packaging-line UI already uses:

| Shape | `product_id` | `selling_format_id` | `pieces_per_unit_snapshot` | Meaning |
|---|---|---|---|---|
| Catalog | set | set | set | A real product in a real costed format |
| Product | set | null | usually null | A known product at a hand-entered price |
| Manual | null | null | null | A delivery fee, or an item not in the catalog |

**Stored vs computed money — the line, drawn precisely.** Revision 1 said "no stored totals anywhere." Revision 2 keeps that for totals and makes one principled exception:

| Value | Stored? | Why |
|---|---|---|
| `line_total` | **No** | `unit_price × quantity`. Derived at all times, with no distinguished moment |
| current order total | **No** | `getOrderTotals(lines)`. The live quote; changes legitimately whenever lines change |
| **`orders.paid_amount`** | **Yes** | **Not a derived total — an observed financial event** with a distinguished moment (`paid_at`). Freezing it records a fact; it does not cache a computation |

This is the same line the repo already draws one table over: `unit_cost_snapshot` is frozen ("what this cost when we bought it") while `costPerPiece` is always computed.

### 4.4 What is deliberately not a table

| Considered | Decision | Reopen when |
|---|---|---|
| `payments` | **Columns on `orders`** | Deposits or partial payments happen (see §5.2's payment-correction note) |
| `fulfillments` | **Columns on `orders`** | Never, at this scale — a second fulfilment *status* could contradict `orders.status` |
| `leads` | **Deferred** | Recorded interest that never becomes an order needs counting |
| `order_status_history` | **Deferred** | A dispute or an analysis needs to know when a status changed |
| `finished_goods` | **Deferred** | §7 |
| `refunded_amount` | **Deferred** | A partial refund happens. Until then a refund is full and its amount is `paid_amount` |

---

## 5. State Machines

### 5.1 Order status — 5 states

```
new ──────▶ confirmed ──────▶ ready ──────▶ completed  (terminal)
 │              │   └────────────────────────▶│
 └──────────────┴──────────────┬──────────────┘
                               ▼
                          cancelled  (terminal)
```

| From | Allowed to |
|---|---|
| `new` | `confirmed`, `cancelled` |
| `confirmed` | `ready`, `completed`, `cancelled` |
| `ready` | `completed`, `cancelled` |
| `completed` | — terminal |
| `cancelled` | — terminal |

`confirmed → completed` is allowed directly because handing an order over on the spot is real.

**Prohibited, and why.** No backward transitions, no resurrection from a terminal state. A mis-click is repaired by **editing the order's fields and lines** (still permitted on a terminal order, labelled in the UI as a correction to a completed record) — not by moving it back through the machine, which would make `completed_at` a lie.

**Implementation.** `isValidOrderTransition(from, to): boolean` and `applyOrderTransition(order, to, now)`, which sets `status` **and** its matching timestamp together so the two can never disagree. Pure; `now` is a parameter.

### 5.2 Payment status — 3 states, independent of lifecycle

```
unpaid ──▶ paid ──▶ refunded  (terminal)
   ▲         │
   └─────────┘   correction only: the claim "money arrived" was false
```

| Transition | Writes | Notes |
|---|---|---|
| `unpaid → paid` | sets `paid_at`, **`paid_amount` = `getOrderTotals(lines).total` at this instant**, `payment_method` | The single moment revenue is created |
| `paid → refunded` | sets `refunded_at`; **retains `paid_at` and `paid_amount`** — both are required by `orders_refund_fields_present` (C1) | Money did arrive, then left. Both are historical facts, and `paid_amount` is what `refunds(range)` sums |
| `paid → unpaid` | clears `paid_at`, `paid_amount`, `payment_method` | **Correction, not refund** — see below |
| `unpaid → refunded` | — | **Prohibited.** There is nothing to refund |
| `refunded → *` | — | Terminal |

**Correction vs refund — the distinction that makes history trustworthy.** A *refund* means the recorded fact was true and was later reversed; history is preserved and net revenue moves in the refund's period. A *correction* means the recorded fact was false; history is rewritten, because it should never have said what it said. Only corrections rewrite the past, and only ever to remove something untrue.

**Payment is fully independent of order status (finding 2).** A `new` order can be prepaid; a `completed` order can be unpaid; a `cancelled` order can still be paid until an actual refund is recorded. **Cancelling an order writes nothing to any payment field.** The UI prompts *"this order was paid — record a refund?"* and the operator decides; if they decline, the money is still counted as received, which is the truth.

**Editing lines on a paid order (finding 4, corrected by C3).** Permitted, and **never changes a payment fact — silently or otherwise.** `paid_amount` is frozen; nothing about editing lines may write to it.

**A changed order total is not evidence that money moved.** The order detail therefore surfaces the divergence as *information only*:

> Paid ₱480 on 9 Aug · current total ₱540 · ₱60 difference
> This does not change what was received.

There is exactly one action, and it is deliberately not a reconciliation: **"Correct payment record."** It asserts that the previously recorded payment fact was *wrong*, and it is **pre-filled from the recorded payment (`paid_amount`, `paid_at`), never from the current total.** The operator types the corrected values. Auto-filling from the current total was removed in C3 — it is the same automatic reconciliation wearing a different label, and it would quietly encode "the lines changed, therefore the payment changed," which is false.

**If the customer genuinely sent more money later, that is a second payment**, and the MVP does not model it. Recording it by re-stamping `paid_amount`/`paid_at` would destroy the first payment's date and misstate both periods' revenue. This is the documented trigger for the deferred `payments` table (§4.4, §17) — not something to work around in the UI.

A hard prohibition on editing lines was rejected: it is unenforceable below the UI (no server boundary; RLS is `using(true)`), and it would block legitimate non-financial edits such as fixing a note. Freezing `paid_amount` achieves the real goal — payment facts are immutable except by explicit correction — with a rule the schema can actually hold.

### 5.3 Fulfillment — no state machine

`fulfillment_method` is an attribute; `fulfillment_at` is a time. The *state* of fulfilment is `orders.status` — `ready` means made and waiting, `completed` means handed over. **There is deliberately no second status field here.** This is the largest simplification in the plan and the one most likely to be eroded later.

---

## 6. Revenue Definition

**Revenue is recognized when payment is received, is read from a frozen amount, and is defined over payment timestamps — never over lifecycle state and never over current order lines.**

### 6.1 The invariant

```
grossRevenue(range)  = Σ orders.paid_amount
                       where paid_at is not null and paid_at ∈ range

refunds(range)       = Σ orders.paid_amount
                       where refunded_at is not null and refunded_at ∈ range

netRevenue(range)    = grossRevenue(range) − refunds(range)

── receivables, a separate question ──────────────────────────────
unpaidOrderValue     = Σ getOrderTotals(lines).total
                       where payment_status = 'unpaid'
                         and status <> 'cancelled'

`range` boundaries are Manila days, via src/lib/business-day.ts. Never getToday().
```

Three properties follow, and each answers one review finding:

- **Lifecycle status appears nowhere in the revenue formulas (finding 2).** Cancelling an order cannot move revenue by a centavo. The `status <> 'cancelled'` clause moved to `unpaidOrderValue`, which is its correct home: cancelling changes what you are *owed*, never what you *received*.
- **A past period's gross revenue is immutable (finding 3).** `paid_at` is never cleared by a refund, so a September refund reduces September's net and leaves August's gross untouched. Without `refunded_at` this was impossible: the only record of when money left would have been `updated_at`, overwritten by the next unrelated edit.
- **Revenue never reads a line (finding 4).** `paid_amount` was frozen when money arrived. Editing lines afterwards cannot rewrite what was banked. `getOrderTotals(lines)` remains the calculator for the live quote and for receivables — two clearly separated numbers with two clearly separated jobs.
- **Both sums are total by construction (C1).** `orders_paid_fields_present` guarantees a `paid` order has a `paid_amount`; `orders_refund_fields_present` guarantees a `refunded` order still has one. Neither `Σ` can encounter a NULL, so neither can silently under-count. Without the second guarantee, a refunded order missing its amount would contribute nothing to `refunds(range)` and **net revenue would be overstated by exactly the refunded amount** — a wrong number that looks entirely plausible.

### 6.2 Which number answers which question

| Question | Source |
|---|---|
| What should this customer pay? | `getOrderTotals(lines)` — live |
| How much did we actually receive? | `orders.paid_amount` — frozen |
| How much are we owed? | `getOrderTotals(lines)` over unpaid, non-cancelled orders |
| Did we receive it this week? | `paid_at`, in Manila days |
| Did we give it back? | `refunded_at` + `paid_amount` |

### 6.3 How the Business Context Builder should read it (deferred slice S8)

A `selling` domain adapter under `src/lib/business-context/adapters/` reads raw rows with nullability preserved and publishes `Fact<T>` values: `grossRevenueToDate`, `netRevenueThisWeek`, `unpaidOrderValue`, `orderCountByStatus`, `unitsByProduct`, `piecesByProduct`, `orderCountBySource`, `repeatCustomerCount`.

> **⚠ OWNER-APPROVED DEVIATION — the fact list above is superseded. Approved 2026-08-08, implemented in S8.**
>
> The eight facts named here were specified before S7 existed and before S9 revealed the repeat-buyer
> defect. S8 ships a different set, explicitly approved by the owner rather than absorbed silently:
>
> | Frozen fact | S8 disposition |
> |---|---|
> | `grossRevenueToDate` | Replaced by `grossPaidRevenueToday` + `grossPaidRevenueRolling7d`. Computable, but outside the shared S7 summary boundary; publishing it would mean adding aggregation that exists only for S8 |
> | `netRevenueThisWeek` | Replaced by `netRevenueRolling7d` — S7's window is a rolling 7 days ending today, not a calendar week, so the frozen name would misdescribe it |
> | `unpaidOrderValue` | Kept as `unpaidReceivableValue`, renamed so it can never be read as revenue |
> | `orderCountByStatus` | Replaced by five named operational counts: `newAwaitingConfirmation`, `confirmedNeedingScheduling`, `readyForHandover`, `remainingHandoversToday`, `overdueHandovers` |
> | `unitsByProduct` / `piecesByProduct` | **Deferred.** S7 computes them truthfully including the null-pack-size rule; held back because a collection fact adds per-member provenance obligations |
> | `orderCountBySource` | Kept as `orderCountBySourceRolling7d`, normalized to a complete keyed object |
> | `repeatCustomerCount` | **Excluded.** S9 derives a customer id per logical public order, so every public customer has exactly one order; the metric undercounts and worsens as the channel grows |
>
> Added with no frozen counterpart: `ordersPlacedToday`, `ordersPlacedRolling7d`, and the two
> sanitized provenance basis facts `orderBasis` / `orderLineBasis` that the existing Business Context
> provenance invariants require.
>
> **The three disciplines below are unchanged and were implemented as written.** So is every §6
> financial semantic: gross is the frozen `paid_amount` selected by `paid_at` with no lifecycle
> filter, refunds are dated by `refunded_at`, and the receivable is never revenue. S8 reuses
> `buildSellingSummary` rather than re-implementing any of them.

Three disciplines carry over unchanged from M1:

- **`paid_amount` null ⇒ the order simply is not in the paid set.** No `known(0)`, no imputation.
- **`pieces_per_unit_snapshot` null ⇒ `piecesByProduct` is `unknown` for that line**, and the fact carries the count of lines it could not resolve. Never silently 1, never silently 0 (design §1.3).
- **Measurements only.** No `topProduct`, no `bestChannel`, no momentum verdict — P13 holds even once sales data exists. Any ranking requires a versioned `orderingId`.

---

## 7. Inventory Boundary

**Zero inventory writes. Selling imports nothing from `bake-confirm.ts`, `bake-deduction.ts`, `stock-adjustment.ts`, `inventory-status.ts`, or `inventory-cost.ts`** — enforced structurally, the same way `stock-adjustment.ts` imports nothing from `costing.ts`.

| Order event | Inventory effect |
|---|---|
| created / confirmed / ready / completed / cancelled | **none** |

**Why this is correct, not lazy.**

1. **Ingredients are already consumed at Bake.** The brownie being sold was baked days ago; selling it consumes nothing further. An order-time deduction would **double-count** against Bake and corrupt the one number the entire Inventory subsystem exists to protect.
2. **There is no finished-goods inventory to decrement.** `usable_pieces` is a yield record with no ledger and no balance.
3. **Building one is a second inventory system** — its own transaction types, reversal semantics, negative-stock policy, and reconciliation. The whole scope of Inventory Milestones 1–6 again, and not needed to take the first orders.

**Reservations are explicitly not built.** A reservation system without finished-goods stock has nothing to reserve.

**The read-only "to prepare" readout** (deferred to S7, spelled out here because finding 1 exists to serve it):

```
unitsToPrepare(product)  = Σ quantity
piecesToPrepare(product) = Σ quantity × pieces_per_unit_snapshot
                             over lines where pieces_per_unit_snapshot is not null
piecesUnknownLines       = count of lines where it is null
```

over `confirmed` orders with `fulfillment_at` inside the window. Pure, zero writes. **A line with no pieces snapshot is reported in `piecesUnknownLines`, never treated as one piece** — the same "insufficient data, never a guess" discipline as the Rule Engine's `passed: null` and Costing's "Need yield."

**Future work, named and separated.** A `finished_goods` ledger keyed on (product, selling format), credited by Bake's `usable_pieces` and debited on order completion, is the only correct place for availability and reservations. Its own milestone, with the same append-only, reversal-not-deletion discipline.

---

## 8. Source / Attribution Foundation

Three columns on `orders`, and the split between two of them is the point.

```ts
// Where the order came from. NOT how it was typed in.
export const ORDER_SOURCES = [
  "unknown", "facebook", "instagram", "tiktok", "messenger",
  "website", "referral", "direct",
] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

// How the record entered the app. Constant today by design; "website" arrives with S9.
export const ORDER_ENTRY_METHODS = ["manual", "website"] as const;
export type OrderEntryMethod = (typeof ORDER_ENTRY_METHODS)[number];
```

**Finding 6, resolved.** Revision 1 defaulted `source` to `manual`, which is a category error: `manual` describes the *record-entry method*, not the *acquisition channel*. A customer who found Aly & Pon on Instagram and was typed in by hand would have been attributed to "manual" — silently, by default, destroying exactly the attribution the design exists to enable. The two concepts are now two columns.

**The default is `unknown`, not `manual` or blank.** Explicit ignorance beats a false attribution. `unknown` is a real union member, not a null — matching `MatchMethod`'s `"none"` and `getExpirationStatus`'s `"none"`, which this repo already uses for "no answer" as a first-class value.

**`repeat` removed from the union — a tightening beyond the review.** "Repeat customer" is not an acquisition channel; it is `count(orders) per customer > 1`, already computable from `customers` + `orders`. Publishing it as an *entered* value creates a second answer that can disagree with the data — exactly what design P4 forbids ("reuse the calculation, never restate the number"). `direct` covers "they just messaged me, no campaign involved." Repeat-buyer status is derived at read time.

**`source_ref`** — `text`, **opaque, never joined, never parsed for meaning**. Holds a content id, a campaign tag, a referrer's name, or a post URL. This mirrors the repo's existing attribution idiom: `opportunities` pairs a typed `source_type` with an opaque `source_id`.

**Why this survives the future CTA.** `alyandpon.com/order?source=instagram&content=POST-184` lands as `source = "instagram"`, `source_ref = "POST-184"`, `entry_method = "website"` — **zero migration**, and the three facts stay distinct. When Content→Order is genuinely built, a real `source_content_id uuid references content_drafts(id) on delete set null` is added additively; `source_ref` remains the historical record.

**Deliberately not built:** `campaign_id`, `medium`, UTM decomposition, multi-touch attribution, a `channels` table.

---

## 9. Customer Experience Path

**Today (MVP).**

```
Customer messages Aly on Messenger / IG / in person
   → operator opens /orders → "New order"
   → types customer name (picks existing, or creates inline)
   → adds lines from the sellable menu (price and pieces-per-unit pre-filled and snapshotted)
   → picks pickup or delivery, sets a time
   → picks the acquisition source (defaults to Unknown, deliberately)
   → Place order                        ▸ status: new         (one atomic save_order call)
   → customer agrees                    ▸ Confirm
   → GCash arrives                      ▸ Mark paid   ← paid_at + paid_amount frozen here
   → baked and boxed                    ▸ Mark ready
   → handed over                        ▸ Complete
```

**Future (not built here).**

```
Content / CTA with ?source=instagram&content=POST-184
   → public order page ────────────────┐
                                       ▼
                  the same customers / orders / order_lines
                  the same save_order RPC
                                       │
   operator manual entry ──────────────┘
                                       ▼
        one lifecycle · one payment model · one revenue invariant
```

**Why the public surface plugs in without rewriting Orders.** Everything a customer-submitted order needs already exists: `customers` requires only a name; `orders` defaults to `new`/`unpaid`; `source`/`source_ref`/`entry_method` already carry the channel; `order_lines` already supports the catalog shape; `save_order` already writes an order and its lines atomically. A submitted order is a row with `entry_method = 'website'` that enters the same list in the same `new` state.

**The one real prerequisite, named now.** The app has **no server-side execution boundary** — everything is `"use client"` with the anon key, and `docs/ARCHITECTURE.md` already flags this as the missing piece for any non-first-party writer. A public page must not get blanket `anon` insert rights on `orders`. The correct shape is a Next.js Route Handler validating and inserting server-side. Distinct milestone (roadmap step #4); the data model costs nothing extra when it arrives.

---

## 10. UI / UX Plan

**Navigation.** One new `navItems` entry (`src/lib/lab-state.ts`) after **Costing** — Orders belongs with the money pages:

```
… Proof Batches · Costing · Orders · Equipment · Inventory · Journey …
```

Plus one `LabView` member (`"orders"`), one `titles` entry in `app-shell.tsx`, one dispatch line in `product-lab.tsx`, and `src/app/orders/page.tsx` reading `?tab=` through `resolveOrdersTab` (a direct copy of `resolveInventoryTab`'s shape, so the deferred S7 tab needs no new route).

**One page, two panes** — the `opportunities-page.tsx` shape:

```
┌─ Orders ─────────────────────────────┬─ Detail ─────────────────────────┐
│ [New] [Confirmed] [Ready] [All]      │  Maria Santos · Instagram        │
│                                      │  Sat 9 Aug · Pickup 2pm          │
│ ▸ Maria Santos   Sat 2pm  ₱480 ●     │  ────────────────────────────    │
│   Brownies ×1 Box of 6  (6 pcs)      │  Brownies, Box of 6  ×1    ₱480  │
│ ▸ Ana Cruz       Sun 10am ₱240 ○     │       6 pcs/unit · 6 pieces      │
│ ▸ Ben Reyes      today    ₱120 ⟲     │  ────────────────────────────    │
│                                      │  Current total             ₱480  │
│                ● paid ○ unpaid       │  Paid 9 Aug                ₱480  │
│                ⟲ refunded            │                                  │
│                                      │  [Confirm] [Ready] [Complete]    │
│                                      │  [Mark paid] [Cancel] [Edit]     │
└──────────────────────────────────────┴──────────────────────────────────┘
```

When lines are edited after payment, the detail pane states the divergence as **information**, and the only action is an explicit correction — never a reconciliation (**C3**):

```
  Current total   ₱540
  Paid 9 Aug      ₱480      ⚠ ₱60 difference

  This does not change what was received.
                                          [Correct payment record]
```

"Correct payment record" opens a small form pre-filled with the **recorded** `paid_amount` and `paid_at` — **never with the current total**. Its help text names the two cases plainly, so the operator cannot use it for the wrong one:

> Use this only if the payment was recorded incorrectly.
> If the customer actually sent more money, that is a second payment — not supported yet.

**New Order form — minimum fields, in tab order.**

| Field | Default | Notes |
|---|---|---|
| Customer | empty, autofocused | Combobox over existing customers; typing a new name offers "+ Create" — the inline-create idea Costing already uses for equipment |
| Line: item | — | `<optgroup>` by product, options are that product's active selling formats (the `batchesByProduct` pattern `CostingForm` and `BakePage` share). A "Custom item…" option produces a manual line |
| Line: qty | `1` | **Integer stepper**, min 1 (finding 7) |
| Line: price | pre-filled from `selling_formats.selling_price`, editable | Editing is normal, not an override — the snapshot is what was charged |
| *(pieces/unit)* | auto | Copied from the format, shown read-only beside the line, **never typed** |
| Fulfilment | `Pickup` | Address appears only for Delivery |
| When | blank | Blank is allowed ("not scheduled yet") |
| Source | **`Unknown`** | Deliberately not pre-guessed (finding 6) |
| Notes | blank | |

Running total updates live from `getOrderTotals` — **no "calculate" button**, per `PRODUCT_LAB_CONTEXT.md`'s standing rule.

**Fast entry.** Autofocus on customer; Enter adds another line; the form is submittable without touching the mouse. Status actions are single-click, with a confirm only for **Cancel** (prompts about a paid order) and **Complete** (terminal).

**Mobile.** Panes stack; detail becomes a full-width card; status actions render as a sticky action row.

**Unsaved-changes guard.** The form reports dirty state through the existing `onDirtyChange` / `setActiveUnsavedForm` contract that Costing, Batch, Ingredient, Supply, and Purchase Import already use — the seventh consumer, not a new mechanism.

---

## 11. Database / Migration Plan

**One file: `supabase-add-orders.sql`.** Idempotent, purely additive, no existing table altered, no existing row touched — the `supabase-add-selling-formats.sql` template.

**Order within the file:** `customers` → `orders` → `order_lines` → indexes → guarded shape preflight → `save_order` RPC → RLS → grants → policies.

### 11.1 Constraints

| Kind | Where | Why |
|---|---|---|
| FK `on delete restrict` | `orders.customer_id` | Reference-gated delete, matching `canDeleteProduct` |
| FK `on delete cascade` | `order_lines.order_id` | A line has no life without its order |
| FK `on delete set null` | `order_lines.product_id`, `order_lines.selling_format_id` | §2.2 — a costing cleanup must never destroy financial history |
| `check (unit_price >= 0)` | `order_lines` | Mirrors `selling_price >= 0` |
| **`check (quantity > 0)` on `integer`** | `order_lines` | **Finding 7** — discrete selling units; 2.5 boxes is unrepresentable |
| **`check (pieces_per_unit_snapshot > 0)`** | `order_lines` | **Finding 1** — nullable; when present it is a real pack size, never 0 |
| **`orders_paid_fields_present`** | `orders` | **Finding 4** — `paid` implies `paid_at` and `paid_amount` |
| **`orders_refund_fields_present`** | `orders` | **Findings 3 + C1** — `refunded` implies `paid_at` **and `paid_amount`** and `refunded_at`, which is what makes `refunds(range)` in §6.1 total by construction |
| **`orders_paid_amount_nonnegative`** | `orders` | **C1** — `paid_amount is null or paid_amount >= 0`. NULL stays legal for an unpaid order; a negative payment has no meaning (money out is a refund) |
| **No CHECK on any classification column** | `status`, `payment_status`, `payment_method`, `fulfillment_method`, `source`, `entry_method` | Repo convention; TS unions are the source of truth |

### 11.2 Indexes

`orders(status)`, `orders(customer_id)`, `orders(placed_at desc)`, `orders(payment_status)`, `orders(paid_at)`, `orders(refunded_at)`, `order_lines(order_id)`.

### 11.3 Guarded preflight

A `do $$ … raise …` block verifying the three tables' column names, types, and nullability against the approved shape, aborting on mismatch — the `supabase-add-opportunities.sql` pattern. This is what stops a stale draft table from silently diverging.

### 11.4 RPC — `save_order`, shipping in S1/S2 (finding 5, reversed from Revision 1)

```sql
create or replace function save_order(
  p_order           jsonb,        -- buildOrderPayload's exact shape
  p_lines           jsonb,        -- array of buildOrderLinePayload's shape
  p_removed_line_ids uuid[]       -- getRemovedOrderLineIds' output
) returns void
language plpgsql
security invoker
```

Validate payload shape → **enforce parent–child ownership** → upsert the order by id → upsert every submitted line by id → delete the removed ids, scoped to this order. One `plpgsql` body, atomic by default.

**Parent–child ownership enforcement (C2).** The RPC must not be able to write or delete another order's lines, even if handed ids that belong to one:

```sql
v_order_id := (p_order->>'id')::uuid;   -- raises if absent

-- 1. Every submitted line must belong to the order being saved. Loud: a mismatch
--    here is unambiguously a caller bug, never a legitimate state.
for v_line in select * from jsonb_array_elements(p_lines) loop
  if nullif(v_line->>'order_id','') is null
     or (v_line->>'order_id')::uuid is distinct from v_order_id then
    raise exception 'Order line does not belong to the order being saved';
  end if;
end loop;

-- 2. The delete is *scoped*, not merely validated: a foreign id passed here
--    matches nothing and is ignored rather than deleting another order's line.
delete from order_lines
 where id = any(p_removed_line_ids)
   and order_id = v_order_id;
```

**Why the two halves differ deliberately.** The write path **raises** — a submitted line carrying the wrong `order_id` is a bug with no benign reading, and failing loudly (rolling the whole transaction back) is correct. The delete path **scopes** instead, because `p_removed_line_ids` can legitimately contain an id that no longer exists, and raising on that would turn a harmless retry into a failure. Scoping handles the foreign id and the already-gone id identically and safely: the query simply matches nothing.

**This is referential integrity, not business logic.** It is exactly the cross-payload identity check `apply_inventory_adjustment` already performs — *"Ingredient mismatch between ingredient update and transaction"* — so it is the established shape in this repo, not a new responsibility being smuggled into SQL. No order-state rule, no payment rule, no total, and no validation beyond identity and payload shape lives here; all of that stays in `src/lib/orders/`.

**Why Revision 1 was wrong to defer this.** The deferral rested on "an order with no lines shows ₱0 and is visibly broken." That is only true for a *total* failure. A three-line order that persists two lines is **not** visibly broken — it looks like a complete, smaller order with a plausible wrong total. That is silent corruption of the commercial record, which is the same failure class the ledger RPCs exist to prevent. The edit path is worse still: a save is upsert-plus-delete (`getRemovedSellingFormatIds`' shape), so a mid-sequence failure can delete lines without inserting their replacements.

Three further reasons:

1. **The repo already regretted this exact deferral once.** Inventory M2–M4 shipped sequential writes documented as "a known, accepted non-atomicity," and M5 had to come back and wrap them. Repeating a known-cost deferral is not boring architecture.
2. **The cost is genuinely small.** Five instances of this template already exist (§2.6b), including `save_supply_with_inventory_effect` — a composite *save*, not merely a confirm. This is a sixth instance of a well-trodden shape, not new architecture.
3. **`save_order` contains no business logic**, matching every existing RPC: the app computes the payload; the function validates *shape* with `raise exception` and applies the writes. All order-state, payment-state, total, and validation rules stay in `src/lib/orders/`.

**Status and payment updates stay plain `update` calls** — single-row writes are already atomic; wrapping them would be ceremony.

**Trust boundary, unchanged and restated.** `save_order` does not re-validate business rules, exactly as `confirm_bake` does not re-check insufficient stock. This app's RLS already grants authenticated users unrestricted access (`using (true)`), so the RPC trusts the application layer for the same reason and with the same documented caveat — and the same future hardening applies if a non-first-party writer is ever introduced (§9).

### 11.5 RLS

Enabled on all three tables. `grant select, insert, update, delete … to authenticated`, `grant execute on function save_order … to authenticated`. One `for all to authenticated using (true) with check (true)` policy per table. **No `anon` grant** — the public ordering surface is a separate milestone with its own server boundary.

### 11.6 Duplicate defence

The order `id` is minted **once**, client-side, when the form opens (`resolveOrderId`, mirroring `resolveCostingId`), so a double-submit upserts the same row instead of inserting two. `createMutationGuard` keyed by order id is layered on top for Place / Mark paid / status actions.

---

## 12. Application Architecture

Repository idiom throughout. Nothing enters `LabState`; `product-lab.tsx` gains one line.

```
src/lib/orders/
  types.ts        OrderStatus, PaymentStatus, PaymentMethod, FulfillmentMethod,
                  OrderSource, OrderEntryMethod + their `as const` arrays;
                  Customer, Order, OrderLine; and the nullability-preserving
                  CustomerRow / OrderRow / OrderLineRow wire shapes
  mappers.ts      mapCustomerRow / mapOrderRow / mapOrderLineRow,
                  buildCustomerPayload / buildOrderPayload / buildOrderLinePayload,
                  getRemovedOrderLineIds
                  — writes `updated_at` explicitly (finding F1, §2.6)
  totals.ts       getOrderTotals(lines)     → the live quote
                  getPaymentDivergence(order, lines) → paid_amount vs current total
  revenue.ts      grossRevenue / refunds / netRevenue / unpaidOrderValue (§6.1)
  transitions.ts  isValidOrderTransition, applyOrderTransition,
                  isValidPaymentTransition, applyPaymentTransition
                  — pure; `now` injected; writes status and timestamp together
  pieces.ts       getUnitsToPrepare / getPiecesToPrepare  (§7; used by S7,
                  defined in S1 because pieces_per_unit_snapshot exists to serve it)
  menu.ts         getSellableItems(products, batches, costings, sellingFormats)
                  — reuses getLatestBatch + getLinkedCosting from
                    src/lib/rule-engine/types.ts; carries pieces_per_unit through
                    to the line snapshot; never recomputes a price
  validation.ts   validateOrderForSave(order, lines) → string | null
                  — one gate returning a ready-to-display message, mirroring
                    validateSellingFormatsForSave

src/lib/orders-repository.ts     narrow injected OrdersClient type;
                                 listOrders / getOrderDetail /
                                 saveOrder (→ rpc "save_order") /
                                 updateOrderStatus / updatePaymentStatus /
                                 listCustomers / saveCustomer
                                 → { ok: true, … } | { ok: false, reason:
                                     "missing-table" | "failed", message }
                                 reusing opportunity-review.ts's isMissingTableError
                                 (PGRST205 / 42P01)

src/lib/business-day.ts          [P2] formatDateInTimezone + getBusinessDay(now, tz)
                                 — extracted from scripts/daily-advisor/run.ts

src/components/orders-page.tsx   "use client"; list + detail + new-order form
src/app/orders/page.tsx          reads searchParams, renders <ProductLab view="orders" …/>
```

**Server/client boundary:** unchanged. Introducing a Route Handler is deferred to the public-ordering milestone.

**No localStorage fallback for orders** — consistent with every repository-idiom module. With Supabase unconfigured (local dev only, since production requires login) the page shows the same "needs setup" banner every other optional table shows.

---

## 13. Testing Strategy

`node --test tests/*.test.ts`, hand-built stubs, pure-function-first — no new harness.

**Critical for MVP:**

| Test file | Covers |
|---|---|
| `orders-transitions.test.ts` | The full 5×5 order matrix, allowed and prohibited. Terminal states reject everything. `applyOrderTransition` sets status and timestamp together |
| `orders-payment.test.ts` | **`unpaid → paid` freezes `paid_amount` from the lines at that instant** · `paid → refunded` sets `refunded_at` and **retains `paid_at` and `paid_amount`** · `paid → unpaid` clears all three together · `unpaid → refunded` rejected · **cancelling an order writes nothing to any payment field** · **(C1)** a refund attempted without a `paid_amount` is rejected · a negative `paid_amount` is rejected · **(C3) editing lines on a paid order leaves `paid_amount` and `paid_at` byte-identical**, and `getPaymentDivergence` reports the gap without mutating anything |
| `orders-revenue.test.ts` | **The finding-2/3/4 regression suite.** Cancelling a paid order leaves gross revenue unchanged · a refund reduces the refund period's net and leaves the payment period's gross byte-identical · **editing lines on a paid order does not change revenue** · `unpaidOrderValue` excludes cancelled orders · all ranges evaluated in Manila days, never UTC · **(C1)** neither `grossRevenue` nor `refunds` can encounter a NULL `paid_amount`, proven by asserting the constraint rejects the row that would produce one |
| `orders-totals.test.ts` | `getOrderTotals` over zero / one / many lines; a `0`-priced line is a real zero, not missing; no rounding before final format; `getPaymentDivergence` reports the gap and its sign |
| `orders-pieces.test.ts` | **Finding 1.** `2 × pieces_per_unit_snapshot 6` = 12 pieces · a line with a **null** snapshot is counted in `piecesUnknownLines` and **never treated as 1 or 0** · pieces stay computable after `selling_format_id` is set to null |
| `orders-mappers.test.ts` | Round-trip row → type → payload. **Null preservation**: null `unit_price`, `paid_amount`, or `pieces_per_unit_snapshot` never becomes `0`. `updated_at` present in every update payload. `getRemovedOrderLineIds` matches the `getRemovedSellingFormatIds` contract |
| `orders-validation.test.ts` | Order with no lines rejected; missing customer rejected; negative price rejected; **non-integer or zero quantity rejected (finding 7)**; a manual line with a name and price accepted with both FKs and the pieces snapshot null |
| `orders-source.test.ts` | **Finding 6.** Default source is **`unknown`**, never `manual` · `entry_method` is a separate field · **`repeat` is not a member of `ORDER_SOURCES`** · an unrecognized DB value degrades to a safe default (the `parseOpportunityStatus` pattern) · `source_ref` round-trips unparsed |
| `orders-menu.test.ts` | `getSellableItems` returns only active formats of the current costing; excludes archived formats; **carries `pieces_per_unit` through to the snapshot**; a product with no costing yields no catalog items but is still orderable as a manual line |
| `orders-schema.test.ts` | Asserts against `supabase-add-orders.sql`'s text — the `opportunities-schema.test.ts` convention. Specifically: `order_lines.selling_format_id` and `product_id` are `on delete set null` · `order_id` is `on delete cascade` · `orders.customer_id` is `on delete restrict` · `product_id` is **`text`** · **`quantity` is `integer`** · **`pieces_per_unit_snapshot` is nullable with a `> 0` check** · **(C1) all three `orders_*` money checks exist, and the refund check names `paid_amount`** · **(C2) `save_order` raises on an order-id mismatch and scopes its delete with `and order_id = v_order_id`** · **`save_order` is defined `security invoker` and contains no business logic** · no CHECK on any classification column |
| **`orders-save-ownership.test.ts`** | **(C2), new.** Against a stub client capturing the RPC payload: a line carrying a foreign `order_id` is rejected before any write · a `p_removed_line_ids` array containing another order's line id deletes nothing from that other order · a removed id that no longer exists is a no-op, not a failure · the repository never issues a line write outside a `save_order` call |

**Integrity / duplicate cases (critical):** saving the same client-minted order id twice produces one row, not two · removing a line on re-save deletes it · **deleting a `selling_format` leaves the line intact with its name, price, and pieces snapshot and a null pointer** — asserted directly, because this is the §2.2 risk and the reason finding 1 exists · **an RPC failure mid-save leaves zero partial rows** (asserted against a stub client that rejects, proving the repository issues one call, not a sequence) · **cross-order mutation and deletion are impossible** (C2, above).

**Nice-to-have, not MVP:** UI/interaction tests for the orders page; concurrency tests (single operator); a live-Supabase smoke test.

---

## 14. Implementation Slices

Every slice's acceptance gate is **the S0-recorded baseline, unchanged, plus that slice's own new tests** — never "all green," matching the M1 plan's discipline.

### S0 — Prerequisite verification *(no code)* — ✅ **executed 2026-08-07**
**Goal.** Land P1 and P2; establish a clean, isolated base.
**Steps.** Merge BCB M1 PR #4 → `git worktree add .worktrees/selling-mvp -b feat/selling-mvp <sha>` (repo convention; keeps the untracked planning docs and the `feat/unsaved-changes-protection` work out of the tree) → `npm ci` → record the measured `npm test` / `npx tsc --noEmit` baseline.
**Acceptance.** Baseline recorded as a number, not predicted. If it is not what PR4 left behind, stop and report.
**Out of scope.** Any Selling code.
**Outcome.** P1 satisfied by PR #30; **P2 found already satisfied — no code written** (see "Implementation status"). Worktree `.worktrees/selling-mvp` on branch `feat/selling-mvp`, based on `956c802de28b2a53632c1425501f1ea48503a3eb`. Measured baseline: **1719 tests · 1716 pass · 2 fail · 1 skipped · tsc 0 errors · lint 1 error**, all pre-existing and enumerated in "Implementation status". **Re-verify the base SHA before S1** — if anything other than documentation landed on `main` since, rerun the baseline.

### S1 — Schema, atomic save, and domain foundation

**Goal.** Three tables, the `save_order` RPC, and the pure domain layer. Nothing renders.

**Files.** `supabase-add-orders.sql` · `src/lib/orders/{types,mappers,totals,revenue,transitions,pieces,validation}.ts` · `src/lib/business-day.ts` [P2, may land earlier as its own PR] · `tests/orders-{schema,mappers,totals,revenue,transitions,payment,pieces,validation}.test.ts`

**Depends on.** S0.

**Acceptance criteria (revised):**
1. Migration applies cleanly in the Supabase SQL editor **and is safely re-runnable** — verified by running it twice.
2. The guarded preflight block **raises and aborts** when given a deliberately mismatched shape, rather than continuing.
3. **`save_order` exists, is `security invoker`, and contains no business logic** — no total, no state rule, no validation beyond payload shape and parent–child identity (`orders-schema.test.ts` asserts this against the file text).
4. **`save_order` enforces parent–child ownership (C2):** it raises when a submitted line's `order_id` differs from the order being saved, and its delete is scoped `and order_id = v_order_id`. Proven by `orders-save-ownership.test.ts`: **cross-order mutation and cross-order deletion cannot occur**, and a stale removed id is a no-op rather than a failure.
5. **Schema truthfulness (findings 1, 3, 4, 7 and C1):** `order_lines.quantity` is `integer` with `> 0`; `pieces_per_unit_snapshot` is nullable with `> 0`; `orders.paid_amount` and `refunded_at` exist; **all three `orders_*` money checks exist, with `paid_amount` named in the refund check and `orders_paid_amount_nonnegative` present**; `product_id` is `text`; both catalog FKs are `on delete set null`.
6. **Revenue invariant tested, not just written (§6.1):** cancelling a paid order leaves gross revenue unchanged; a refund moves net in the refund's period only; editing lines on a paid order does not move revenue; **neither revenue sum can encounter a NULL `paid_amount` (C1)**.
7. **Payment facts are immutable except by explicit correction (C3):** editing lines on a paid order leaves `paid_amount` and `paid_at` byte-identical, and `getPaymentDivergence` reports the gap as a pure read with no mutation.
8. **Pieces survive orphaning (finding 1):** `getPiecesToPrepare` returns 12 for `2 × Box of 6` after `selling_format_id` is set to null, and reports a null snapshot as unknown rather than as 1.
9. **Attribution split (finding 6):** default `source` is `unknown`; `entry_method` is separate; `repeat` is absent from `ORDER_SOURCES`.
10. Every domain function is pure — no clock, no client, no `process.env`; `now` is a parameter.
11. Nothing imports from `product-lab.tsx`, `bake-*`, `stock-adjustment`, or `inventory-*`.
12. Baseline test count unchanged, plus the new files, zero new type errors.

**Out of scope.** Any UI. Any Supabase read/write call site (the RPC is defined here, invoked in S2).

### S2 — Manual order creation

**Goal.** Create an order with a customer and lines, atomically, and see it in a list.

**Files.** `src/lib/orders-repository.ts` · `src/lib/orders/menu.ts` · `src/components/orders-page.tsx` · `src/app/orders/page.tsx` · `src/lib/lab-state.ts` (view + nav) · `src/components/app-shell.tsx` (title) · `src/app/product-lab.tsx` (one dispatch line) · `tests/orders-{menu,repository,source,save-ownership}.test.ts`

**Depends on.** S1.

**Acceptance criteria (revised):**
1. An order with multiple lines is created end to end and survives a reload.
2. **Creation issues exactly one `save_order` RPC call, not a sequence** — asserted against a stub client that counts calls.
3. **A rejected RPC leaves zero rows** — no order without lines, no lines without an order (stub client rejects; repository surfaces `{ ok: false, reason: "failed" }`).
3b. **Every line the repository submits carries the saved order's own `order_id`, and `p_removed_line_ids` only ever contains ids from that order (C2)** — asserted against the captured RPC payload, so ownership holds at the call site as well as inside the function.
4. The sellable menu is grouped by product with **price and pieces-per-unit both pre-filled from `selling_formats`**, and both are written to the line snapshot.
5. A manual line (no product, no format, null pieces snapshot) saves and displays correctly.
6. **Quantity input accepts integers only** and rejects 0 and 2.5 before the round-trip (finding 7).
7. **The source field defaults to `Unknown`** in the UI, and `entry_method` is written as `manual` without being presented as a choice (finding 6).
8. A missing `orders` table degrades to a setup banner, not a crash (`isMissingTableError`, PGRST205 / 42P01).
9. A synchronous double-click produces exactly one order — client-minted id upsert plus `createMutationGuard`.
10. `product-lab.tsx` grows by one line; nothing enters `LabState`.

**Out of scope.** Status actions, payment recording, fulfilment editing after creation, the divergence banner.

### S3 — Order lifecycle
**Files.** `orders-page.tsx` · `orders-repository.ts` (`updateOrderStatus`) · tests extended.
**Acceptance.** Only valid transitions offered; terminal states offer none; `completed_at`/`cancelled_at` written with the status in one update; **cancelling writes nothing to any payment field** and instead prompts "this order was paid — record a refund?"; `createMutationGuard` keyed by order id.
**Out of scope.** Payment recording, status history.

### S4 — Payment
**Files.** `orders-page.tsx` · `orders-repository.ts` (`updatePaymentStatus`) · tests extended.
**Acceptance.** Marking paid requires a method and **freezes `paid_amount` alongside `paid_at`**; refund sets `refunded_at` and retains both (required by C1's constraint); the unpaid correction clears all three together; **the divergence banner appears when a paid order's lines change and is informational only (C3)** — its sole action is **"Correct payment record"**, pre-filled from the **recorded** payment and never from the current total, with help text naming the second-payment case as unsupported; the list shows paid / unpaid / refunded and an unpaid total; day boundaries use `business-day.ts`.
**Out of scope.** Partial payments, deposits, any gateway, partial refunds, and **any path that lets a changed order total write a payment field**.

### S5 — Fulfillment
**Files.** `orders-page.tsx` · tests extended.
**Acceptance.** Address appears only for delivery; `fulfillment_at` optional and editable; the list can sort/filter by fulfilment time; **no second status field is introduced**.
**Out of scope.** Delivery fees as a first-class concept (a manual line), routing, notifications.

### S6 — Source attribution
**Files.** `orders-page.tsx` · tests extended.
**Acceptance.** Source editable after creation; `source_ref` free text, never parsed; unknown DB values degrade safely; a per-source count visible somewhere cheap (a list-header line, not a dashboard).
**Out of scope.** Campaign entities, UTM parsing, any join to Content.

**— MVP ends here (owner scope decision). Everything below is planned, sequenced, and not built. —**

### S7 — Operational readout ✅ COMPLETE
Today's orders, today's paid revenue, unpaid total, **to-prepare by product in units and pieces with an explicit unknown-lines count (§7)**, ready-for-handover. Pure functions over orders + lines; zero writes; `?tab=summary` on the existing route. `pieces.ts` and `revenue.ts` already exist from S1.

> ## ✅ S7 — OPERATIONAL READOUT COMPLETE
>
> Both required parts shipped 2026-08-08:
>
> ```
> G1 ✅ deterministic Selling summary   PR #39  (4072fc9, head 4f9ceaa)
> G2 ✅ /orders?tab=summary operator UI  PR #40  (00a9e34, head 882c5ec)
> -------------------------------------------------------------------
> S7 ✅ COMPLETE
> ```
>
> **G1 — the read layer.** `buildSellingSummary({ orders, linesByOrderId, nowMs, timeZone })` is pure:
> no React, no Supabase client, no repository, no query, no write, no clock. It composes `revenue.ts`,
> `pieces.ts`, `attribution.ts`, `fulfillment.ts`, `totals.ts` and `business-day.ts`, all of which
> remain byte-identical. 37 tests, nine mutation checks. `resolveTodayRange` /
> `resolveRollingWeekRange` are exported for a later consumer.
>
> **G2 — the surface.** `/orders` remains the default operational list; `/orders?tab=summary` renders
> the readout from the state the list already loaded — no second loader, cache, query or write. Tabs
> are real anchors, so reload, sharing and back/forward preserve the URL, and
> `useUnsavedChangesGuard` remains the sole unload guard. 32 tests, seven mutation checks, plus
> logged-in browser verification (16/16) covering both viewports, the one-prompt dirty-form path, and
> an operator cross-check of every count against the same records in the list. Verified live in
> Production after merge.
>
> **The whole S7 contract holds:** loading and failed/unknown states never render a zero summary —
> successfully loaded empty data is the only state allowed to show zero figures; unknown pack sizes
> stay explicitly unknown; most-ordered is labelled by selling units; unknown source stays visible;
> and no lifecycle filter reaches gross revenue.
>
> ### Two findings carried forward, neither part of S7
>
> 1. **Network-level Orders read failure can leave the loader at "Loading…"** rather than showing the
>    failure message. Reproduces on the pre-G2 Orders list; `loadAll` is unchanged by G2. G2 still
>    guarantees no zero summary in that state. Needs its own slice.
> 2. **The CRLF checkout finding** recorded in "Implementation status" above remains a separate
>    repository-maintenance concern.
>
> ### The Selling MVP is NOT complete
>
> **S8 — Business Context exposure remains the final planned Selling MVP slice**, and has not begun:
> `DOMAIN_IDS` still has no `selling` member and no selling adapter exists. `buildSellingSummary` was
> built as its reuse boundary — `BuildEnv`'s `now` / `timezone` map directly onto `nowMs` / `timeZone`
> — but that is preparation, not authorisation.

### S8 — Business Context exposure ✅ COMPLETE
A `selling` domain adapter, one `DOMAIN_IDS` entry, one registry entry. Reads `paid_amount` directly (§6.3). Measurements only. Requires BCB M1 fully merged.

> ## ✅ SELLING MVP — COMPLETE
>
> **Recorded 2026-08-09.** Status and history only; no frozen architecture section is edited.
>
> ```
> S7 ✅ Operational Readout                 PR #39 (G1) · PR #40 (G2)
> S8 ✅ Selling → Business Context exposure PR #41
> -----------------------------------------------------------------
> SELLING MVP ✅ COMPLETE
> ```
>
> | | |
> |---|---|
> | **PR** | #41 — *feat(business-context): expose deterministic Selling facts (PR-H1)* |
> | **Merge SHA** | `078564862db3944c158396b5dba79dbde3719190` |
> | **S8 head SHA** | `2d0208ad92773cd4489bfd75fc556c600bd29f3f` |
> | **Merge parents** | `5618b36` (prior main) + `2d0208a` (S8 head) |
>
> S8 ships `src/lib/business-context/adapters/selling.ts` plus one `DOMAIN_IDS` entry and one registry
> entry, exactly as this section specified. The fact set is the owner-approved deviation recorded in
> §6.3. `buildSellingSummary` is called once per build and no Selling formula is reimplemented;
> `build.ts`, `selectors.ts`, `digest.ts`, the composers, `SIGNAL_IDS` and `CONTEXT_SCHEMA_VERSION`
> are unchanged, and the six Selling helpers, `orders-repository.ts`, all SQL, `src/app/**` and
> `src/components/**` are byte-identical.
>
> Verified on merged main: focused 27/27 · full Business Context suite 12 files passing · full suite
> 2200 · 2195 pass · 4 known fail · 1 skip, zero new failures against the same-environment baseline ·
> tsc 0 · lint unchanged. Production deployed and healthy; `/orders` and `/orders?tab=summary` both
> 200.
>
> ### Selling development stops here
>
> **S10 remains trigger-based and is NOT authorised.** Nothing below is scheduled work: payment
> tables, repeat-customer logic, further analytics or dashboards, additional Selling Business Context
> facts, and runtime AI integration all require a fresh decision. The canonical Business Context still
> has **no runtime caller**, which is deliberate — S8 exposes facts; it does not wire a consumer.
>
> ### Carried-forward items, none of them Selling work
>
> 1. **Launch smoke for `/order`** — the public happy path has never been exercised over HTTP, because
>    no product is intentionally public yet. See the S9 completion note above; still outstanding.
> 2. **Orders network-loader hang** — a transport-level failure leaves the loader on "Loading…".
>    Pre-existing, reproduces on the pre-G2 list.
> 3. **CRLF checkout artifact** — environment-specific; see the baseline note in "Implementation
>    status".
> 4. **`unitsByProduct` / `piecesByProduct`** — deferred from S8 (§6.3), not refused.

### S9 — Public ordering surface *(deferred)*
Requires a real server-side execution boundary first (§9). Writes through the same `save_order` RPC with `entry_method = 'website'`.

### S10 — Hardening *(deferred, triggered not scheduled)*
`payments` table if deposits happen · `refunded_amount` if a partial refund happens · order sequence number if the operator asks · `finished_goods` ledger if availability becomes a real question.

---

## 15. Recommended PR Sequence

> **Status (2026-08-07): PR-A is already delivered** — `src/lib/business-day.ts` and `tests/business-day.test.ts` arrived with Business Context Builder M1 (commit `c5e0ef2`). **Do not open PR-A.** One documentation prerequisite replaces it: registering this plan in the repository (`planning/SELLING_MVP_IMPLEMENTATION_PLAN.md` + its `planning/PROPOSALS.md` entry), required by `AGENTS.md`'s Architecture Protection rule before implementation begins. The sequence is therefore **PR-0 → PR-B → PR-C → PR-D → PR-E**.

| PR | Contents | Reviewable because |
|---|---|---|
| ~~**PR-A**~~ | ~~P2 only — `src/lib/business-day.ts` + test~~ | **Superseded — delivered by the M1 merge. Not to be opened** |
| **PR-0** | Documentation only — this plan + its PROPOSALS entry | No executable change; makes the approved architecture available in-repo, which `AGENTS.md` requires before S1 |
| **PR-B** | S1 — migration, `save_order`, pure domain, tests | No UI, no wiring; entirely SQL and pure functions. The migration reads against the schema-test assertions line by line, and the revenue invariant is provable from `revenue.ts` + `orders-revenue.test.ts` alone |
| **PR-C** | S2 — repository, page, four wiring lines | The first PR that changes what the app does. One line into `product-lab.tsx` keeps the monolith out of review |
| **PR-D** | S3 + S4 — lifecycle and payment | They share the detail pane and one repository module; splitting them ships a status machine with no way to record money |
| **PR-E** | S5 + S6 — fulfilment and attribution | Field-level additions to an existing form and list |

Five PRs, none large. PR-A is the only prerequisite that must land before PR-B.

---

## 16. Risks / Architectural Traps

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Duplicating Costing price logic** | Selling never computes a price. `selling_price` and `pieces_per_unit` pre-fill and are snapshotted; `getSellingFormatMetrics`/`getCostingTotals` are read-only dependencies |
| R2 | **Deleting a costing destroys order history** (`selling_formats.costing_id` is `ON DELETE CASCADE`) | Nullable FK `ON DELETE SET NULL` beside authoritative `item_name` + `unit_price` + **`pieces_per_unit_snapshot`**. Asserted directly in `orders-schema.test.ts` and `orders-pieces.test.ts`. *Highest-severity repo-specific trap* |
| R3 | **A needed fact left behind on an orphan-able row** | The general form of R2, and the reason finding 1 was a real defect. Rule: *any fact an order line needs for later computation, living only on a row it points at with `SET NULL`, must be snapshotted.* Today: `{name, unit_price, pieces_per_unit}` |
| R4 | **Mixing batch production with sales orders** | No `batch_id` on an order or a line |
| R5 | **Premature inventory reservations** | Zero inventory writes; no finished-goods table; structural non-import (§7) |
| R6 | **Counting unpaid orders as revenue** | Revenue reads `paid_amount` where `paid_at` is set. Nothing else |
| R7 | **Lifecycle silently moving revenue** | `status` appears nowhere in §6.1. Cancelling writes no payment field. `status <> 'cancelled'` lives only in `unpaidOrderValue`, where it belongs |
| R8 | **Revenue retroactively changing** | `paid_at` is never cleared by a refund; `refunded_at` records the reversal in its own period. Only a *correction* (`paid → unpaid`) rewrites history, and only to remove an untrue claim |
| R9 | **Revenue recomputed from mutable lines** | `paid_amount` is frozen at `paid_at` and revenue never reads a line. Post-payment line edits are legal but surface the divergence — a prohibition would be unenforceable below the UI and would block legitimate non-financial edits |
| R9b | **A changed order total implying money was received** (C3) | The divergence banner is informational; the only action is **"Correct payment record"**, pre-filled from the recorded payment, never from the current total. Real additional money is a *second payment* — unsupported, and the trigger for the deferred `payments` table. Asserted: editing lines leaves `paid_amount`/`paid_at` byte-identical |
| R9c | **A refunded order with no recorded amount** (C1) | `orders_refund_fields_present` requires `paid_amount` on a refund, so `refunds(range)` cannot sum a NULL. Without it, net revenue would be **overstated by exactly the refunded amount** — a plausible-looking wrong number |
| R9d | **Cross-order line mutation or deletion** (C2) | `save_order` raises when a submitted line's `order_id` differs from the order being saved, and scopes its delete `and order_id = v_order_id` so a foreign id matches nothing. Proven by `orders-save-ownership.test.ts` |
| R10 | **Storing derived totals wrongly** | No stored `line_total`, no stored order total. The single exception, `paid_amount`, is an observed financial event with a distinguished moment, not a cached computation (§4.3) |
| R11 | **Partial writes corrupting the commercial record** | `save_order` RPC from S1. A partially-persisted order is *not* visibly broken — it looks like a smaller order with a plausible total. The repo already regretted this deferral once (Inventory M2→M5) |
| R12 | **Attribution destroyed by a default** | `source` defaults to `unknown`, never `manual`; entry method is a separate column. An Instagram customer typed in by hand stays attributed to Instagram |
| R13 | **A derivable fact stored as an entered one** | `repeat` removed from `ORDER_SOURCES` — repeat-buyer status is `count(orders)` per customer, computed, never typed (design P4) |
| R14 | **Nonsense quantities** | `integer > 0`. 2.5 boxes is unrepresentable rather than merely discouraged |
| R15 | **Coupling Orders to Content** | One opaque `source_ref`. No FK, no import, no shared module |
| R16 | **Future channels needing separate pipelines** | Channel is a column value, not a code path. A website order is a row with `entry_method = 'website'` |
| R17 | **Status complexity** | 5 order states, 3 payment states, **zero** fulfilment states. No CHECK on classification columns, so additions are free |
| R18 | **Losing price-at-time-of-sale** | Per-line `unit_price` snapshot at full precision, never rounded before storage — the `unit_cost_snapshot` discipline |
| R19 | **Mutability of historical orders** | Terminal states are terminal; edits to a completed order are labelled corrections; `completed_at`/`cancelled_at` written by the transition, never by hand |
| R20 | **Duplicate submissions / races** | Client-minted stable order id makes a re-submit an upsert; `createMutationGuard` on top — the pattern adopted after a real double-click doubled a bake |
| R21 | **UTC "today" mis-dating orders and revenue** | P2 — satisfied: call `resolveBusinessDay` (`src/lib/business-day.ts`). Manila business day everywhere; `getToday()` remains forbidden in Orders code |
| R22 | **Selling drifting into the monolith** | Repository idiom; `product-lab.tsx` gains exactly one line |
| R23 | **`updated_at` silently never written** (repo-wide finding F1) | Payload builders write it explicitly; the mapper test asserts it |
| R24 | **`products.id` is `text`, not `uuid`** | Stated in the migration, asserted in the schema test — a `uuid` FK fails at apply time |

---

## 17. What We Deliberately Defer

| Deferred | Reopen when |
|---|---|
| Selling dashboard (S7) | The orders list stops answering "what do I do today" |
| Business Context `selling` adapter (S8) | The advisor is asked a question that needs sales facts |
| Public ordering page (S9) | A server-side execution boundary exists, and manual entry becomes the bottleneck |
| Finished-goods stock & reservations | "Can I still sell this?" becomes a question the operator cannot answer from memory |
| `payments` table | **A customer actually sends money a second time** — a deposit plus a balance, or a top-up after adding an item. MVP has no way to record this: correcting `paid_amount`/`paid_at` would destroy the first payment's date and misstate both periods' revenue (C3). This is the single clearest trigger in the plan |
| `refunded_amount` | A partial refund happens. Until then a refund is full and its amount is `paid_amount`, which C1's constraint guarantees is present on every refunded row |
| `preparing` status | The operator wants "in the oven" distinct from "agreed" |
| `pending` payment status | "They said they sent GCash" needs tracking, not remembering |
| Lead entity | Recorded interest that never becomes an order needs counting |
| Order sequence number | The operator wants to say "order #14" to a customer |
| `order_status_history` | A dispute or analysis needs to know when a status changed |
| Content → Order FK | Content genuinely carries per-post CTAs |
| Discounts, fees, loyalty, subscriptions | A real instance occurs — until then a manual line covers it |
| Weight-priced items (₱/kg) | One is sold. The fix is a unit label or a weight-based format, **not** loosening `quantity` back to numeric |
| Retiring the Launch Offer stub | Orders has been used for a few weeks and the stub is provably dead |

---

## 18. Final Recommendation

**Architecture.** Three tables (`customers`, `orders`, `order_lines`) plus one atomic `save_order` RPC in one additive migration. Pure domain modules under `src/lib/orders/`. Repository-idiom data access, outside `LabState`. One page at `/orders` behind the existing login gate.

Five rules carry the design:

1. **Snapshot everything an order line needs from a row that can be orphaned** — name, unit price, and pieces per unit.
2. **Revenue is a frozen amount at a recorded instant** — `paid_amount` at `paid_at`, never recomputed, never touched by lifecycle state, and never written as a side effect of an order total changing.
3. **Corrections rewrite history; refunds add to it** — and only corrections may remove a fact that was never true. Money actually arriving a second time is a *second payment*, which this MVP does not model.
4. **An order is one transaction, and it owns its lines** — one atomic RPC that enforces parent–child ownership and contains no business logic.
5. **The money invariants live in the schema, not in convention** — three CHECK constraints make both revenue sums total by construction.

**Scope.** S1–S6 (owner decision: record → fulfil). S7–S10 planned, sequenced, unbuilt.

**Prerequisites.** ~~Merge BCB M1 PR #4 (owner's priority #1). Ship `src/lib/business-day.ts` as its own small PR~~ — **both satisfied as of 2026-08-07** (PR #30; `src/lib/business-day.ts` delivered by commit `c5e0ef2`). The UTC/Manila mismatch remains the defect that would make Selling data wrong from day one, and the countermeasure is now to *use* `resolveBusinessDay` rather than to build it. **One prerequisite remains: registering this plan in the repository** (PR-0, §15), required by `AGENTS.md`'s Architecture Protection rule.

**Complexity by slice.**

| Slice | Complexity | Note |
|---|---|---|
| ~~P2 · business-day helper~~ | ~~**Trivial**~~ | **Already delivered by M1 (`c5e0ef2`) — no work** |
| S0 · baseline | **Trivial** | Merge + worktree + measure — **done 2026-08-07** |
| S1 · schema + RPC + domain | **Moderate** (up from Rev 1) | The `save_order` RPC and `revenue.ts` add real surface, but both follow existing templates and are almost entirely pure functions and SQL |
| S2 · order creation | **Moderate–High** | The largest UI surface; the sellable-menu selector is the only genuinely new logic |
| S3 · lifecycle | **Low** | The state machine is fully specified and tested in S1 |
| S4 · payment | **Low–Moderate** (up from Rev 1) | Three states, three timestamps, plus the divergence banner |
| S5 · fulfilment | **Low** | Field-level additions; no new state |
| S6 · attribution | **Trivial** | Three columns and a select |

**First slice to implement after approval:** ~~**P2**~~ — **superseded. P1, P2, and S0 are all complete (see "Implementation status"). Once this plan is merged into the repository (PR-0), the first slice to implement is `S1 — Schema, atomic save, and domain foundation`.**

**Verdict: GO WITH PREREQUISITES.** Retained unchanged through Revision 3.

The seven Revision 2 review findings were all real. Six were defects — two of them (revenue-vs-lifecycle, and revenue recomputed from mutable lines) would have produced a commercial record that looked authoritative and was wrong, which is the exact failure mode `BUSINESS_CONTEXT_BUILDER_DESIGN.md` exists to prevent.

Revision 3's three corrections are integrity hardening, not redesign. Each closes a way the record could be wrong while looking right: a refunded order missing its amount would have **overstated net revenue by exactly the refund** (C1); an unscoped delete could have removed **another order's lines** (C2); and a reconcile-to-current-total action would have written a payment fact from an order edit, quietly asserting money arrived that never did (C3). All three are cheaper to fix in a plan than in a migration, and none changes the shape of the architecture: three tables, one page, no inventory coupling, one revenue definition.

**This plan is frozen at Revision 3 and approved for implementation.** Changes from here require an explicit owner decision recorded as a new revision in §0, not an in-place edit.

---

## Appendix — Repository claim verification

Every architectural premise this plan depends on, re-verified against `origin/main` @ `956c802de28b2a53632c1425501f1ea48503a3eb` on **2026-08-07**, immediately before this document was registered in the repository. Re-run this check if the plan is picked up long after that date.

| # | Claim | Verified | Evidence |
|---|---|---|---|
| 1 | `products.id` is `text`, not `uuid` | ✅ | `supabase-schema.sql` — `create table if not exists products ( id text primary key,` |
| 2 | `selling_formats.costing_id` is `ON DELETE CASCADE` | ✅ | `supabase-add-selling-formats.sql:17` — `costing_id uuid not null references costing_summaries(id) on delete cascade` |
| 3 | The nullable-pointer + frozen-snapshot precedent exists | ✅ | `supabase-add-selling-formats.sql:35,39` — `ingredient_id uuid references ingredients(id) on delete set null` alongside `unit_cost_snapshot numeric not null default 0`, plus its column comment *"Frozen per-unit cost at full precision — do not round before storing"* (line 54) |
| 4 | A composite-save RPC precedent exists | ✅ | `save_supply_with_inventory_effect` (`supabase-add-manual-purchase-inventory-effect.sql:32`); cross-payload identity-check precedent in `apply_inventory_adjustment` (`supabase-add-inventory-adjustment.sql:22`) |
| 5 | `DOMAIN_IDS` has no selling/orders domain | ✅ | `src/lib/business-context/types.ts` — 14 members. Contains `sellingFormats` (D4, the costing-owned pack sizes) but **no** orders/selling domain. Adding one remains additive per the design's §9 |
| 6 | `src/lib/business-day.ts` exists | ✅ | Present, 2,072 bytes, `resolveBusinessDay(nowMs, timeZone)`, added by `c5e0ef2` |
| 7 | Its Manila boundary tests exist | ✅ | `tests/business-day.test.ts`, 6 tests, including `15:59Z → 2026-08-06` / `16:01Z → 2026-08-07` |
| 8 | `createMutationGuard` exists | ✅ | `src/lib/mutation-guard.ts:18` |
| 9 | The repository idiom is intact | ✅ | `src/lib/opportunity-review.ts` still returns `{ ok: false; reason: "missing-table" \| "failed" }`; `resolveInventoryTab` still at `src/lib/inventory-tabs.ts:17` |
| 10 | `getToday()` is still UTC | ✅ | `src/lib/lab-state.ts:89–91` — `new Date().toISOString().slice(0, 10)`. Still forbidden in Selling code |
| 11 | No `customers` / `orders` / `order_lines` table exists | ✅ | No `create table` for any of the three in any `supabase-*.sql`. Selling remains greenfield |
| 12 | `product-lab.tsx` is still the monolith the plan routes around | ✅ | 7,864 lines. Selling adds one dispatch line and nothing else |

**No material architectural premise has changed since Revision 3 was frozen.** The single change is P2's status, recorded in "Implementation status" above — a factual correction, not an architectural one.
