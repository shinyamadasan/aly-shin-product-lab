# Product Lab MCP Slices 1–2

Product Lab exposes one local stdio MCP implementation to Codex and Claude Code. The server
registers exactly five tools: the Slice 1 read tools `inventory_list` and `ingredient_inspect`, plus
the V1A physical-count tools `inventory_count_preview`, `inventory_count_apply`, and
`inventory_count_verify`. Both clients may use all five under their guarded project permissions.

## Architecture

```text
Codex / Claude -> Product Lab MCP adapter -> shared inventory-count application service
               -> existing V1A core -> existing physical-count batch RPC
               -> owner RLS / private owner check -> shared read-back verification
```

`scripts/product-lab/inventory-count-service.ts` owns preview-artifact persistence and the existing
preview/apply/verify orchestration. Both `scripts/inventory-operator/run.ts` and the MCP adapter call
that service. Matching, unit normalization, payload hashing, preview identity, approval binding,
stale-state guards, RPC rows, reconciliation rules, and cost-certification semantics are not
reimplemented in MCP.

The existing `public.apply_inventory_physical_count_batch` RPC remains the only MCP-reachable
mutation. There is no new migration, new RPC, generic SQL/RPC tool, table mutation tool,
ingredient editor, purchase/order/Bake action, inventory delta adjustment, or certification tool.

## Authentication

Launch the client from a PowerShell process containing:

```powershell
$env:PRODUCT_LAB_SUPABASE_URL = "https://<project>.supabase.co"
$env:PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY = "<publishable-or-legacy-anon-key>"
$env:PRODUCT_LAB_OWNER_ACCESS_TOKEN = Get-Clipboard
```

The owner token must be the current short-lived access token from Product Lab's normal owner
sign-in. Never put it in MCP config, a prompt, a command argument, a log, or a repository file.
Close the client and remove it from the launching shell after use:

```powershell
Remove-Item Env:PRODUCT_LAB_OWNER_ACCESS_TOKEN
```

Product Lab rejects secret/service-role project keys locally, calls `auth.getUser`, requires
`app_metadata.app_role === "owner"`, and relies on database owner checks/RLS. Apply always creates
a fresh authenticated client and therefore never relies on preview-time authentication. Expired
tokens require a fresh browser session token and MCP/client restart as appropriate.

## Client approval

Codex reads project-local `.codex/config.toml` only after the repository is trusted. For a trusted
checkout, this project enables all five tools, declares `approvals_reviewer = "user"`, and sets
Apply's per-tool `approval_mode = "prompt"`. Installed Codex 0.147.0 reported no managed
requirements overriding this setup. The documented precedence places CLI overrides above project
config, so do not run Product Lab Apply with `--approve-for-me` or an
`approvals_reviewer = "auto_review"` override.

A controlled loopback acceptance through the real installed client proved the runtime boundary:
Preview returned code `1730-A493`; the client stopped for a new owner message; Apply then produced
the human tool prompt with the exact code and preview ID; the fixture still reported zero mutations
at that point; and only a separate human approval released exactly one reconciliation event.
Authoritative Verify then returned `verified` with zero failures. These observed runtime facts are
separate from static tests, which assert only the configuration declarations.

`.claude/settings.json` places `mcp__product_lab__inventory_count_apply` in `permissions.ask`.
Claude must not place that tool in an allowlist. The project `.mcp.json` starts the same server and
contains no automatic tool permissions.

Client tool approval is an additional guard. It does not replace the new owner message,
approval-code binding, stale guards, mutation receipt, atomic RPC, or read-back verification.

## Read tools

`inventory_list` has no input. It returns at most 500 ingredient records with ID, canonical name,
active state, quantity, canonical unit, reconciliation timestamps, and nullable average unit cost.

`ingredient_inspect` accepts `{ "name": "Sea Salt" }`. Exact, normalized, and safe unique-alias
matches return the ingredient plus at most five linked purchase records and five recent inventory
movements. Ambiguous, suggested, inactive-alias, and unknown results disclose candidates but never
select an ingredient. `Biscoff` never chooses Spread or Biscuit.

## `inventory_count_preview`

The input is V1A's structured, batch-native contract:

```json
{
  "kind": "physical_count",
  "source": {
    "name": "owner-message-2026-09-14",
    "fingerprint": "<sha256 of original bytes or preserved pasted text>",
    "occurrence_id": "2026-09-14-morning-count"
  },
  "rows": [
    { "raw_name": "Dari Creme Butter Milk", "quantity": 1800, "unit": "g" }
  ]
}
```

Rows may also use V1A's explicit `pack_count`, `pack_size`, and `pack_unit` fields. Multi-item
counts remain available because V1A is already naturally batch-based; MCP adds no natural-language,
file-format, or batch parser.

Preview authenticates the owner, loads authoritative state, calls the hardened matcher and unit
authority, builds the same deterministic payload hash/operation identity/approval code, and stores
the same ignored local preview artifact. It never mutates inventory. The result includes exact
canonical/current/proposed/delta/reconciliation/cost-certification facts, stale guards, candidates,
warnings/errors, preview ID, payload hash, operation ID, approval code, and creation timestamp.

Unsafe matches and invalid quantities/units return `can_apply: false`; suggestions never become
writes. V1A has no preview-expiration timer, so Slice 2 does not invent one. Current quantity,
latest movement, and base unit are checked for staleness by the existing atomic authority at Apply.

## Approval boundary

After a valid preview, the client must show the exact facts and ask: `Approve <code>?` Then it must
stop. Apply is permitted only after a new owner message explicitly contains or confirms that exact
code. The code binds the payload but, because it is visible in the preview, does not prove human
consent by itself. Neither Codex nor Claude may call Apply immediately after Preview.

## `inventory_count_apply`

Apply accepts only:

```json
{ "preview_id": "pc_...", "approval_code": "ABCD-1234" }
```

It accepts no ingredient, quantity, unit, replacement payload, SQL, or RPC name. The shared service
re-authenticates the owner, reloads the stored artifact, verifies its exact hash/preview/operation
identity and approval code, then calls the existing atomic/idempotent batch RPC with V1A's stale
guards. The database owns locking, mutation receipts, replay behavior, reconciliation, ledger
writes, cost-certification effects, and rollback. The result is deliberately
`status: "applied_unverified"`.

## `inventory_count_verify`

Verify accepts only `{ "preview_id": "pc_..." }`. It uses the shared V1A implementation to read
the final ingredient and exact ledger transactions, verify every reconciliation-snapshot field,
transaction identity, quantity/unit/timestamps, and expected cost-certification outcome, and fail
visibly on any mismatch. Its returned `cost_reconciled_at` comes from the authoritative ingredient
read-back, never the local apply-result artifact. Only this tool can return `status: "verified"`.

## Failure and diagnostics

Tool failures expose stable categories such as `authentication_error`, `invalid_preview`,
`inventory_apply_failed`, and `inventory_verification_failed`. Raw backend messages and credentials
are never returned. Stderr receives only a safe internal category; stdout remains MCP protocol data.

When Apply is stale, rerun Preview and obtain a new owner approval. When an Apply response is lost,
replay the identical Preview ID and approval code; the existing mutation receipt returns the stored
result without another ledger event. There is no force option.

## Production boundary

Automated tests use loopback fixtures and disposable/local database smoke tests only. Building or
reviewing Slice 2 does not authorize a live physical count, production read/write, migration,
deployment, commit, push, PR, or merge.
