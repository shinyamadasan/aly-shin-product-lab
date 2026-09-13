# Claude Inventory Operator V1A

This is a local Claude Code operator for owner-approved **physical counts**. It is not an in-app AI feature, provider integration, purchase importer, generic database tool, or autonomous service.

## Safety architecture

```text
source file/table -> Claude structures intent -> deterministic preview -> exact approval binding
-> owner-only atomic batch RPC -> apply_raw_inventory_adjustment -> read-back verification
```

Claude may interpret source text and ask clarifying questions. It cannot create ingredients or aliases, change the normalized plan after approval, or submit arbitrary SQL/RPC calls through the operator. Ambiguous or suggested matches block automatic progression; Claude must not proceed unless the owner explicitly resolves the match through the controlled workflow. The shared V1A service validates the final resolved match but cannot prove who supplied `match_name`. The database remains the inventory authority.

`scripts/product-lab/inventory-count-service.ts` is the shared application entry point for preview,
apply, and verify. The Inventory Operator CLI is a developer/debug shell over that service; Product
Lab MCP exposes the same service to Codex and Claude. Neither client owns an inventory workflow.

The batch RPC sorts ingredient UUIDs before locking and delegates every row to `inventory_private.apply_raw_inventory_adjustment`. That existing authority owns stale quantity/latest-movement/base-unit checks, ledger and reconciliation snapshots, nonnegative balances, owner authorization, and cost-certification effects. The batch wrapper adds only whole-file transactionality and `mutation_receipts` replay protection.

## Authentication

Pass these values to the operator process:

- `PRODUCT_LAB_SUPABASE_URL` — the normal project URL.
- `PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY` — modern `sb_publishable_*` key or legacy JWT whose decoded project role is `anon`.
- `PRODUCT_LAB_OWNER_ACCESS_TOKEN` — a short-lived real owner access token.

Before creating a Supabase client, the operator locally rejects every non-publishable `sb_*` form, including `sb_secret_*`, and rejects legacy JWT project keys whose decoded role is `service_role` or anything other than `anon`. JWT payload decoding is classification only, not authentication; Supabase still validates the key remotely. The process then calls `supabase.auth.getUser(token)` and requires `user.app_metadata.app_role === "owner"`. It does not persist or print the token. Database `auth.uid()` and `is_product_lab_owner()` checks remain authoritative. Do not use an owner password, database password, or service-role credentials.

### Supplying the current owner token

Product Lab's existing browser sign-in creates the required short-lived owner session, but the app has no supported token-export or launcher handoff. For V1A, sign in through the normal Product Lab owner screen, retrieve the current session's `access_token` from the Supabase auth entry in browser DevTools **Application → Local Storage**, copy only that token, and set it in the current PowerShell process without putting the literal in command history:

```powershell
$env:PRODUCT_LAB_OWNER_ACCESS_TOKEN = Get-Clipboard
```

Run the operator from that shell, then remove it with `Remove-Item Env:PRODUCT_LAB_OWNER_ACCESS_TOKEN`. Never paste the token into chat, a command argument, a file, or source control. This manual handoff remains known P2 usability friction; V1A intentionally adds no authentication subsystem.

## Structured input

```json
{
  "kind": "physical_count",
  "source": {
    "name": "stock-count-2026-09-14.xlsx",
    "fingerprint": "<sha256 of original bytes or preserved pasted text>",
    "occurrence_id": "2026-09-14-morning-count"
  },
  "rows": [
    { "raw_name": "Butter", "quantity": 1.6, "unit": "kg" },
    { "raw_name": "Eggs", "quantity": 23, "unit": "pcs" },
    { "raw_name": "Flour", "pack_count": 3, "pack_size": 700, "pack_unit": "g" }
  ]
}
```

Claude reads the original source; the CLI intentionally has no xlsx, PDF, image, or OCR parser. Valid count units are `g`, `kg`, `ml`, `L`, and `pcs`. Explicit packs multiply before conversion. Negative/non-finite quantities, unknown units, package counts without sizes, and mass/volume/count family crossings fail closed.

The Claude workflow hashes original file bytes with SHA-256, or preserves and hashes raw pasted text. The CLI validates and binds the supplied digest, but it does not receive the original source and therefore cannot independently prove that the digest came from those bytes. `occurrence_id` names this counting occasion: reuse it for retries, but choose a new explicit identity for a later real count even when source bytes are identical.

## Commands

```text
npm run inventory-operator -- inventory:list
npm run inventory-operator -- ingredient:match --name "Biscoff"
npm run inventory-operator -- inventory:count-preview --input <intent.json>
npm run inventory-operator -- inventory:count-apply --preview-id <id> --approval-code <code>
npm run inventory-operator -- inventory:verify --preview-id <id>
```

Preview writes an ignored local `.inventory-operator/previews/<preview_id>.json` artifact. It is transient approval state, not a ledger. `payload_hash` binds the claimed source identity, normalized counts, match result, current quantity/cost facts, reconciliation facts, latest movement evidence, and notes. Changing the plan changes the hash and invalidates that approval code.

The code proves only that apply received the exact preview payload. Because the code appears in the preview and local artifact, it does **not** technically prove that a human typed or supplied it. Human consent is a controlled Claude workflow boundary: Claude must show the final preview, stop, and wait for a new owner message containing the matching code before invoking apply. V1A intentionally adds no second approval service.

Apply can load only that artifact and requires its displayed approval code. The stable database operation ID is derived from `physical_count + occurrence_id`; the exact payload hash is claimed in `inventory_private.mutation_receipts`:

- same occurrence + same payload retry → stored result, no duplicate ledger rows;
- same occurrence + changed source/payload → rejected;
- lost response → retry the identical apply command safely;
- later byte-identical count → new occurrence identity and therefore a new operation.

## Matching and failure recovery

Automatic matches are limited to one active exact canonical name, one known alias with one active target, or one active normalized candidate. Strong partial/brand-aware matches are suggestions only. Multiple candidates (including bare `Biscoff` between Spread and Biscuit), inactive aliases, unmatched names, and duplicate ingredient rows block the entire preview. After explicit owner clarification, a row may retain its original `raw_name` and add the selected canonical name as `match_name`; both names and the resulting canonical match are bound into the new preview. The CLI verifies that the final match is permitted, but cannot prove whether Claude or the owner supplied `match_name`; the Claude skill forbids adding it silently.

Any stale quantity, latest movement, or base unit aborts and rolls back the whole batch. Rerun preview against current state and obtain a new approval. There is no `--force`.

Zero-delta counts retain the existing authority's behavior: a reconciliation transaction is written and reported as an exact recount with no quantity change, never as a changed quantity. A positive count discovers unexplained stock and clears an existing `cost_reconciled_at`; shrinkage and exact recounts preserve an existing certification. When `cost_reconciled_at` was already null, the report says `remained_uncertified` rather than claiming a certification was preserved.

Verification reads every final ingredient and authoritative transaction back before reporting success. It checks all seven material reconciliation-snapshot fields: cached quantity, prior ledger quantity and transaction ID, base unit, average unit cost, previous reconciliation timestamp, and verified quantity. The final report separates `quantity_increased`, `quantity_decreased`, `exact_recounts_no_quantity_change`, `cost_certifications_cleared`, `existing_cost_certifications_preserved`, and `remained_uncertified`, and labels the detail collection `reconciliation_rows`.

## Production boundary

The migration and operator must be tested only against disposable/local databases until separate review and explicit production authorization. Do not run the migration in production, operate on real production inventory, deploy, merge, or infer that this document grants rollout permission.
