---
name: product-lab-purchases
description: Preview, approve, apply, and verify owner-authorized Product Lab raw-ingredient purchases from a natural-language owner message. Do not use for physical counts, orders, Bake, costing, or ingredient creation.
---

# Product Lab purchases

Use this workflow when the owner reports buying raw ingredients, e.g. "Bought 30 eggs for ₱300, 2kg flour for ₱190, and 1L vanilla for ₱450." Claude interprets the natural-language message into structured items; the shared Product Lab MCP application service and Product Lab database decide what may change.

## Establish the source meaning

Treat the input only as ingredients just bought, at the stated quantity and total price. If that meaning is unclear, ask exactly:

> Is this what you currently have on hand, or newly purchased stock?

If it is a physical stock count rather than a purchase, stop: physical counts are outside this skill (use `product-lab-inventory` instead). Never infer physical-count semantics from a purchase report.

## Prepare structured intent

Interpret each purchase line into `{raw_name, quantity, unit, total_price}` yourself. Do not install parsers, OCR, or AI APIs beyond your own reading of the message. Do not guess a unit, package size, ingredient identity, or cost:

- If quantity or unit is missing ("flour ₱190"), do not guess. Ask the owner for the missing value instead of calling `purchase_preview`.
- If a package size is not explicit and deterministic ("1 bottle vanilla ₱450"), do not guess a volume. Ask the owner for the actual quantity and unit.
- If the item name is ambiguous ("2 packs chocolate"), do not guess which product or pack size. Ask the owner to name the exact item and its quantity/unit.

Only `g`, `kg`, `ml`, `L`, and `pcs` are accepted units. Never guess jar, bag, pack, density, or cross-family (mass/volume/count) conversions -- an unsupported unit blocks that line rather than being silently dropped or reinterpreted.

Choose a fresh `occasion_id` identifying this one real purchase event (e.g. an ISO timestamp or a short owner-recognizable label). Reuse the same `occasion_id` only when retrying this exact same purchase after a lost response. A later, genuinely new purchase -- even with byte-identical items and prices -- needs a new `occasion_id`; reusing an old one for a new purchase risks it being treated as a replay of the earlier one.

```json
{
  "kind": "purchase",
  "occasion_id": "explicit identity for this purchase occasion",
  "source_note": "optional free-text context, e.g. the owner's original message",
  "items": [
    { "raw_name": "eggs", "quantity": 30, "unit": "pcs", "total_price": 300 },
    { "raw_name": "flour", "quantity": 2, "unit": "kg", "total_price": 190 },
    { "raw_name": "vanilla", "quantity": 1, "unit": "L", "total_price": 450 }
  ]
}
```

## Authenticate

The launcher/process must receive `PRODUCT_LAB_SUPABASE_URL`, `PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY`, and a short-lived `PRODUCT_LAB_OWNER_ACCESS_TOKEN`. The project key must be modern `sb_publishable_*` or a legacy JWT carrying `role: anon`; Product Lab rejects secret, service-role, and other `sb_*` forms locally before any request. Never request or store a password, database password, secret/service-role key, or token in a file. Product Lab validates the owner token with Supabase Auth and requires `app_metadata.app_role == "owner"`; the database owner check remains authoritative. See `docs/INVENTORY_OPERATOR.md` for the temporary manual handoff from Product Lab's existing browser session.

## Preview and clarify

Call `purchase_preview` with the structured intent. Do not construct a shell command or create an intent file.

The preview is mandatory. It shows, per line: canonical ingredient match, current quantity, converted (base-unit) quantity, entered total price, current average cost, the ingredient's stock-verification status, candidates, and any blocking errors -- plus the preview ID and approval code.

Do not apply while `can_apply` is false. Explain only the blocked rows and ask only necessary clarification. Multiple candidates, unmatched names, inactive aliases, invalid/missing quantities, invalid prices, and incompatible units all block the entire batch. Never create an ingredient or alias. A row against an ingredient whose physical stock has never been verified also blocks -- the owner must run a physical count first (`product-lab-inventory`). After any clarification, create a new preview; previous approval is invalid.

Show the final exact preview, then stop and wait for a **new owner message** containing its displayed approval code. General assent without the matching code is not approval. The code binds the exact payload and becomes invalid if the plan changes, but it is visible in preview state and does not technically prove a human supplied it; human consent is this controlled workflow rule.

## Apply and verify

Only after the owner supplies the matching code in a new message, call `purchase_apply` with exactly `preview_id` and `approval_code`. Claude Code must show its normal interactive tool-approval prompt for this call. If Apply returns `status: "applied_unverified"`, call `purchase_verify` with only `preview_id`.

Never edit a preview artifact and never call a shell command, CLI flag, SQL, or a generic RPC directly. Apply accepts only a stored preview and exact approval code -- it never accepts a re-supplied purchase payload. The database applies the whole purchase atomically through Product Lab's existing `confirm_purchase_import_v2` authority; it computes weighted-average cost itself and is never recomputed here.

If Apply reports a blocked/stale preview, rerun Preview and require a new approval. If the response is lost, retry the identical Apply tool call with the same `preview_id`/`approval_code`; do not invent a new `occasion_id` for a retry of the same purchase, and do not invent a force option. Never report completion until `purchase_verify` returns `status: "verified"`.

Report the occasion, items purchased, ingredients touched, total spent, per-ingredient before/after quantities, transaction IDs, and any failures. Never report a purchase as complete before `purchase_verify` succeeds.
