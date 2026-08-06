# Features

> Catalog by area, with status. The source of truth for whether a feature EXISTS —
> not whether it is good.

## Products

| Status | What it adds |
|---|---|
| Done | Add/Edit/Delete a product from the Product Admin page (`/admin`). Products were previously a hardcoded 6-item array (`src/lib/sample-data.ts`) with no way to add a new one at all -- they now load from and save to the `products` Supabase table (or `localStorage` in offline mode), the same dual-mode pattern as every other entity. A new product immediately appears in the Proof Day product picker and, once it has a proof batch, the Costing page's batch selector -- the same flow the original 6 products already went through. Delete is reference-gated: a product with any linked batches/costing/tasting/journal records can't be hard-deleted (set `status` to Paused instead); an unused product can be deleted outright. |

## Inventory

Delivered incrementally as 5 milestones; each one ships as its own working, tested slice.

| Milestone | Status | What it adds |
|---|---|---|
| M1 — Ingredient master, Inventory page, Need to Buy | Done | Create/edit ingredients (name, base unit, current quantity, low-stock threshold, target stock, optional expiration date, optional average unit cost). Stock-status pill (Out/Low/Good). Computed inventory value (qty × avg cost). Need to Buy list with suggested purchase quantity. |
| M2 — CSV import, ingredient aliases, ledger | Done | Upload a purchase receipt CSV (Import Purchase CSV page), auto-map or manually map columns, resolve rows to ingredients (saved alias → exact → normalized → manual — no fuzzy matching), preview with zero inventory impact, exclude/re-include rows, Confirm import increases inventory exactly once and records a weighted-average cost update, correct earliest-expiration-date, and one `inventory_transactions` entry per affected ingredient. Manually assigning a row saves an alias so the same receipt text auto-resolves next time. Inventory Timeline page shows every transaction, grouped by date, with ingredient/quantity/type/source. |
| M3 — Bake, deduct inventory, ledger | Done | Bake page: pick a Proof Day batch, resolve its formula (alias → exact → normalized → manual, shared with CSV import), enter "Batches made" (decimal, must be > 0) with a read-only computed pieces-produced readout, preview grouped deductions with current/needed/resulting quantity per ingredient. Confirm blocked while any row is unresolved or stock is insufficient; an explicit override checkbox allows an insufficient bake to proceed into negative stock. Confirm deducts each affected ingredient exactly once, records one `consume`/`bake` transaction per ingredient, and never touches average unit cost. Guarded against a fast double-click deducting twice. |
| M4 — Expiration, Dashboard cards | Done | Expiration-status badge (Expired / Expires today / Expires soon within 3 days / Good / none) on the Inventory page, rendered as its own badge next to — never merged with — the stock-status pill. Dashboard gains 3 summary cards: Low stock, Out of stock, Expiring, all driven by one `getInventorySummaryCounts()` call. |
| M5 — RPC atomicity | Not started | Wraps the already-working M2/M3 confirmations in Postgres RPC functions for real transaction atomicity. No new business logic. |

## Marketing — Creative Pipeline

| Feature | Status | What it adds |
|---|---|---|
| PROP-034 — Daily Recommendation Readiness | Implemented, pending real-environment verification and Scheduled Task registration | A scheduled offline worker (`npm run creative-prep`) that advances the newest eligible Opportunity to a ready Creative Package before the owner opens the app, using a new deterministic, non-AI Creative Package initializer (`opportunity_brief` worker) instead of the placeholder `mock` worker or a paid AI API. Detects (never recovers) a suspiciously long-`running` Creative Job as a reporting-only failure signal. See `docs/ARCHITECTURE.md`'s "Daily Recommendation Readiness (PROP-034)" section and `planning/PROPOSALS.md`. |
