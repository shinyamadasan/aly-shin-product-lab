---
name: product-lab-inventory
description: Preview, approve, apply, and verify owner-authorized Product Lab physical inventory counts from a supplied file or pasted table. Do not use for purchases, orders, Bake, costing, or ingredient creation.
---

# Product Lab physical counts

Use this workflow when the owner asks to update inventory from a physical count. Claude interprets the source; the shared Product Lab MCP application service and Product Lab database decide what may change.

## Establish the source meaning

Treat the input only as quantities currently on hand. If that meaning is unclear, ask exactly:

> Is this what you currently have on hand, or newly purchased stock?

If it is newly purchased stock, stop: purchases are outside this skill. Never infer purchase semantics from a physical count.

## Prepare structured intent

Read the supplied file or pasted table yourself. Do not install parsers, OCR, or AI APIs. Preserve each source name and count as written, then pass this structured intent directly to `inventory_count_preview`:

```json
{
  "kind": "physical_count",
  "source": {
    "name": "stock-count-2026-09-14.xlsx",
    "fingerprint": "SHA-256 hex",
    "occurrence_id": "explicit identity for this counting occasion"
  },
  "rows": [
    { "raw_name": "Butter", "quantity": 1.6, "unit": "kg" },
    { "raw_name": "Eggs", "quantity": 23, "unit": "pcs" },
    { "raw_name": "Flour", "pack_count": 3, "pack_size": 700, "pack_unit": "g" }
  ]
}
```

Hash original file bytes when a file exists. For pasted input, hash the preserved raw text. The shared V1A service validates and binds the fingerprint you supply but cannot independently prove its provenance because it never receives the original source. Reuse the same `occurrence_id` for retries of this count. A genuinely new count from byte-identical source content needs a new occurrence identity.

Only `g`, `kg`, `ml`, `L`, and `pcs` are accepted. Express packs explicitly as count × size. Never guess jar, bag, pack, density, or cross-family conversions.

## Authenticate

The launcher/process must receive `PRODUCT_LAB_SUPABASE_URL`, `PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY`, and a short-lived `PRODUCT_LAB_OWNER_ACCESS_TOKEN`. The project key must be modern `sb_publishable_*` or a legacy JWT carrying `role: anon`; Product Lab rejects secret, service-role, and other `sb_*` forms locally before any request. Never request or store a password, database password, secret/service-role key, or token in a file. Product Lab validates the owner token with Supabase Auth and requires `app_metadata.app_role == "owner"`; the database owner check remains authoritative. See `docs/INVENTORY_OPERATOR.md` for the temporary manual handoff from Product Lab's existing browser session.

## Preview and clarify

Call `inventory_count_preview` with the structured intent. Do not construct a shell command or create an intent file.

The preview is mandatory. It shows canonical match, current quantity, normalized count, delta, quantity/cost reconciliation effects, latest movement guard, candidates, preview ID, and approval code.

Do not apply while `can_apply` is false. Explain only the blocked rows and ask only necessary clarification. Strong partial/brand-aware matches are suggestions, never approvals. Multiple candidates, inactive aliases, unknown names, duplicate ingredient rows, invalid quantities, and incompatible units all block the entire batch. Never create an ingredient or alias. After any clarification, create a new preview; previous approval is invalid.

When the owner resolves an ambiguous or suggested row, preserve its original `raw_name` and add the explicitly selected canonical name as `match_name`. Never add `match_name` based only on Claude's guess. The final preview shows and binds both names and the selected canonical ingredient. Product Lab can enforce a permitted final match, but cannot prove who supplied `match_name`; this prohibition is a Claude workflow rule.

Show the final exact preview, then stop and wait for a **new owner message** containing its displayed approval code. General assent without the matching code is not approval. The code binds the exact payload and becomes invalid if the plan changes, but it is visible in local preview state and does not technically prove a human supplied it; human consent is this controlled workflow rule.

## Apply and verify

Only after the owner supplies the matching code in a new message, call `inventory_count_apply` with exactly `preview_id` and `approval_code`. Claude Code must show its normal interactive tool-approval prompt for this call. If Apply returns `status: "applied_unverified"`, call `inventory_count_verify` with only `preview_id`.

Never edit a preview artifact and never call a shell command, CLI flag, SQL, a generic RPC, or `apply_raw_inventory_adjustment` directly. Apply accepts only a stored preview and exact approval code. The database applies the whole count atomically through Product Lab's existing authority.

If Apply reports stale inventory or a changed preview, rerun Preview and require a new approval. If the response is lost, retry the identical Apply tool call; do not create a new occurrence or invent a force option. Never report completion until `inventory_count_verify` returns `status: "verified"`.

Report the source, row/event counts, increases, decreases, exact recounts with no quantity change, existing certifications cleared, existing certifications preserved, rows that remained uncertified, failures, reconciliation rows, operation ID, and transaction IDs. Never call a zero-delta recount a quantity change or a preserved null value a preserved certification.
