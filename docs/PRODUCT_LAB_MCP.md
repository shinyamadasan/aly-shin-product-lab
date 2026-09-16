# Product Lab MCP Slices 1–2.1A, Daily Bakery Ops V2 Slice 1 (Purchases)

Product Lab exposes the same MCP tool registry over two transports: a local stdio implementation
(Codex/Claude Code, launched as a child process with a manually-supplied owner token) and, as of
Slice 2.1A, a remote Streamable HTTP endpoint authenticated with Supabase OAuth-issued bearer
identity. Both transports register the exact same eight tools: the Slice 1 read tools `inventory_list`
and `ingredient_inspect`; the V1A physical-count tools `inventory_count_preview`,
`inventory_count_apply`, and `inventory_count_verify`; and, as of Daily Bakery Ops V2 Slice 1, the
purchase tools `purchase_preview`, `purchase_apply`, and `purchase_verify` (see "Daily Bakery Ops V2
-- purchases" below). Neither transport adds, removes, or duplicates a tool definition -- see
"Slice 2.1A -- remote HTTP MCP" and "Daily Bakery Ops V2 -- purchases" below for exactly what changed
and what did not.

## Architecture

```text
Codex / Claude (stdio)  -\
                          +-> shared createProductLabMcpServer(...) tool registry
Remote OAuth client     -/      -> shared inventory-count application service
   (Slice 2.1B, not yet         -> existing V1A core -> existing physical-count batch RPC
   wired to any daily client)   -> owner RLS / private owner check -> shared read-back verification
```

Both transports call the identical `createProductLabMcpServer(...)` factory
(`scripts/product-lab-mcp/mcp-server.ts`, unmodified since Slice 2) with request-scoped read/count
services built from an already-authenticated owner client. Matching, unit normalization, payload
hashing, preview identity, approval binding, stale-state guards, RPC rows, reconciliation rules, and
cost-certification semantics remain owned entirely by the shared V1A core and are not reimplemented,
duplicated, or transport-specific.

`scripts/product-lab/inventory-count-service.ts` owns preview-artifact persistence and the existing
preview/apply/verify orchestration. Both `scripts/inventory-operator/run.ts` and the MCP adapter call
that service. Matching, unit normalization, payload hashing, preview identity, approval binding,
stale-state guards, RPC rows, reconciliation rules, and cost-certification semantics are not
reimplemented in MCP.

The existing `public.apply_inventory_physical_count_batch` RPC remains the only MCP-reachable
mutation for physical counts. Daily Bakery Ops V2 Slice 1 adds exactly one more MCP-reachable
mutation path, `purchase_apply`, which calls the existing, unmodified
`inventory_private.confirm_purchase_import_v2` RPC -- see "Daily Bakery Ops V2 -- purchases" below.
No new RPC, generic SQL/RPC tool, table mutation tool, ingredient editor, order/Bake action,
inventory delta adjustment, or certification tool exists anywhere in this registry.

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
checkout, this project enables all eight tools, declares `approvals_reviewer = "user"`, and sets
both Apply tools' (`inventory_count_apply`, `purchase_apply`) per-tool `approval_mode = "prompt"`.
Installed Codex 0.147.0 reported no managed requirements overriding this setup. The documented
precedence places CLI overrides above project config, so do not run Product Lab Apply with
`--approve-for-me` or an `approvals_reviewer = "auto_review"` override.

A controlled loopback acceptance through the real installed client proved the runtime boundary:
Preview returned code `1730-A493`; the client stopped for a new owner message; Apply then produced
the human tool prompt with the exact code and preview ID; the fixture still reported zero mutations
at that point; and only a separate human approval released exactly one reconciliation event.
Authoritative Verify then returned `verified` with zero failures. These observed runtime facts are
separate from static tests, which assert only the configuration declarations.

`.claude/settings.json` places both `mcp__product_lab__inventory_count_apply` and
`mcp__product_lab__purchase_apply` in `permissions.ask`. Claude must not place either tool in an
allowlist. The project `.mcp.json` starts the same server and contains no automatic tool
permissions.

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

## Daily Bakery Ops V2 -- purchases

Three additional tools support owner-approved raw-ingredient purchases, reusing the exact
preview -> approval -> apply -> verify safety pattern above. The MCP server itself has no natural-
language parser: the calling client (Claude/Codex) interprets an owner message such as "Bought 30
eggs for ₱300, 2kg flour for ₱190, and 1L vanilla for ₱450" into structured `{raw_name, quantity,
unit, total_price}` items *before* calling `purchase_preview`. From that point on, matching, unit
conversion, and validation are entirely deterministic -- unknown or ambiguous input blocks and asks
the owner, never guesses.

`scripts/purchase-operator/core.ts` owns this deterministic preview/hash/approval logic (mirroring
`scripts/inventory-operator/core.ts`'s V1A pattern exactly), and
`scripts/product-lab/purchase-service.ts` owns preview-artifact persistence and orchestration
(mirroring `inventory-count-service.ts`). Neither reimplements weighted-average cost or batch
atomicity -- both remain owned entirely by the existing, unmodified
`inventory_private.confirm_purchase_import_v2` database authority (see "The apply bridge" below).

### `purchase_preview`

```json
{
  "kind": "purchase",
  "occasion_id": "explicit identity for this purchase occasion",
  "source_note": "optional free-text context",
  "items": [
    { "raw_name": "eggs", "quantity": 30, "unit": "pcs", "total_price": 300 },
    { "raw_name": "flour", "quantity": 2, "unit": "kg", "total_price": 190 },
    { "raw_name": "vanilla", "quantity": 1, "unit": "L", "total_price": 450 }
  ]
}
```

`occasion_id` plays the same role V1A's `source.occurrence_id` plays for physical counts: it is
part of the hashed payload, so two different occasions with byte-identical items/prices get
distinct preview identities, approval codes, and database idempotency keys, while retrying the same
occasion after a lost response reuses the same ones. A later, genuinely new purchase needs a new
`occasion_id` even if every item and price is identical to an earlier one.

Preview resolves each line with the same guarded matcher `ingredient_inspect` uses
(`resolveIngredientReferenceDetailed`), converts the entered quantity into the matched ingredient's
own base unit through the shared `convertToBaseUnit` authority, and validates a positive quantity
and non-negative price. Only `g`, `kg`, `ml`, `L`, and `pcs` are accepted purchase units -- the same
set `docs/PURCHASE_IMPORT_GUIDE.md` documents for CSV receipt rows. A line against an ingredient
whose physical stock has never been verified (`inventory_reconciled_at` is null) also blocks, the
same guard `post_raw_purchase`/`confirm_purchase_import_v2` enforce server-side. It never mutates
inventory, never silently creates an ingredient, and never guesses a unit, package size, ingredient
identity, or cost. Multiple lines may reference the same ingredient -- unlike a physical count,
this is valid and expected (`confirm_purchase_import_v2` sums them server-side into one ledger
transaction per ingredient).

### The apply bridge

`confirm_purchase_import_v2` consumes persisted `purchase_imports`/`purchase_import_rows` rows, not
an arbitrary payload. Rather than adding a new RPC, `purchase_apply` bridges the approved preview
into that existing authority directly: it writes one `purchase_imports` row and one
`purchase_import_rows` row per preview line under those tables' existing owner-only RLS policies
(`supabase-harden-product-lab-owner-data-rls.sql`'s TIER 1 list already includes both tables), built
entirely from the already-approved, already-hashed preview -- never from `purchase_apply`'s own
input, which is only `{preview_id, approval_code}`. It then calls the existing, unmodified
`confirm_purchase_import_v2(operation_id, import_id)`, which owns 100% of the weighted-average-cost
math and all-or-nothing batch atomicity.

Both the `purchase_imports.id` and each `purchase_import_rows.id` are *derived*, not generated --
`deterministicUuid(namespace, value)` always recomputes the same id from the same immutable,
already-approved preview content (the same technique V1A's own `operationIdForOccurrence` uses,
generalized). A retried `purchase_apply` call (a lost response, or a second call after a real
success) recomputes the identical ids, upserts with `ignoreDuplicates` (a no-op if they already
exist), and calls the RPC with the same `operation_id` -- which resolves through
`confirm_purchase_import_v2`'s own `claim_mutation` idempotency to the same stored result. No extra
mutable "which import did this preview become" pointer is persisted anywhere for that to work. No
migration or RPC beyond one narrow, additive preview-storage table was required -- see
"Durable preview store" below.

### `purchase_apply`

```json
{ "preview_id": "pu_...", "approval_code": "ABCD-1234" }
```

It accepts no item, quantity, unit, price, brand, SQL, or RPC name. Returns `applied_unverified`;
verify separately.

### `purchase_verify`

Verify accepts only `{ "preview_id": "pu_..." }`. It reads back the authoritative ingredient rows
and the `inventory_transactions` rows created by `confirm_purchase_import_v2` (`source_type =
'purchase_import'`, `source_id` = the derived import id), and independently recomputes each
ingredient's expected quantity delta from the approved preview -- never trusting the apply
artifact's own cached summary -- failing visibly on any mismatch. Only this tool can return
`status: "verified"`.

### Durable preview store

Purchase previews are stored in `public.product_lab_mcp_purchase_previews`
(`supabase/migrations/20260916100000_product_lab_mcp_purchase_previews.sql`), a sibling table to
`product_lab_mcp_previews` -- not a reuse of it. That table's `preview_id` column is
CHECK-constrained to V1A's own `^pc_[a-f0-9]{20}$` physical-count identity and its own migration
describes the stored JSON as "the opaque CountPreview object"; a purchase preview is a structurally
different payload and must never collide identity-wise with a physical count. The sibling table
uses its own `^pu_[a-f0-9]{20}$` prefix and repeats the exact same owner-scoped RLS shape,
composite-primary-key rationale, and 24-hour retention default as the original -- see that
migration's own header for the full reasoning, which is not repeated here to avoid drift between
the two documents.

## Failure and diagnostics

Tool failures expose stable categories such as `authentication_error`, `invalid_preview`,
`inventory_apply_failed`/`purchase_apply_failed`, and
`inventory_verification_failed`/`purchase_verification_failed` -- the domain-specific pair names
which safety flow failed without ever claiming a purchase failure is an inventory-count failure or
vice versa. Raw backend messages and credentials are never returned. Stderr receives only a safe
internal category; stdout remains MCP protocol data.

When Apply is stale, rerun Preview and obtain a new owner approval. When an Apply response is lost,
replay the identical Preview ID and approval code; the existing mutation receipt returns the stored
result without another ledger event. There is no force option.

## Slice 2.1A -- remote HTTP MCP

Slice 2.1A adds a second transport for the exact same five tools above. It adds no new business tool,
no new business RPC, and no generic SQL/RPC tool -- `apply_inventory_physical_count_batch` remains the
only MCP-reachable mutation, on both transports.

### Local stdio is now the recovery/debug path

`scripts/product-lab-mcp/server.ts` (stdio) is unmodified and still works exactly as documented above
(manual owner token, `.claude`/`.codex` config, loopback tests). It is kept specifically as a recovery
and debugging path -- for example when the remote endpoint or Supabase's OAuth Server is unavailable,
or when diagnosing a problem without going through OAuth at all. It is not being deprecated by this
slice.

### Remote endpoint: `/api/mcp`

`src/app/api/mcp/route.ts` mounts the same `createProductLabMcpServer(...)` registry behind
`@modelcontextprotocol/server`'s `createMcpHandler`, over Streamable HTTP. Every request must carry
`Authorization: Bearer <Supabase OAuth access token>`; the request is authenticated exactly once per
HTTP exchange (`scripts/product-lab-mcp/remote-auth.ts` -> `scripts/product-lab/auth.ts`'s
`authenticateProductLabRequest`, the same `app_metadata.app_role === "owner"` rule the stdio path and
the web app's `/api/owner` route already use) and a fresh, request-scoped server instance is built
from that one already-authenticated client -- never a process-global session, never a second
authentication round trip within the same exchange. The route also enforces Host/Origin allowlisting
(`scripts/product-lab-mcp/origin-policy.ts`, SDK-provided `hostHeaderValidationResponse`/
`originValidationResponse`) in front of the bearer-auth gate, since `createMcpHandler` is deliberately
validation-free for both and expects the mounting app to do this.

### OAuth discovery endpoints

`src/app/.well-known/[...path]/route.ts` serves the two documents an MCP server acting as an OAuth
Resource Server must expose:

- `GET /.well-known/oauth-protected-resource/api/mcp` (RFC 9728) -- names Supabase as the
  `authorization_servers` entry for the `/api/mcp` resource.
- `GET /.well-known/oauth-authorization-server` (RFC 8414) -- mirrors Supabase's own Authorization
  Server metadata (fetched live from Supabase, cached briefly, never hardcoded), for clients that
  probe the resource origin directly instead of following the Protected Resource Metadata's
  `authorization_servers` entry.

### Supabase remains the OAuth 2.1 authorization server

Product Lab MCP does not implement, and must never implement, a custom OAuth server. Supabase's OAuth
2.1 Server (beta) issues, signs, and refreshes every access token; this project only verifies tokens
(via `auth.getUser`, a real round trip to Supabase Auth -- never a local-only JWT decode for the
authorization decision) and republishes Supabase's own discovery metadata under this server's origin.
No custom access-token format, no refresh-token storage, no PAT system, and no separate Product Lab
auth database exist anywhere in this slice.

### `/oauth/consent`

`src/app/oauth/consent/page.tsx` is the authorization/consent UI Supabase's OAuth Server redirects an
end user's browser to (its `authorization_url_path`, configured in the Supabase dashboard -- see
"Production configuration" below). It requires the SAME Product Lab owner sign-in the rest of the app
uses (`supabase.auth.signInWithPassword`), re-verifies ownership through the existing `GET /api/owner`
route (no new owner-check logic), then drives Supabase's own
`supabase.auth.oauth.{getAuthorizationDetails,approveAuthorization,denyAuthorization}` client methods
to show the requesting client's name/logo and requested scope and complete the authorization-code
flow. It is not a general-purpose login page and does not replace `/api/owner` or the app shell's own
session gate.

### Durable preview store

The stdio path's local-filesystem preview store (`.inventory-operator/previews/*.json`) cannot be
authoritative for a serverless deployment -- no durable local disk, and nothing shared across
invocations or regions. The remote path instead persists preview artifacts in
`public.product_lab_mcp_previews` (migration
`supabase/migrations/20260914120000_product_lab_mcp_durable_previews.sql`, **not yet applied to any
database**), behind the exact same `InventoryCountArtifactStore` interface
(`createDurableInventoryCountArtifactStore` in
`scripts/product-lab/inventory-count-service.ts`) the filesystem store already implements -- the
preview/apply/verify business flow itself does not change between transports.

The table's primary key is `(owner_id, preview_id)`, not `preview_id` alone: `preview_id` is
content-derived (a hash of the normalized count payload), so two different owner accounts counting
identical items independently derive the same `preview_id`. A global primary key would make the
second owner's otherwise-valid preview fail with a spurious duplicate-key error; the composite key
scopes uniqueness per owner instead, while every externally-visible identifier -- `preview_id` itself,
`payload_hash`, `operation_id`, `approval_code` -- is completely unchanged. RLS (enabled and forced)
additionally requires `is_product_lab_owner()` AND `owner_id = auth.uid()` on every policy, so one
owner account can never read, apply, or verify a different owner account's preview even though both
may hold a row with the same `preview_id`. The table is written only by `InventoryCountService` via
structured PostgREST calls with a fixed column set -- no MCP tool input schema maps onto this table,
so there is no free-form write surface. Retention is a 24-hour default `expires_at`, enforced by the
store's own read path (no background sweep exists yet in this slice -- a documented gap, not a silent
one).

### Same five tools, same safety flow

`inventory_list`, `ingredient_inspect`, `inventory_count_preview`, `inventory_count_apply`,
`inventory_count_verify` -- unchanged, and `createProductLabMcpServer` is not duplicated or forked
between transports. The preview -> owner approval -> apply -> verify boundary documented above (see
"Approval boundary") is identical on both transports: Preview never mutates, Apply requires a NEW
owner message containing the exact approval code shown in Preview, and only Verify may report
`status: "verified"`.

### Deferred: AuthInfo.resource / RFC 8707

The MCP SDK's `AuthInfo.resource` field (RFC 8707 resource indicators, for a token explicitly scoped
to one protected resource) is intentionally left unset in this slice. It becomes relevant as
defense-in-depth only if multiple distinct protected-resource servers ever exist under the same
Supabase OAuth project (so a token minted for one cannot be replayed against another); Product Lab MCP
has exactly one resource (`/api/mcp`) today, so there is nothing for it to distinguish yet. Revisit
this if a second protected resource is ever added under the same Supabase project.

## Production configuration required before deployment

None of the following has been applied to any Supabase project by this slice -- these are the exact,
human-executed steps required before a real OAuth client can complete the flow end to end. No
credential, project secret, or project-specific value is recorded here or anywhere else in this repo.

- **Enable the OAuth 2.1 Server.** Supabase Dashboard -> Authentication -> OAuth Server. Free during
  the current beta on all Supabase plans.
- **Authorization URL path.** Set to `/oauth/consent`, matching `src/app/oauth/consent/page.tsx` and
  this project's configured Site URL.
- **Dynamic Client Registration (DCR): OFF for Slice 2.1A, intentionally.** This is a decision record,
  not a placeholder -- see "DCR decision" immediately below.
- **Redirect URI.** Must be registered to match each OAuth client that will connect, exactly. None is
  required to exist yet for this foundation slice; Slice 2.1B is where an actual client's redirect URI
  gets registered.
- **Signing key.** Supabase generally recommends migrating to an asymmetric algorithm (RS256/ES256)
  for OAuth use cases, and requires it if OpenID Connect ID tokens are ever requested. This slice
  requests no `openid` scope and no ID token, so an asymmetric key is **not required by this slice's
  current scope** -- revisit only if OIDC is adopted later.
- **No service-role or secret key anywhere in this path.** Every client this slice constructs (stdio
  and remote) uses only the publishable/anon key, validated by
  `assertUnprivilegedSupabaseProjectKey`; this must remain true for any future change to this file.

### DCR decision

Slice 2.1A deliberately leaves Dynamic Client Registration **OFF**. Concretely, this means:

- The remote OAuth foundation described above exists and is tested (see the Slice 2.1A section).
- Automatic "paste a URL and connect" onboarding for a new MCP client is **NOT** complete. A future
  operator must not assume it already works.
- Claude Code and Codex (or any other MCP client) require **manual** OAuth client registration against
  the Supabase project before they can connect to `/api/mcp` at all.
- **Slice 2.1B** owns actually wiring a daily client's configuration to the remote endpoint, and owns
  the decision of whether and when to enable DCR. Slice 2.1A does not make that decision for it.

Deployment must not proceed until hosting/commercial-use suitability is separately resolved -- at the
time of Slice 2.1A, the project's Vercel plan tier was unknown to the implementing session. If the
plan is a Hobby tier, commercial deployment requires either upgrading to a commercially-appropriate
Vercel plan or migrating to a commercially-compliant hosting target. This slice does not change
hosting and does not decide that question.

## Production boundary

Automated tests use loopback fixtures and disposable/local database smoke tests only. Building or
reviewing Slice 2 / 2.1A / Daily Bakery Ops V2 Slice 1 does not authorize a live physical count, a
live purchase, production read/write, a Supabase production setting change, applying the Slice 2.1A
migration or the Daily Bakery Ops V2 Slice 1 purchase-preview migration, deployment, commit, push,
PR, or merge. A live purchase rehearsal requires independent review and deployment first, exactly
like a live physical count.
