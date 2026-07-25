# Aly & Shin Product Lab Context Brain

Last updated: 2026-07-23

## What This App Is

Aly & Shin Product Lab is a private operating system for proving a home-based coffee and bakery business before launch. It is not a public ordering site yet. It exists so Aly can record real kitchen work and Shin can review product readiness, cost, supplier quality, tasting signals, content opportunities, and launch risk.

The business is currently in home proofing / preorder preparation. The app must support small-batch experiments, not physical-store operations.

## Current Business Context

- Stage: home-based product testing, pre-launch.
- Primary product focus: bakery first.
- Coffee focus: bottled coffee is not assumed premium or fresh enough yet. It must be chaos-tested for freshness, separation, cold delivery, packaging, perceived value, and margin before becoming a hero product.
- Product proof should come before launch decisions.
- The goal is not to make forms. The goal is to reduce repeated thinking, reduce kitchen friction, and create better decisions from real data.

## User Roles

Shin:
- Acts as backend/operator, systems architect, costing reviewer, and launch decision reviewer.
- Wants to create as much structure as possible so Aly can execute without needing constant explanation.
- Does not want lazy forms, vague fields, or pointless buttons.
- Wants the assistant to push back and chaos-test ideas, not be a yes-man.

Aly:
- Uses the app mainly during or after real kitchen work.
- Should not have to understand database structure or business theory to enter useful records.
- Needs low-friction flows: Proof Day, tasting checkpoints (now nested under Batches), Content
  Journal, and possibly Supplies.

## Product Lab Principles

1. Use real data, not guesses.
2. One proof batch equals one real kitchen test.
3. Change one major variable per test when possible.
4. Formula, yield, timing, packaging, and freshness matter as much as taste.
5. Supplies are the source of truth for actual purchase prices and supplier quality.
6. Costing should calculate automatically from proof formula plus supply prices where possible.
7. Labor is owner wage / paid time, not profit.
8. Profit comes after ingredients, packaging, labor, utilities, waste, overhead, and equipment allocation.
9. Print/download outputs should be clean reports, not full app screenshots.
10. Every page should answer: purpose, what to enter, what it proves, and next action.

## Product Development Lifecycle

Every product should move through the same repeatable stages. The purpose is to reduce wasted
ingredients, reduce repeated thinking, and make launch decisions based on evidence instead of
opinions.

A product is never "finished." It simply has enough evidence to move to the next stage.

This is why comparing versions matters: the app's job is to make it obvious what changed between
one test and the next and whether that change actually moved the evidence forward, not to just
archive a pile of past attempts. Every feature that touches Proof Day, Batches, Costing, or Tasting
should be evaluated against this — does it help decide "is there enough evidence yet," or is it
just recording for its own sake.

## Page Dictionary

### Dashboard

Purpose: quick command center for product readiness.

Should show:
- Product count and launch candidates.
- Which products need proof, costing, tasting, or content.
- Current focus and next actions.

Avoid:
- Vanity metrics.
- Generic summaries that do not tell the operator what to do next.

### Products

Purpose: overview of all product ideas and readiness.

Should show:
- Product role.
- Status.
- Readiness gaps.
- Whether the product should be tested, paused, launched, or removed.

### Product Detail

Purpose: one-product truth page.

Should combine:
- Latest proof batch.
- Costing.
- Tasting feedback.
- Content signals.
- Missing readiness items.
- AI Advisor -- explain/recommend/improve/design-experiment/launch-review buttons that assemble
  a prompt from the Rule Engine's output (never recalculate it), for the operator to run through
  an AI chat and paste the reply back. See "AI Advisor" in docs/ARCHITECTURE.md.

### Proof Day

Purpose: live kitchen test entry.

Use when:
- Aly is making a real test batch.
- A formula changes.
- Packaging, freshness, yield, or process difficulty needs proof.

Must capture:
- Product and batch/version.
- Formula with brand, ingredient, quantity, and unit.
- Which step each formula line belongs to (e.g. First mix, Sprinkle), so the same ingredient can
  appear more than once in a batch without ambiguity — cocoa powder in the first mix and cocoa
  powder as a sprinkle are two separate lines, not one.
- The process itself as an ordered Process Steps list, kept separate from the formula. This is what
  lets a retest keep the same ingredients but document a changed process.
- Auto adjustment vs previous batch.
- Prep/cook/cooling time.
- Sellable pieces and rejects.
- Taste, texture, freshness, packaging result.
- Main issue.
- Next test only.

Important:
- Ingredients should come from Supplies where possible.
- Brand must travel with ingredient.
- Vague units like tsp/tbsp/cup need conversion context when costing.
- Step names autosuggest from step names already used (this batch and past ones) so wording stays
  uniform instead of drifting into near-duplicate variants.
- Photos can be attached while filling out the batch, not only after it's saved. They're staged
  locally and upload automatically the moment the save succeeds, so it feels like one action.
- Process Steps can be reordered by dragging the grip handle on each step, for when a step was
  forgotten and needs to be inserted in the right place instead of retyped in order.
- Process Step text autosuggests ingredients from this batch's own formula as you type any word
  in the step (not just from the start of the field), inserting the exact quantity and name (e.g.
  "25g Cocoa Powder") at the cursor so several ingredients can be referenced in one step without
  retyping, and without drifting from the Ingredients list.

### Batches

Purpose: experiment history and comparison.

Use when:
- Reviewing past tests.
- Copying formula.
- Comparing what changed — every batch shows a live diff against its previous version for the same
  product (ingredient-by-ingredient: same/changed/new/removed, plus prep/bake/cool time, yield, and
  decision). Computed fresh from both batches' real formulas each time, not a stale saved snapshot.
- Printing/downloading proof records.
- Attaching photos of the batch — each record can hold photos (camera capture on mobile), stored in
  Supabase Storage and linked to the batch.
- Logging tasting checkpoints — there is no separate Tasting page. Feedback lives directly under
  each batch, and a batch can have several checkpoints over time (e.g. "2 hours post-bake", "24
  hours", "Day 3"). The checkpoint timing is free text the operator writes, not a fixed schedule,
  because real tasting doesn't happen on a clock.

Should not be a duplicate live-entry page. Proof Day is for recording; Batches is for reviewing —
and, now, for logging tasting checkpoints and photos as they happen over the following hours/days.

Baking is initiated from here, not from a separate tab: use the **Bake a batch** button in the
header, or a record's **Bake this** link, to open the bake flow (which deducts that batch's
ingredients from inventory) with the batch already selected. There is no top-level Bake tab; the
`/bake` route still works as a deep link.

### Supplies

Navigation note: Supplies is no longer its own top-level tab. It lives under the single
**Inventory & Supplies** tab, on the **Supplier prices** toggle (the other toggle, **Current
stock**, is the Inventory page). Old `/supplies` links still work and open on the Supplier-prices
toggle. This is purely a navigation grouping — the purchase-log data and its role below are
unchanged.

Purpose: actual purchase log and supplier comparison.

Use when:
- A real ingredient, packaging, or supply is bought.
- Supplier, brand, pack size, unit, total price, quality, or notes need to be stored.

Must capture:
- Brand first.
- Ingredient.
- Supplier.
- Date bought.
- Pack quantity and unit.
- Total PHP.
- Unit cost calculated.
- Quality rating.
- Notes.

Important:
- Saved brand, supplier, and unit should become easy dropdown/combobox options.
- Supplies feed costing automatically.
- Auto-selection uses the most recent valid matching purchase (by date bought, falling back to
  when the record was saved if no purchase date), not the cheapest one ever recorded. A stale
  cheap price should not undercut a real, more recent cost. Invalid or zero-cost records are
  excluded, not just deprioritized. Manual cost overrides still take precedence.

### Costing

Purpose: calculate whether a product can make money.

Costing is scoped to a specific proof batch/version (e.g. "Brownies V3"), not just a product —
picking a batch from the selector sets both the product and the version in one step, so the same
product can carry separate costing per version instead of only ever reflecting whichever batch
happened to be most recent. A product with no proof batches yet can't be costed, by design —
prove it first, then cost it. Recent Entries, print, and CSV all show the batch version alongside
the product name so it's clear which version a saved costing belongs to.

Use when:
- Formula is close enough to cost.
- Supplies have actual purchase prices.
- Yield is known or estimated.

Must calculate:
- Ingredient cost from formula quantity and supply unit price.
- Packaging cost.
- Labor cost / owner wage.
- Utilities.
- Waste.
- Overhead and equipment allocation if present.
- Batch cost.
- Cost per piece/unit.
- Suggested price.
- Operating profit per unit (revenue minus the fully loaded batch cost — ingredients, packaging,
  labor, utilities, waste, overhead, and equipment. Not a true accounting Gross Profit, and not
  Net Profit either, since taxes, financing, and selling fees still aren't accounted for).
- Operating margin / food cost.

Important:
- Do not require pointless "calculate" buttons if the app can auto-calculate.
- Ingredient cost should update automatically from matching supply data unless manually overridden.
- Labor is not profit. Labor pays the person doing the work.
- Yield must be explicit. Cost per piece is meaningless without yield. When yield is missing or
  zero, cost per piece and every dependent number (margin, markup, target price, contribution
  margin, break-even) show "Need yield" instead of a number — never the whole batch cost, never
  zero. This is enforced by one shared helper so Costing, Product Detail, print, and CSV can't
  drift out of sync with each other.
- Reports should print as clean costing sheets.
- Gas/electric equipment for the utility calculators can be added inline from the equipment
  dropdown ("+ Add new...") — no need to leave Costing and go set up a full Equipment record just to
  name what was used.

### Content Journal

Purpose: record useful content evidence from real work.

Use when:
- Real photos/videos were captured.
- A lesson, content angle, or post idea exists.

Avoid:
- Forcing media links if that creates friction.
- Vague fields that do not drive a next content action.

Useful entries:
- What was made.
- What content was captured.
- Why it is useful.
- Post/reel/carousel angle.
- Next content action.

### Launch

Purpose: launch offer builder.

Use only after:
- Product has proof.
- Costing is acceptable.
- Tasting signal is strong enough.
- Packaging/freshness risks are handled.

Should consider:
- Customer journey.
- Preorder cutoff.
- Pickup/delivery conditions.
- Temperature on arrival.
- Packaging.
- Storage/serving instructions.
- Stir instruction for drinks if separation occurs.
- Extra ice or cold-chain support for drinks.

### Guide

Purpose: day-to-day operating manual inside the app.

Should eventually include:
- Current business context.
- How Aly uses the app.
- How Shin reviews the app.
- Page dictionary.
- What data exists.
- What is missing.
- Next best action.

## Current Known Frictions To Avoid

- Do not make users click a button for math that can update automatically.
- Do not place feedback only at the top of a long page.
- Do not print the whole app shell.
- Do not create generic manuals that ignore current data.
- Do not make brand, ingredient, and unit separate repeated work when Supplies already knows the relationship.
- Do not make fields vague without examples or a reason.
- Do not ship UI that looks like a quick scaffold when the old app had clearer pages.

## Data Relationships

Supplies:
- Source of truth for brand, ingredient, supplier, pack quantity, unit, price, quality.

Proof Batch:
- Source of truth for formula, process, yield, quality result, next test.
- Formula should carry brand + ingredient + quantity + unit.

Costing:
- Uses proof formula and supplies.
- Needs yield to calculate unit cost.
- May store structured details in notes when schema does not yet have dedicated columns.

Tasting:
- Nested under Proof Batch, not its own top-level entity — a batch can have several checkpoints
  over time. Validates whether people want the product and at what price.

Content Journal:
- Converts proof work into marketing assets and ideas.

Launch:
- Uses readiness evidence to shape an offer.

## Current Technical Context

Stack:
- Next.js
- TypeScript
- Tailwind CSS
- Supabase
- Vercel

Repository:
- GitHub: shinyamadasan/aly-shin-product-lab
- Production: https://aly-shin-product-lab.vercel.app

Supabase:
- Existing project URL: https://kouesgllnyallmyesvrl.supabase.co
- Uses publishable anon key in environment.
- Be careful with schema changes. The user has had to run SQL manually before and dislikes migration friction.

Important implementation preference:
- Prefer app changes that work with the existing Supabase schema unless a schema change is clearly worth it.
- If schema changes are required, provide a clear SQL file and exact instructions.

## Current Engineering Priorities

1. Make the Guide page a real context/manual page using this document.
2. Stabilize Costing so it feels like a professional costing sheet, not a form.
3. Keep Proof Day and Supplies low-friction because they matter most at the current stage.
   (Supplies now lives under the Inventory & Supplies tab → Supplier prices toggle.)
4. Improve local contextual feedback per page and per action.
5. Add clean exports/reports only when they are useful and compact.
6. Avoid broad refactors while the user is actively testing workflows.

## Future Context Brain

The ideal future version should have a "Context / Manual" page or drawer that can answer:
- What is this app for?
- What stage is the business in?
- What should Aly do today?
- What should Shin review today?
- What do we already know?
- What is missing?
- Which product is closest to launch?
- Which product should be paused?
- What customer journey risks are unresolved?

This should be generated from current app data where possible, not generic text only.

## How Future Codex Sessions Should Work

When a new Codex thread starts:
1. Read this file first.
2. Check `git status --short` before editing.
3. Do not overwrite user changes.
4. Inspect the relevant app page before patching.
5. Prefer reducing friction over adding features.
6. Run lint and build before pushing.
7. If deploying, push to GitHub then deploy to Vercel production.

## Tone and Collaboration Notes

The user is direct and will call out lazy work. Treat that as useful signal.

Respond by:
- Owning the issue.
- Fixing the workflow.
- Avoiding defensive explanations.
- Explaining briefly what changed and how it improves the operator flow.

Do not:
- Add vague fields.
- Add buttons for obvious automatic behavior.
- Add generic documentation that does not reflect the business.
- Treat the business like a store launch when it is still home proofing.
