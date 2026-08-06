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

## Brand Foundation

| Status | What it adds |
|---|---|
| Done | `/brand` page: the single source of truth for Aly & Pon's current branding -- Business Name, Brand Status (Exploring/Provisional/Final -- the maturity of the branding decisions, not the business's operating stage), one-line description, target audience, Primary/Secondary/Background/Accent color (swatch + hex + copy, genuinely unset until chosen -- never a fabricated `#000000`), and one Brand Guidelines textarea covering aesthetic, photography style, keywords, mood, inspiration, and things to avoid. One page, one form, one always-active record -- no list, no create/delete flow. Deliberately excludes logo/profile-picture/cover-photo upload, Supabase Storage, typography, brand voice, CTA configuration, phrase lists, version history, multiple profiles, approvals, and AI generation -- each is unbuilt and would need its own separate authorization. |
| Done | Brand Presence section on the same `/brand` page: Website, Email, Preferred Handle, Facebook, Instagram, TikTok, YouTube -- the single source of truth for Aly & Pon's official online presence. Website renders as a plain clickable hyperlink; Email as a `mailto:` link; each social platform shows its saved handle (e.g. `@alyandpon`) as clickable text that opens its saved URL in a new tab -- no Open/Copy buttons anywhere. Handle and URL are stored separately per platform (never assumes a URL format). Adding a future platform (Threads, Pinterest, LinkedIn, a menu link) is a small config addition, not a page redesign. Deliberately excludes follower counts, analytics, posting, scheduling, and any social-management capability. |
