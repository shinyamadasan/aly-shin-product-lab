# S9 — Public Ordering Surface: Implementation Plan (Revision 3)

> ## ✅ FROZEN — APPROVED FOR IMPLEMENTATION
>
> **Status:** Architecture approved and frozen at Revision 3. **Verdict: GO WITH PREREQUISITES.**
> Do not reopen or redesign the public ordering surface. Changes from here require an explicit owner
> decision recorded as a new revision in §0, not an in-place edit.
>
> **Implementation proceeds slice by slice: PR-F1 → PR-F2 → PR-F3** (§11). PR-F1 is the public
> catalog foundation and creates **no** public write surface, **no** server credential boundary, and
> **no** customer-facing page — it is safe to merge even if PR-F2 is never built. S7, S8 and S10
> remain planned, sequenced, and explicitly not authorised.
>
> **Prerequisite status:** **P1** (live credential measurement) is evidence collection and does
> *not* by itself authorise PR-F2. **P2** (`products.is_public`) lands in PR-F1.

## 0. Change log

### 0.2 Revision 3 — the create-once decision moves into the database

**One correction, driven by a defect reproduced against the live database during PR-F2
implementation. No other S9 decision changes.**

Revision 2 §6 Q2 concluded that an application-side existence check was sufficient and that **"no
new RPC is justified."** The reasoning — that a wrapper would become "a second Order persistence
implementation" — was right about *persistence* and wrong about *concurrency*. It assumed a
read-then-write in application code could provide create-once semantics. It cannot: the read and the
write are separate transactions, so two concurrent submissions deriving the same order id can both
observe "absent", and a serverless request can pause for an unbounded time between them.

**The reproduced sequence** (real Supabase, order id `42f1e5c4-…`, request B's client wrapped so its
RPC parked *after* its existence check returned absent):

```
B checks   -> absent
A creates  -> new / unpaid
operator   -> confirmed / paid (gcash, 22.00)   [shipped S3/S4 operations]
B resumes  -> save_order with its CREATION payload
```

**Fields reset by B**, because `save_order`'s `on conflict (id) do update set` assigns every column
from `excluded`:

| Field | Before B | After B |
|---|---|---|
| `status` | `confirmed` | `new` |
| `payment_status` | `paid` | `unpaid` |
| `payment_method` | `gcash` | `null` |
| `paid_at` | `2026-08-08T16:29:33.776+00:00` | `null` |
| `paid_amount` | `22` | `null` |

`refunded_at`, `completed_at`, `cancelled_at` and `cancel_reason` sit in the same whole-row
overwrite set and are equally exposed; they were already null in this run, so they show no delta.
B returned an ordinary success — a confirmed, paid order was silently un-paid with no error anywhere.

**The correction.** Public creation now goes through `save_public_order_once(p_order, p_lines)`
(`supabase-add-public-order-once.sql`), which inside one transaction:

1. takes `pg_advisory_xact_lock` keyed to the derived order id — transaction-scoped, released
   automatically on commit, rollback or exception, and keyed so unrelated orders never block;
2. checks existence **under that lock**;
3. returns `{ created: false }` writing nothing if the order exists;
4. otherwise **delegates to `save_order`**.

The wrapper contains no insert, no upsert, no line handling and no business rule. **`save_order`
remains the canonical implementation of order + line persistence**, unchanged, with every existing
internal caller untouched.

**The application-side existence check remains, as an optimization only.** It answers the common
case — a browser retrying after a lost response — without writing a customer row. It is explicitly
no longer correctness-critical: a caller that races past it, or an implementation that dropped it,
is still safe because the database wrapper is the authority.

**The customer is inside the boundary too — and the reasoning that first left it outside was wrong.**

The first version of this correction kept `saveCustomer` in application code just before the
wrapper, on the argument that a racing retry would re-upsert "byte-identical name and phone" so its
only effect would be to advance `customers.updated_at`. **That argument was false.** It assumed the
same idempotency key implies the same request payload. It does not: a customer who edits the form
and resubmits while the first request is still in flight sends different contact details under the
same key, and both requests derive the *same* customer id. Adversarial review reproduced the result
live, in both orderings:

```
A creates order + customer "Alice Race / 111111"
B (losing) upserts the same customer id as "Bob Race / 222222"
result: A's order now points at Bob's name and phone
```

The earlier reachability trace asked only whether an *operator* could edit a customer — there is no
such surface — and never asked whether a *second public request* could. Name and phone are the two
fields the public flow requires, because they are how the order is confirmed; an order carrying the
wrong person's number is a real delivery failure.

So `save_public_order_once` now takes the customer as well, and under the same advisory lock:

- if the order exists → `{ created: false }` and **zero writes** — no customer, no order, no lines;
- if absent → persist the customer, then delegate order + line persistence to `save_order`.

Two consequences follow. A losing same-key request can no longer mutate anything the winner
persisted. And because the customer is now written inside the same transaction, a failure in
`save_order` rolls it back with everything else — which **eliminates the orphan-customer residual**
that the sequential shape carried.

The wrapper still contains no `orders` insert, no `order_lines` insert and no order upsert:
`save_order` remains canonical for order and line persistence.

**Also corrected while implementing:** price consent is decided by the **customer-visible
representation** (`src/lib/orders/money.ts`), one rule shared by everything that displays a price
and by the server-side check.

Two earlier attempts were both wrong. The first was a half-centavo epsilon — an arbitrary tolerance.
The second, `Math.round(value * 100)`, was described as exact but disagrees with the app's own
formatter: `1.005` renders as `1.01` yet computes to 100 centavos, so a catalog move of
`1.005 → 1.004` changes what the customer sees (`₱1.01 → ₱1.00`) while both map to the same centavo
count, and consent would wave it through. Any arithmetic re-derivation of "what two decimal places
would show" merely approximates the formatter, so the rule is now the formatter itself: identical
rendering means the customer cannot tell the two apart and the order proceeds; different rendering
means consent is broken and the submission is refused. The persisted price remains the authoritative
catalog value in every case.

### 0.1 Revision 2 — six owner/review revisions applied before freeze

Revision 1 was the reviewed architecture. Revision 2 applies six corrections from the owner's
architecture review. **No structural redesign** — the boundary, the reuse story, the slice plan, and
the verdict are unchanged. Every section below is the revised text, not a diff.

| # | Revision | Where |
|---|---|---|
| **1** | **P1 is a live measurement, not an inference.** The claim that `service_role` lost EXECUTE to `revoke … from public` was read off SQL text. Both credential paths (plus `anon`) are now probed against `save_order` and the actual outcomes recorded — including the case where `service_role` unexpectedly succeeds, which is itself a reportable finding | §1 (P1), §6 Q1, §12 |
| **2** | **Server-only enforcement is explicit and layered.** `import "server-only"` makes a client-side import a *build error* rather than a runtime leak, on top of the absent `NEXT_PUBLIC_` prefix and a structural test. Supabase auth semantics are pinned: `persistSession: false`, `autoRefreshToken: false`, `detectSessionInUrl: false`, module-scope session only, explicit re-auth on 401 with exactly one retry | §6 Q1, §14 R3/R3c |
| **3** | **Idempotent replay returns a generic success with zero private-order disclosure.** No items, total, customer name, status, payment state, or timestamps — byte-identical to a first-time success. A replayed or guessed key must never become a read oracle for someone else's order | §6 Q2, §12, §14 R3b |
| **4** | **Idempotency key lifecycle defined: one key per *logical* order.** Kept across every retry and every definitive failure; rotated only once the order exists. Keeping it after success would collapse a customer's genuine second order into their first; rotating per attempt would defeat idempotency | §6 Q5 |
| **5** | **`displayedUnitPrice` is non-authoritative, and a stale price refreshes instead of silently creating.** The server still decides the real price; it additionally refuses to create an order at a price the customer never saw. Mismatch ⇒ `409 prices-changed` + refreshed menu + **zero writes**. The value can only *stop* an order, never set one | §5, §6 Q3, §13, §14 R2b |
| **6** | **Public repeat-customer undercount is an explicitly accepted S9 limitation.** A returning public customer gets a new `customers` row, so repeat-buyer counts under-report. Recorded, not solved: the alternatives are accounts (out of scope) or phone-matching, and phone-matching silently merges two people who share a handset | §6 Q7, §14 R9/R9b |

Everything not listed above is unchanged from Revision 1.

---

## Context

S1–S6 of the Selling MVP are complete and merged at `2c6efbe`. Aly & Pon can record, fulfil, and take payment for an order — but only by the operator typing it in. Every order today arrives as a Messenger conversation that someone re-keys by hand.

S9 is the customer-facing entry point into that pipeline. **The goal is not another sales system.** It is one mobile-first page that produces exactly the same `customers` / `orders` / `order_lines` facts a manual order produces, and then gets out of the way — the operator works it in `/orders` with the Confirm → Paid → Ready → Complete workflow that already exists.

The frozen plan (`planning/SELLING_MVP_IMPLEMENTATION_PLAN.md` §9, §14 S9) names one prerequisite and one shape: *"The app has **no server-side execution boundary** … A public page must not get blanket `anon` insert rights on `orders`. The correct shape is a Next.js Route Handler validating and inserting server-side."*

**Owner decisions taken during planning:** name + phone required · **pickup only at launch** · only products explicitly marked public appear.

---

## 1. Executive recommendation

**GO WITH PREREQUISITES — frozen at Revision 2.**

Build one Route Handler (`POST /api/public-orders`), one server-only Supabase client, one public page at `/order`, and one additive column (`products.is_public`). Everything else is reuse: the pure domain layer, `getSellableItems`, `buildCatalogOrderLine`, `validateOrderForSave`, `submitNewOrder`, and `save_order` are all used **unchanged**.

**Two prerequisites, both small:**

| # | Prerequisite | Why |
|---|---|---|
| **P1** | **Empirically test both credential paths against `save_order`**, then provision the chosen one as server-only env vars | §2.3 predicts `service_role` lacks EXECUTE after the explicit `revoke … from public`, but that is an inference, not a measurement. Both paths get a live probe; the website user is kept **if** it remains the least-privilege option that actually works. |
| **P2** | `products.is_public boolean not null default false` | The owner's decision. Default `false` means nothing goes public by accident. |

**Complexity: Low–Moderate.** The genuinely new surface is ~1 route handler + 1 form. The hard parts (atomicity, snapshots, price authority, lifecycle) were solved in S1–S6 and are consumed, not rebuilt.

---

## 2. Repository findings (verified, not assumed)

### 2.1 There is no server boundary — confirmed by absence

- **No `src/app/api/` directory exists.** `find src/app -type f` returns 20 files, all `page.tsx`/`layout.tsx`/`product-lab.tsx`.
- **Zero route handlers, zero server actions.** A repo-wide grep for `use server|export async function POST|export async function GET|NextRequest|NextResponse` across `src/` returns **nothing**.
- `src/lib/supabase.ts` is 9 lines: browser client, `NEXT_PUBLIC_*` anon key, `null` when unconfigured.
- Only three env vars are referenced in `src/`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NODE_ENV`.

**S9 will create the first server execution boundary in this repository.** That is the milestone, and it is why this deserves its own careful slice.

### 2.2 Route structure is already server/client split

Every route is a thin **server** component that renders the `"use client"` monolith:

```tsx
// src/app/orders/page.tsx
export default function OrdersPage() { return <ProductLab view="orders" />; }
```

Only **11 of 150** files in `src/` are `"use client"`. The rest are pure TypeScript. So a public page can be a Server Component that fetches its menu server-side and renders a small client form — no architectural change, just the first use of a capability the App Router already gives us.

**`src/app/page.tsx` (the root URL) renders `<ProductLab />`** — the internal app behind `LoginScreen`. There is no public landing page, no public layout, no public nav. `/launch` is `<ProductLab view="launch" />`, and `LaunchOfferBuilder` remains a non-functional stub. **Selling must not be built inside it** (frozen plan §3).

### 2.3 Security posture — public visitors can currently do nothing

- The **only** `anon` grant in the entire schema is `grant usage on schema public to anon, authenticated;` (`supabase-fix-permissions.sql:1`). **No table grants to `anon` anywhere.**
- All **108** RLS policies across the schema are `to authenticated`, `using (true)`.
- Catalog tables (`products`, `product_batches`, `costing_summaries`, `selling_formats`) are `grant … to authenticated` only.
- `supabase-add-orders.sql:553-554`:
  ```sql
  revoke execute on function save_order(jsonb, jsonb, uuid[]) from public;
  grant  execute on function save_order(jsonb, jsonb, uuid[]) to authenticated;
  ```

**Two consequences that drive the whole design:**

1. **An unauthenticated browser can read nothing and write nothing.** There is no accidental exposure to clean up — but there is also no way for a public browser to read the menu. The menu must be served.
2. **`service_role` is a *distinct* Supabase role, not a member of `authenticated`.** After `revoke … from public`, `service_role` most likely has **no EXECUTE on `save_order`** — the same `42501 permission denied` that live G1 verification produced for `anon`. Using service-role would therefore require **new grants** and its own live verification. Signing in as a real user does not: the S5/S6 live smoke already proved `authenticated` + `save_order` works end to end.

### 2.4 The domain layer is pure and server-safe

`src/lib/orders/**` imports no client, no clock, no `process.env`. `getSellableItems(products, batches, costings, sellingFormats)` is a pure function over arrays — **it runs identically on the server.**

Two existing functions do the security-critical work for free:

```ts
// src/lib/orders/menu.ts:114 — unitPrice is OPTIONAL
export function buildCatalogOrderLine(item, { id, orderId, quantity, sortOrder, unitPrice }) {
  return { …, unitPrice: unitPrice ?? item.unitPrice, piecesPerUnitSnapshot: item.piecesPerUnit, … };
}
```
**Omit `unitPrice` and the catalog price wins.** The internal form passes it (operators may legitimately edit a price); the public route simply will not.

```ts
// src/lib/orders-repository.ts:497 — validate-everything-then-write
export async function submitNewOrder(client, { order, lines, newCustomer, now }) { … }
```
Already validates customer + order + lines **before any write**, upserts the customer by a stable id, then calls `save_order`. This is exactly the public flow's shape.

`validateOrderForSave` already enforces integer quantity ≥ 1, price ≥ 0, line→order ownership, format-without-product, duplicate line ids, and the money invariants.

### 2.5 Imagery already exists

`public/product-images/` holds 6 PNGs (`P001_Brownies.png` … `P006_Bottled_Spanish_Latte.png`) and `Product.image` is already a field (`main_photo_url`, mapped at `src/lib/supabase-mappers.ts:79` and `src/app/product-lab.tsx:369`). The public menu needs **no new asset infrastructure**.

### 2.6 Environment / deployment

Vercel, Next.js **16.2.11**, React **19.2.4**, `@supabase/supabase-js` ^2.110.8. `next.config.ts` has no custom server config beyond turbopack root and inventory redirects. No middleware file exists.

**Server-side auth precedent already exists** in `scripts/daily-advisor/env.ts`: `ADVISOR_SUPABASE_EMAIL` / `ADVISOR_SUPABASE_PASSWORD` sign in as a real user. S9 follows that pattern, not a new one.

---

## 3. Current architecture

```
 browser (anon key, "use client")
        │
        ├─ every route → <ProductLab> → LoginScreen unless session
        │                                    │
        │                              signed-in operator
        │                                    ▼
        └──────────────── supabase-js ──▶ Postgres + RLS (all policies: to authenticated)
                                              customers / orders / order_lines
                                              save_order(jsonb,jsonb,uuid[])  [authenticated only]

 anon role: `usage on schema public` and nothing else.   ← no public read, no public write
```

## 4. Proposed public-order architecture

```
 customer's phone                                          ┌──────────── server only ────────────┐
 (no credentials at all)                                   │                                     │
        │                                                  │  src/lib/supabase-server.ts         │
        │  GET /order  ───────────────────────────────────▶│  website user (email+password)      │
        │  ◀── HTML + menu (name, format, price, pcs, img) │  cached session, module scope       │
        │                                                  │                                     │
        │  POST /api/public-orders                         │  src/app/api/public-orders/route.ts │
        │  { idempotencyKey, items:[{productId,            │   1. validate shape + limits        │
        │      sellingFormatId, quantity,                  │   2. rebuild menu from DB           │
        │      displayedUnitPrice}],                       │   3. resolve each item → SellableItem│
        │      customer:{name,phone}, notes,               │   4. compare displayed vs catalog   │
        │      requestedTime, source, sourceRef }          │      mismatch → 409, ZERO writes    │
        │                                                  │   5. buildCatalogOrderLine (NO price)│
        │  ◀── { ok } | { 409 prices-changed, menu }       │   6. orderId = uuidv5(key)          │
        │      (success is generic — no order data)        │   7. order exists → generic OK, no write│
        │                                                  │   8. else submitNewOrder(...) ──────┼──▶ save_order
        └──────────────────────────────────────────────────┘                                     │
                                                                                                 │
 operator → /orders → the SAME list, entry_method='website', status='new' ────────────────────────┘
          → Confirm → Mark paid → Ready → Complete   (already shipped, unchanged)
```

---

## 5. Exact trust boundary

| | Browser | Server |
|---|---|---|
| **Receives** | product name, format name, price, pieces/unit, image | the submission payload |
| **Sends** | `productId`, `sellingFormatId`, `quantity`, `displayedUnitPrice` *(comparison only)*, name, phone, notes, requested time (free text), `source`, `sourceRef`, `idempotencyKey` | — |
| **Never sends / is ignored if sent** | `unit_price`, `item_name`, `pieces_per_unit_snapshot`, `entry_method`, `status`, `payment_status`, any `paid_*`/`refunded_at`, `customerId`, `orderId` | — |
| **Determines** | *nothing authoritative* — `displayedUnitPrice` can only **stop** an order, never set one | every price, name, pack size, id, status, and timestamp |

**The browser selects; the server decides.** A tampered request claiming `unitPrice: 1` is not rejected — the field simply does not exist in the server's line construction, because `buildCatalogOrderLine` is called without the override. There is nothing to validate away.

`displayedUnitPrice` is the one number the browser sends that the server reads, and it is deliberately powerless: it is compared, and a mismatch **cancels** the submission. It cannot raise, lower, or set a recorded price, so tampering with it only rejects the attacker's own order.

---

## 6. Q-by-Q resolutions

### Q1 — Server boundary: **Route Handler + dedicated website user**

`POST /api/public-orders` as a Next.js Route Handler (`export const runtime = "nodejs"`), matching the frozen plan's named shape.

**Credentials: decided by measurement, not inference (P1).** The working assumption is a dedicated Supabase **website user** rather than `service_role`, because §2.3 predicts `service_role` lost EXECUTE on `save_order` to the explicit `revoke … from public`, and because blast radius is equivalent either way (every policy is `using(true)`) — so service-role would buy no safety, only a second secret class. **But that prediction is an inference from SQL text, and it gets tested before anything is built.**

**P1 probe — run first, record the result in the PR:**

| Path | Probe | Expected |
|---|---|---|
| Website user (`authenticated`) | sign in, call `save_order` with a throwaway payload | succeeds (already evidenced by the S5/S6 live smoke) |
| `service_role` key | call `save_order` directly | `42501 permission denied for function save_order` |

If `service_role` unexpectedly **succeeds**, that is a finding worth recording — it would mean the function is reachable by a role the migration's `revoke` was intended to exclude, and it should be reported before proceeding. **Keep the website user if it remains the least-privilege credential that works**; adopt service-role only if the website-user path proves unworkable, and say why.

```
PUBLIC_ORDER_SUPABASE_EMAIL      # server-only, no NEXT_PUBLIC_ prefix
PUBLIC_ORDER_SUPABASE_PASSWORD
```

Reuses `NEXT_PUBLIC_SUPABASE_URL`.

**Server-only enforcement, explicit:**

- `src/lib/supabase-server.ts` starts with `import "server-only"`, so any accidental import from a client component is a **build error**, not a runtime surprise. This is stronger than relying on the missing `NEXT_PUBLIC_` prefix alone; both are used.
- The route handler declares `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"` — never statically evaluated, never edge-bundled.
- A test asserts no `"use client"` module transitively imports `supabase-server.ts` or anything under `src/app/api/`.

**Auth persistence and refresh semantics, documented:**

```ts
createClient(url, anonKey, {
  auth: {
    persistSession: false,     // no storage exists on a server; never write a session anywhere
    autoRefreshToken: false,   // no background timers in a serverless invocation
    detectSessionInUrl: false, // there is no URL fragment to read
  },
})
```

The session is held in **module scope only**, which survives warm invocations and dies with the instance. Refresh is explicit rather than timer-driven: the route calls, and on a `401`/`PGRST301` it signs in once and retries exactly once. A second failure returns `503` with generic copy. This avoids both the "background refresh in a frozen serverless container" failure mode and any on-disk session artifact.

### Q2 — Customer + order consistency: **reuse `submitNewOrder`, no new RPC**

The public flow is the same shape as the internal one, so it uses the same function. `submitNewOrder` already: validates everything before writing → upserts the customer by a **stable** id → calls `save_order`.

**Partial-failure analysis.** The only residual is: customer written, `save_order` fails → one orphan customer row. This is *already* the accepted behaviour of the approved model, documented in `submitNewOrder`'s own comment. For the public flow it is *less* harmful, because the customer id is derived (below), so a retry reconciles onto the same row rather than adding another.

**REVISED IN REVISION 3 — see §0.2.** Revision 2 concluded here that *"no new RPC is justified"*, reasoning that a wrapper would be a second Order persistence implementation. Live concurrency testing during PR-F2 disproved the premise rather than the concern: an application-side existence check **cannot** provide create-once semantics, because the check and the write are separate transactions and a caller can pause between them. A second caller reset a confirmed, paid order to `new`/`unpaid`.

Public creation now goes through **`save_public_order_once`**, which serializes on the derived order id with a transaction-scoped advisory lock, checks existence under that lock, and **delegates persistence to `save_order`**. The wrapper contains no insert, no upsert and no line handling — so `save_order` remains the canonical order+lines writer, and the concern Revision 2 was protecting is preserved intact. The application-side check survives only as a fast path and is explicitly no longer correctness-critical.

> **⚠ The one genuinely new hazard, and it must be designed for.** `save_order` **upserts the whole order row, payment columns included** — that is correct for creation and is exactly the constraint recorded in PR-D. A replayed public submission carrying an order id that already exists would therefore reset a confirmed, paid order back to `new`/`unpaid` and wipe `paid_at`/`paid_amount`.
>
> **Rule: the route must never call `save_order` for an order id that already exists.** It reads the order first; if present, it **writes nothing** and returns a **generic success**. This is the S9 form of "`save_order` must not become an existing-order edit path", and it is the highest-value assertion in the whole slice.

**The replay response discloses nothing.** When the derived order already exists, the response is the same generic shape a first-time submission gets — *"Order request received."* It must **not** echo back the stored order's items, total, customer name, timestamps, status, or payment state. Two reasons: the caller may not be the original submitter (a guessed or replayed key must never become a read oracle for someone else's order), and there is no legitimate need — the original submitter already saw their confirmation. Zero write, zero disclosure.

### Q3 — Authoritative pricing: server rebuilds every line

1. Server loads `products`, `product_batches`, `costing_summaries`, `selling_formats`.
2. `getPublicMenu(...)` → `getSellableItems(...)` → the same Product → latest Batch → linked Costing → active Selling Format semantics. **No costing formula is duplicated.**
3. Each submitted `{productId, sellingFormatId, quantity}` is resolved to a `SellableItem` via `findSellableItem`. **Unresolvable → reject the whole submission** (the format was archived or the costing changed mid-session).
4. `buildCatalogOrderLine(item, { id, orderId, quantity, sortOrder })` — **no `unitPrice` argument.**

Result: `unit_price`, `item_name`, `pieces_per_unit_snapshot`, `product_id`, `selling_format_id` are all sale-time catalog facts. Internal operator price editing is untouched.

**Stale displayed price — the server stays authoritative, but does not quietly charge a different number.**

There is a real gap between the page loading and the customer submitting. If a price changes in that window, two things are both true: the catalog price must win (never the browser's), *and* creating the order silently at a price the customer never saw is a bad way to meet a customer.

So the browser additionally sends `displayedUnitPrice` per line — **for comparison only, never for writing:**

- Server computes the authoritative line from the catalog, exactly as above.
- Server compares each authoritative `unitPrice` against the submitted `displayedUnitPrice`.
- **Any mismatch → no order is created.** The response is `409` with a `prices-changed` reason and the current menu, and the page re-renders with the new prices and a short note asking the customer to confirm. Their items and details are preserved; only the prices refresh.
- Match → proceed.

`displayedUnitPrice` is never written, never used as a fallback, and never trusted as a price. It is a **claim about what the customer was shown**, and its only power is to *stop* the order — it can never raise, lower, or set the recorded price. A tampered `displayedUnitPrice` therefore achieves nothing except rejecting the attacker's own submission.

The same check covers a product going non-public or a format being archived mid-session: unresolvable ⇒ the same review response, never a silent substitution.

### Q4 — Public menu read: **server-rendered, no anon grants**

The page is a Server Component that reads the catalog with the website user and passes a **sanitized** menu to the client form: `{ productId, productName, image, formats: [{ sellingFormatId, formatName, unitPrice, piecesPerUnit }] }`.

No costing, no batch, no margin, no internal terminology ever crosses the boundary. **No `anon` grant is added** — the §2.3 posture stays exactly as it is. No dedicated read-model table is warranted; the pure function over already-loaded arrays is the smallest safe solution.

### Q5 — Idempotency: derived order id + existence check

The browser mints an `idempotencyKey` (uuid) **once per form**, mirroring the `resolveOrderId`/`resolveCostingId` philosophy already established. The server derives `orderId = uuidv5(idempotencyKey, PUBLIC_ORDER_NAMESPACE)` and the customer id the same way.

**Key lifecycle — when the key is kept and when it is replaced:**

| Moment | Key |
|---|---|
| Form first rendered | Mint key `K` |
| Any retry of the same submission — double tap, timeout, network error, user pressing again | **Keep `K`.** Retrying is the case idempotency exists for. |
| Submission returns a definitive **failure** (validation, unresolvable item, stale price) | **Keep `K`.** Nothing was created; the corrected resubmission is still the same logical order. |
| Submission **succeeds** (first time or replay) | **Mint a fresh key.** The completed order is closed; the next submission is a genuinely new order. |
| Customer starts a new order / reloads the page | Fresh key. |

Keeping `K` after success would make a customer's genuine second order silently collapse into their first. Minting a new key on every attempt would defeat idempotency entirely. The rule is: **one key per logical order, replaced only once that order exists.**

| Scenario | Outcome |
|---|---|
| Double tap | Same key → same id → existence check → one order |
| Slow connection, user retries | Same key → same id → one order |
| Network timeout then retry | Same key → same id → one order |
| Replay after operator confirmed/paid | Existence check short-circuits → **nothing written, generic success** |
| Customer orders again next week | New key → new id → a second, separate order |
| Two concurrent identical submits | Both may pass the check; `save_order` upserts by id → one row |

The browser never supplies the order id directly, so an attacker cannot aim a submission at an existing order — they would need a preimage of its uuidv5.

### Q6 — Attribution

`/order?source=instagram&ref=POST-184`:

- `source` → `isOrderSource(raw) ? raw : "unknown"` — the guard already exists in `src/lib/orders/types.ts:211`. Invalid values degrade to `unknown`; nothing is reinterpreted as a real channel.
- `source_ref` → **opaque**, stored verbatim, capped at 200 chars (a length limit is not parsing). Never joined, never validated as a URL or id.
- `entry_method` → **always `"website"`, server-set, never accepted from the payload.**

No Content FK, no campaign table, no UTM framework. The customer is never shown an attribution control.

### Q7 — Customer identity: **name + phone** *(owner decision)*

| Field | Required | If removed, what breaks |
|---|---|---|
| Name | ✅ | Cannot address the customer or tell two orders apart. `customers.name` is `not null`. |
| Phone | ✅ | **Cannot confirm the order at all.** This is the field that makes the pipeline work. |
| Messenger handle | ❌ omitted | Phone covers confirmation; a second channel adds a field and saves nothing today. |
| Email | ❌ omitted | No transactional email exists to send. It would be a field collected and never read. |

Two fields. No accounts, no passwords, no profiles, no CRM. Existing-customer matching is **not** attempted at submit time — `findPossibleDuplicateCustomer` stays an internal operator hint; silently merging a public submission into an existing customer on a name/phone guess would be worse than a duplicate the operator can see.

> **Known S9 boundary — public repeat customers are not recognised.** A returning customer ordering through the public page gets a **new `customers` row every time**, because the customer id is derived from a per-order idempotency key and no identity is asserted. Consequences, stated plainly:
>
> - `customers` accumulates near-duplicate rows for the same person (same name, same phone).
> - **Repeat-buyer status — `count(orders)` per customer — under-reports for public orders**, and would under-report for a future S8 Business Context `repeatCustomerCount` fact.
>
> **This is recorded, not solved, in S9.** Solving it means either customer accounts (explicitly out of scope) or automatic phone-based matching, and auto-matching on a phone number silently merges two people who share a handset — a wrong answer that looks authoritative, which is the exact failure class the whole Selling design has been avoiding. The operator can see and merge duplicates; a machine guessing cannot be seen. Revisit when public volume makes manual reconciliation genuinely painful, and note that `repeat` is *already* deliberately absent from `ORDER_SOURCES` for the same reason (frozen plan §8, R13).

### Q8 — Fulfilment: **pickup only at launch** *(owner decision)*

Public form writes `fulfillment_method: "pickup"`, `fulfillment_address: ""`. No address field renders at all — the largest single friction win available.

**Requested time vs agreed time — the distinction matters and the schema already expresses it.** S5 defined `fulfillment_at` as the *agreed* handover time, with `null` meaning "not scheduled yet". A customer's request is not yet agreed, so:

- `fulfillment_at` → **`null`** on submission.
- The customer's requested time → free text in `fulfillment_notes` (e.g. *"Saturday afternoon if possible"*).
- The operator sets the real `fulfillment_at` with **Edit schedule** (shipped in S5) when they confirm.

This needs no new field, no second state machine, and keeps `fulfillment_at` honest. Public orders correctly appear under **"Not scheduled"** until confirmed.

### Q9 — Payment: none

The submission is an **order request**. `payment_status` is `unpaid`, server-set; no payment field is accepted from the browser. Confirmation copy:

> **Order request received.** Aly & Pon will message you on the number you gave to confirm your order and arrange payment and pickup. Nothing has been charged.

No gateway, no deposit, no checkout session, no webhook, no automatic paid state. Verified against the frozen plan: S9 says only *"Writes through the same `save_order` RPC with `entry_method = 'website'`"*.

### Q10 — Abuse controls

| Control | Class | Rationale |
|---|---|---|
| Server-side validation of every field (reuse `validateOrderForSave`) | **Required** | The only thing between the DB and an arbitrary POST body. |
| Payload size cap (~16 KB) + max 20 line items + quantity ≤ 50/line | **Required** | Cheap; prevents a single request from creating an absurd order. |
| `entry_method`, prices, ids, status, payment all server-set | **Required** | §5. |
| Existence check before `save_order` | **Required** | Prevents replay resetting a paid order (Q2). |
| Reject unresolvable product/format | **Required** | Prevents ordering something not on sale. |
| Honeypot field | **Cheap recommended** | ~10 lines, stops naive bots. |
| Origin/Referer check on POST | **Cheap recommended** | Not CSRF protection in the classic sense (no cookie auth, no ambient authority), just cheap noise reduction. |
| Simple in-memory per-IP rate limit (e.g. 5/min) | **Cheap recommended** | Best-effort on serverless; useful, not load-bearing. |
| CAPTCHA / Turnstile | **Defer until abuse occurs** | Real friction on the exact step we are optimising. Add when spam is observed. |
| Durable rate limiting (Upstash/Redis) | **Defer** | Infrastructure a home bakery does not need on day one. |
| WAF, bot detection, fraud scoring | **Defer** | Enterprise infrastructure; explicitly not prescribed. |

**No CSRF token is needed:** the endpoint carries no ambient authority — there is no user session in the browser to ride on.

---

## 7. Customer UX — the minimum page

One screen, mobile-first, no steps or wizard.

```
┌──────────────────────────────────┐
│  Aly & Pon                       │
│  Order for pickup                │
├──────────────────────────────────┤
│ [img] Brownies                   │
│       Box of 6      ₱480   [− 1 +]│
│       Box of 12     ₱900   [− 0 +]│
│ [img] Cookies                    │
│       Pack of 6     ₱240   [− 0 +]│
├──────────────────────────────────┤
│ Your name      [_______________] │
│ Mobile number  [_______________] │
├──────────────────────────────────┤
│ When would you like it? (optional)│
│                [_______________] │
│ Anything else? (optional)         │
│                [_______________] │
├──────────────────────────────────┤
│ Total                      ₱480  │
│ [   Place order request   ]      │
│ Aly & Pon will message you to    │
│ confirm. Nothing is charged now. │
└──────────────────────────────────┘
```

**Friction review — every field justified or cut:**

| Field | Verdict |
|---|---|
| Item quantities | Keep — the order. |
| Name, mobile | Keep — Q7. |
| When (free text, optional) | Keep — optional, and the operator needs *some* signal. |
| Notes (optional) | Keep — one field absorbs every request we didn't anticipate. |
| Pickup/delivery | **Cut** — pickup only at launch. |
| Address | **Cut** — follows from pickup-only. |
| Email | **Cut** — nothing sends email. |
| Messenger handle | **Cut** — phone confirms. |
| Source picker | **Cut** — attribution comes from the link, never the customer. |
| Account / password | **Cut** — never in scope. |
| Custom/manual line | **Cut** — public customers order from the menu. |

**Confirmation:** a simple screen showing the customer's name, their items, the total, and what happens next. **No order-number system.** At tens of orders a week the operator identifies an order by customer + date, exactly as the frozen plan argues for the internal case (§4.2, "No `order_code`"). Internal UUIDs are not shown. A `bigint generated by default as identity` column remains the additive fix if the owner ever asks for "order #14".

---

## 8. Internal `/orders` compatibility

A public submission is **just an Order**. It lands as:

```
status          = 'new'          (DB default, server-set)
payment_status  = 'unpaid'       (DB default, server-set)
entry_method    = 'website'      (server-set, never from payload)
source          = validated or 'unknown'
source_ref      = opaque
fulfillment_method = 'pickup'
fulfillment_at  = null           → shows as "Not scheduled"
lines           = catalog snapshots (name, price, pieces)
```

It appears in the same list, in the same `new` state, and uses the already-shipped **Confirm → Mark paid → Ready → Complete** workflow. **No public-order status model, no separate queue, no second workflow.** The operator may notice it only by the source label.

**S7/S8 compatibility:** nothing is needed. S7's readout and S8's Business Context adapter read `orders`/`order_lines`, and public orders are ordinary rows on those tables — `entry_method` is the *only* thing distinguishing them, and neither slice needs to care. **They are just Orders.** The one thing S9 must not do is introduce a parallel table or a `website_orders` view; it does not.

---

## 9. Schema changes — one column, and only because of an owner decision

```sql
-- supabase-add-public-ordering.sql   (idempotent, purely additive)
alter table products add column if not exists is_public boolean not null default false;
create index if not exists products_is_public_idx on products (is_public) where is_public;
```

`default false` means **nothing becomes public by accident** — every product is opted in deliberately.

**No other schema change is required.** No new table, no new RPC, no new grant, no policy change, no `anon` grant. `orders`, `order_lines`, `customers`, and `save_order` are untouched — verified against §2.3 and the existing migration.

---

## 10. Files expected to change

**New**

| File | Purpose |
|---|---|
| `supabase-add-public-ordering.sql` | The one column + index, with the repo's guarded preflight block |
| `src/lib/supabase-server.ts` | **Server-only** client: website-user sign-in, module-scoped session, re-auth on 401 |
| `src/lib/orders/public-menu.ts` | `getPublicMenu()` (3 lines, delegates to `getSellableItems`) + the sanitized menu type |
| `src/lib/orders/public-submission.ts` | Payload type, `validatePublicSubmission()`, `buildPublicOrder()` — pure, no client |
| `src/app/api/public-orders/route.ts` | The `POST` handler |
| `src/app/order/page.tsx` | Server Component: loads menu, own `metadata`, renders the form |
| `src/components/public-order-form.tsx` | `"use client"` — the single-screen form |
| `tests/public-menu.test.ts`, `tests/public-submission.test.ts`, `tests/public-order-route.test.ts` | Coverage below |

**Modified (small, surgical)**

| File | Change |
|---|---|
| `src/lib/product-lab-types.ts` | `isPublic: boolean` on `Product` |
| `src/lib/supabase-mappers.ts` (~:79) | Map `is_public` |
| `src/app/product-lab.tsx` (~:369, ~:664) | Map + persist `is_public` (2 lines) |
| `src/components/product-controls.tsx` | One "Show on public order page" toggle |

---

## 11. PR sequence

| PR | Contents | Reviewable because |
|---|---|---|
| **PR-F1** | `is_public` column + type/mapper/toggle + `getPublicMenu` + tests | No public surface yet. Pure schema + read model; the menu semantics can be reviewed against `getSellableItems` alone. |
| **PR-F2** | `supabase-server.ts` + `POST /api/public-orders` + submission validation + tests | **The security-critical PR.** No UI, so review is entirely about the trust boundary, price authority, idempotency, and the existence check. Deserves isolated adversarial review. |
| **PR-F3** | `/order` page + form + confirmation | The customer-facing surface. Pure UX once F2's contract is fixed. |

---

## 12. Verification strategy

**Unit (existing `node --test`, hand-built stubs — no new framework):**

- `getPublicMenu` excludes non-public products, and otherwise matches `getSellableItems` exactly (same input minus the flag ⇒ same output).
- A submitted `unitPrice` / `itemName` / `piecesPerUnitSnapshot` / `entryMethod` / `status` / `paymentStatus` / any `paid_*` field is **ignored**; the persisted line carries the catalog price.
- **Ordering a ₱480 item for ₱1 is impossible** — asserted directly, from a hostile payload.
- Unresolvable product/format rejects the whole submission.
- `entry_method` is always `website`; `status`/`payment_status` are always `new`/`unpaid`.
- Invalid `source` degrades to `unknown`; `source_ref` round-trips byte-for-byte and is length-capped.
- Same `idempotencyKey` twice ⇒ one order, one customer.
- **A submission whose order id already exists writes nothing** — asserted against a stub that fails the test if `save_order` is called. Run with the persisted order `confirmed`/`paid` to prove payment history cannot be reset.
- **The replay response discloses nothing** — asserted field-by-field: the body carries no items, total, customer name, status, payment state, or timestamps, and is byte-identical to a first-time success.
- **Stale price rejects rather than creates** — a submission whose `displayedUnitPrice` differs from the catalog produces `409 prices-changed` and **zero writes** (stub fails the test if `save_order` is called). A tampered high or low `displayedUnitPrice` likewise creates nothing.
- **`displayedUnitPrice` can never set a price** — with a matching displayed price, the persisted `unit_price` still comes from the catalog object, proven by mutating the catalog value only.
- Quantity/line-count/payload-size limits reject before any write.
- No `order_lines` write path is introduced; **M1 remains unreachable**.
- Structural: no `"use client"` module transitively imports `supabase-server.ts` or `src/app/api/**`; the website-user secrets carry no `NEXT_PUBLIC_` prefix; `supabase-server.ts` declares `import "server-only"`; the server client is constructed with `persistSession: false` / `autoRefreshToken: false`.

**Mutation testing** on the five assertions that matter most — each must fail its own test and only that test: remove the existence check · pass `unitPrice` through to `buildCatalogOrderLine` · accept `entry_method` from the payload · skip the stale-price comparison · echo the existing order back in the replay response.

**P1 credential probe (run before PR-F2 is written):** measure both paths against `save_order` — website user and `service_role` — and record both outcomes verbatim in the PR, including the case where `service_role` unexpectedly succeeds.

**Live Supabase (self-cleaning, fake data, the established pattern):** submit through the real route → appears in `/orders` as `new`/`unpaid`/`website` with catalog prices and `fulfillment_at` null → replay the same key ⇒ still one order, generic response, nothing disclosed → confirm + mark paid, then **replay again and prove `paid_at`/`paid_amount`/`status` are unchanged** → change a selling price and submit a stale payload ⇒ `409`, zero rows created → submit with a fresh key ⇒ a genuinely separate second order → operator sets `fulfillment_at` via Edit schedule → clean up, verify zero residue.

**Baseline to preserve:** `1985 tests · 1982 pass · 2 known fail · 1 skip`, tsc `0`, lint `1 known error / 0 warnings`. The two CRLF fixture failures, the platform skip, and `bake-page.tsx:58` are **not** to be fixed.

---

## 13. Failure & retry scenarios

| Scenario | Behaviour |
|---|---|
| Customer double-taps | One order (derived id + existence check) |
| Submit succeeds, response lost, user retries | One order; second call returns the same **generic** success |
| `save_order` fails after customer upsert | One orphan customer, no order. Retry with the same key reconciles onto the same customer row. Accepted, and no worse than the internal path. |
| Format archived, or product un-published, between page load and submit | Whole submission rejected with the review response; nothing partially written |
| **Price changed between page load and submit** | `409 prices-changed` + current menu; **no order created**; page refreshes prices, keeps items and details, customer confirms |
| Website user session expired | Re-sign-in once, retry once; second failure returns a generic 503 with no internal detail |
| Supabase unreachable | 503, generic copy, no stack trace or DB message reaches the browser |
| Replay after operator confirmed and paid | **Nothing written, nothing disclosed.** Payment and lifecycle facts intact. |
| Customer returns next week and orders again | Fresh key ⇒ a separate order — and a **separate customer row** (known boundary, Q7) |

---

## 14. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Replay or a CONCURRENT second submission resets a paid order** (`save_order` writes the whole row) | **Revised in Revision 3.** An application-side existence check was proven insufficient against the live database — see §0.2 for the reproduced trace. Creation now runs through `save_public_order_once`, which serializes on the derived order id with a transaction-scoped advisory lock, checks existence under it, and delegates to `save_order`. The application check remains only as a fast path. **The single highest-value guard in this slice.** |
| R2 | Customer dictates price | Server rebuilds lines; `buildCatalogOrderLine` called without `unitPrice`. Hostile-payload test. |
| R2b | **Customer charged a price they never saw** | `displayedUnitPrice` compared, not trusted: any mismatch returns `409 prices-changed` with zero writes. The comparison can only *stop* an order, never set a price. |
| R3 | Server secret leaks to the browser | `import "server-only"` (build error, not runtime surprise) **plus** no `NEXT_PUBLIC_` prefix **plus** a structural test that no client module transitively imports it |
| R3b | Replay used as a read oracle for someone else's order | Replay returns a generic success carrying no order data at all; asserted field-by-field |
| R3c | Server session written to disk or refreshed by a dead timer | `persistSession: false`, `autoRefreshToken: false`; module-scope session only, explicit re-auth on 401, one retry |
| R4 | Public surface widened via `anon` grants | **No `anon` grant is added.** Menu is server-rendered. Schema test asserts the absence. |
| R5 | A second Order persistence path appears | `save_order` via `submitNewOrder` only; test asserts exactly one RPC call per submission |
| R6 | Products go public unintentionally | `is_public` defaults to `false`; explicit opt-in |
| R7 | Customer's requested time treated as agreed | `fulfillment_at` stays `null`; request lives in `fulfillment_notes`; operator confirms via S5's Edit schedule |
| R8 | Spam floods the order list | Honeypot + best-effort rate limit now; CAPTCHA only if abuse actually occurs |
| R9 | Duplicate customer rows accumulate; **repeat-buyer counts under-report for public orders** | Derived customer id makes *retries* idempotent, but a genuine return visit creates a new row. **Recorded as a known S9 boundary (Q7), deliberately not solved** — auto-matching on a phone number silently merges two people who share a handset, which is a wrong answer that looks authoritative. Operator-visible duplicates beat invisible machine guesses. |
| R9b | A future S8 `repeatCustomerCount` fact reads low | Same boundary. S8 must publish it as a measurement with this limitation stated, not as a verdict — consistent with the adapter discipline already in the frozen plan §6.3. |
| R10 | Order-line editing sneaks in, making M1 live | S9 introduces no line editing; asserted |

---

## 15. Explicit non-goals

Payment gateway · deposits · partial payments/refunds · customer login/accounts/profiles/loyalty · coupons/promos · finished-goods reservations · inventory availability promises · **any inventory write** · delivery routing/driver tracking · Content FK · campaign entities · UTM analytics framework · AI chatbot ordering · marketplace integration · order-number system · S7 dashboard · S8 BCB adapter · S10 hardening · order-line editing · a second fulfilment state machine.

---

## 16. Verdict

**GO WITH PREREQUISITES — frozen at Revision 2, approved for implementation.**

S9 is unusually cheap because S1–S6 did the hard work. The public surface adds **one column, one server client, one route, one page, one form** — everything load-bearing (atomicity, price snapshots, lifecycle, payment independence, attribution) is consumed unchanged. Every completed Selling guarantee survives: `save_order` stays the canonical writer, prices stay server-authoritative, payment facts stay independent and unreachable from a public submission, fulfilment stays one lifecycle, `source_ref` stays opaque, inventory receives zero writes, and no order-line editing appears — so **M1 remains unreachable**.

Four things deserve the most review attention, and none of them is the UI:

1. **The existence check before `save_order`** — the difference between a safe public endpoint and one that can silently un-pay a confirmed order, and the reason the replay response discloses nothing.
2. **The credential choice, measured rather than argued (P1)** — both paths probed against `save_order`, result recorded either way.
3. **`displayedUnitPrice` as a stop, never a setter** — it can reject an order but can never influence a recorded price.
4. **Server-only enforcement** — `import "server-only"` makes a client import a build failure, not a leak.

One limitation is accepted and written down rather than engineered around: **public repeat customers are not recognised**, so repeat-buyer counts under-report for public orders (Q7, R9). Solving it needs accounts or phone-matching, and phone-matching silently merges two people who share a handset — a wrong answer that looks right.

Prerequisites **P1** (credential probe, then provision) and **P2** (`is_public`) are both small and independently verifiable.

**Recommended first action on approval: implement PR-F1** — schema column, type/mapper/toggle, `getPublicMenu`, and tests. It carries no public surface and no server boundary, so it can land and be reviewed on its own merits while the P1 probe runs.
