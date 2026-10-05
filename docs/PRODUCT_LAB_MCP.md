# Product Lab MCP Slices 1–2.1A

Product Lab exposes the same MCP tool registry over two transports: a local stdio implementation
(Codex/Claude Code, launched as a child process with a manually-supplied owner token) and, as of
Slice 2.1A, a remote Streamable HTTP endpoint authenticated with Supabase OAuth-issued bearer
identity. Both transports register the exact same five tools: the Slice 1 read tools `inventory_list`
and `ingredient_inspect`, plus the V1A physical-count tools `inventory_count_preview`,
`inventory_count_apply`, and `inventory_count_verify`. Neither transport adds, removes, or duplicates
a tool definition -- see "Slice 2.1A -- remote HTTP MCP" below for exactly what changed and what did
not.

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

`scripts/product-lab/inventory-count-service.ts` owns the existing preview/apply/verify orchestration and
the Supabase-backed durable preview store (the only store the remote transport imports). The local
filesystem preview store and its environment-token wiring live in
`scripts/product-lab/inventory-count-service-local.ts`, used only by the stdio server and
`scripts/inventory-operator/run.ts` (TASK-073). Matching, unit normalization, payload hashing, preview identity, approval binding,
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

`src/app/api/mcp/route.ts` (since TASK-073 a thin adapter over the shared
`scripts/product-lab-mcp/http-handler.ts`; see "TASK-073" below) mounts the same
`createProductLabMcpServer(...)` registry behind
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

## TASK-073 -- remote MCP on a Cloudflare Worker

TASK-073 moves the remote HTTP transport's **host**, not its behavior. The five tools, their approval
rules, the Supabase OAuth authority, RLS, the durable preview store and the single mutation RPC are
untouched, and no database migration is required.

### Topology

```text
Web app:      Browser                -> current web host (Netlify)       -> Supabase
Remote MCP:   Claude / ChatGPT       -> Cloudflare Worker (this section) -> Supabase
Local/debug:  Claude / Codex (stdio) -> stdio MCP server                 -> Supabase
```

- **The Worker is the intended remote MCP host.** `workers/product-lab-mcp/index.ts` serves
  `GET|POST|DELETE /api/mcp`, `GET /.well-known/oauth-protected-resource/api/mcp` and
  `GET /.well-known/oauth-authorization-server`; everything else is 404, and a wrong method on a known
  route is 405 with an `Allow` header. Nothing is proxied to the web app.
- **The web-app `/api/mcp` implementation remains present and unchanged, as a conditional rollback.**
  It is a usable rollback **only while the Netlify/web host is operational.** The Netlify-hosted
  endpoint has been observed returning `503 {"error":"usage_exceeded"}` while the Netlify team is
  paused for credit exhaustion; during such a pause it is **not an available runtime fallback**. Local
  stdio is the independent debugging/recovery path and does not depend on any host. The old endpoint
  has not been retired, and nothing in this repo disables it.
- **Supabase is still the OAuth 2.1 authorization server, the token/user authority, the RLS/data
  authority, the durable preview store and the inventory mutation authority.** The Worker is only the
  resource server.
- **The Worker moves only the MCP resource-server transport.** Supabase remains the OAuth authorization
  server, and `/oauth/consent` (`app.alyandpon.com/oauth/consent`, `src/app/oauth/consent/page.tsx`)
  remains the authorization UI on the web app. TASK-073 does not move the consent page to Cloudflare.
  See "Cutover prerequisite: the web host must be reachable" below.
- **workers.dev is acceptable for the initial controlled cutover.** A custom domain can follow later.

### One implementation, two adapters

`scripts/product-lab-mcp/http-handler.ts` (`handleProductLabMcpRequest`) and
`scripts/product-lab-mcp/oauth-discovery.ts` (`handleProductLabOAuthDiscoveryRequest`) hold all
transport composition: config, Host/Origin validation, canonical resource URL, the RFC 9728 challenge,
`requireBearerAuth`, the Supabase token verifier, and the request-scoped tool registry. The Next.js
routes and the Worker are thin adapters that call them, so the tool registry is not forked. Both take
`(request, env)`; `env` defaults to `process.env` (Next.js) and the Worker passes its own.

### Worker configuration

`wrangler.product-lab-mcp.jsonc`: name `alyandpon-product-lab-mcp`, entry
`workers/product-lab-mcp/index.ts`, `compatibility_date` `2026-10-05`, `workers_dev` on. No
`nodejs_compat` flag is declared: Node.js compatibility is on by default at this compatibility date.
Three values are required and are **not committed** (they are deliberately not `vars`, so a deploy never
overwrites them):

| Name | Value |
| --- | --- |
| `PRODUCT_LAB_SUPABASE_URL` | the Supabase project URL |
| `PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY` | the unprivileged publishable key (never a service-role/secret key) |
| `PRODUCT_LAB_MCP_PUBLIC_HOSTNAME` | **must equal the Worker's real public hostname**, e.g. `alyandpon-product-lab-mcp.<account>.workers.dev` |

```powershell
npx wrangler secret put PRODUCT_LAB_SUPABASE_URL --config wrangler.product-lab-mcp.jsonc
npx wrangler secret put PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY --config wrangler.product-lab-mcp.jsonc
npx wrangler secret put PRODUCT_LAB_MCP_PUBLIC_HOSTNAME --config wrangler.product-lab-mcp.jsonc
```

Host trust is unchanged and fails closed. The Worker entrypoint forwards **only** those three bindings
and **forces `NODE_ENV=production`** itself: `origin-policy.ts` trusts localhost whenever `NODE_ENV` is
not `production`, and a Worker has no `NODE_ENV` unless one is configured, so leaving it to
configuration would let a missing variable fail open. A request Host/Origin outside the configured
hostname is refused before any token reaches Supabase; `Host` / `X-Forwarded-Host` never choose the
advertised resource URL.

### Node / Workers compatibility findings

- **Real finding, fixed:** `inventory-count-service.ts` evaluated `fileURLToPath(import.meta.url)` at
  module load for its local-filesystem preview store. `wrangler deploy --dry-run` bundled it fine, but
  workerd threw at startup (`import.meta.url` is undefined in a Worker). A bundle check alone does not
  prove a Worker runs. The local store (`node:fs`, `node:path`, `node:url`) was split into
  `scripts/product-lab/inventory-count-service-local.ts`, imported only by the stdio server and the
  inventory-operator CLI. `InventoryCountService` and its interface are unchanged, and the Worker's
  import graph now contains no filesystem code (asserted by `tests/product-lab-mcp-worker.test.ts`), so
  a remote preview can only ever be the Supabase-backed one.
- `@modelcontextprotocol/server`, `@supabase/supabase-js`, `zod`, `Buffer` (`remote-auth.ts`) and
  `node:crypto` (`inventory-operator/core.ts`) all run under workerd with no flags. The Worker does not
  read `process.env`.
- Runtime smoke (local workerd via `wrangler dev`, fake Supabase, no deploy): the Worker started, a real
  MCP client completed OAuth-bearer initialize, listed exactly the five tools and ran `inventory_list`;
  `/nope` was 404, `PUT /api/mcp` 405, a foreign `Host` 403, a missing bearer 401 with an RFC 9728
  `WWW-Authenticate` challenge, and both discovery documents were served. This is a manual check;
  `tests/product-lab-mcp-worker.test.ts` covers the same behavior in Node plus the structural claims.
- Stateless per request, so no Durable Object is used or needed.
- Bundle: about 1989 KiB / 360 KiB gzipped.

### Commands

```powershell
npm run product-lab:mcp:worker:dev       # wrangler dev (local workerd); needs a git-ignored .dev.vars
npm run product-lab:mcp:worker:dry-run   # bundle only; deploys nothing
npm run product-lab:mcp:worker:deploy    # DEPLOYS -- do not run until the cutover is approved
```

### Cutover prerequisite: the web host must be reachable

A fresh OAuth authorization needs the consent page, which lives on the web app. If the web host is
paused or down, a new authorization/consent flow cannot complete, whatever the Worker's state.
**Do not attempt the initial Worker cutover while the web host is paused**, unless an
already-authorized client is shown to authenticate against the Worker without a new consent flow
(unverified; the Worker is a different origin, so a client may well ask to re-authorize).

No Supabase setting change is currently expected: the existing pre-registered OAuth client and its
localhost callback remain, DCR stays OFF, the Site URL is unchanged, and the Authorization Path stays
`/oauth/consent`. These are **assumptions to verify** during the controlled read-only cutover, not
verified facts.

### Where the active remote client configuration lives

The repo's `.mcp.json` is the **stdio** server and is not the remote configuration. The active remote
entry is user-global, in the Claude Code user configuration file `~/.claude.json` under
`mcpServers.product-lab` (type `http`, pointing at the current web host's `/api/mcp`, with a
pre-registered OAuth client and a fixed callback port). It is **not changed** by TASK-073. Cutting a
client over means pointing that entry (or a new one) at the Worker URL, which is a different origin, so
expect the client to run the OAuth flow again; that re-authorization is expected but not yet verified.

### Cutover boundary

TASK-073 does **not** deploy the Worker, change DNS, change any Supabase OAuth setting or Site URL,
enable DCR, change the consent page, change any client configuration, disable the web-app endpoint, or
write production data.

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
reviewing Slice 2 / 2.1A does not authorize a live physical count, production read/write, a Supabase
production setting change, applying the Slice 2.1A migration, deployment, commit, push, PR, or merge.
