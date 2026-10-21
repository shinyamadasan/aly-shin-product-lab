# MCP input security hotfix — release candidate

Independent security review: **APPROVED**, no blocking findings. Source integration and a new
Netlify draft are authorized. Production publication, Worker deployment and the Finance view
migration require the final production checkpoint. This document describes the candidate;
it does not assert that either live endpoint is patched.

## Scope and dependency evidence

Approved base: `508ff02ec99602ca9a559b7e970703a4f52f5cbf`. Exact installed/locked versions:

| Package | Before | After |
| --- | --- | --- |
| @modelcontextprotocol/server | 2.0.0 | 2.3.0 |
| @modelcontextprotocol/client (development/test) | 2.0.0 | 2.3.0 |
| @modelcontextprotocol/core (deduplicated transitive) | 2.0.0 | 2.3.0 |

Only these three resolved package versions change. No separate MCP transport package is installed;
HTTP and stdio transports come from this SDK family. The lockfile retains its integrity hashes.
Production `npm audit --omit=dev`: **zero vulnerabilities**. Full audit: nine unrelated development
dependency findings (eight high, one moderate), none in the MCP family or its transport dependencies.
They are retained without unrelated upgrades.

The upgrade removes the package findings for
[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453),
[GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp) and
[GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq).
Actual tool-input protection is explicitly enabled below; a version upgrade alone was insufficient.
The existing request-scoped factory is preserved. Endpoint-specific token audience isolation is not
newly enabled or claimed: the existing contract accepts this Supabase project's owner session tokens
and verifies them with Supabase Auth `getUser`, owner app metadata and database RLS. Introducing a
different audience requirement would change that contract and is outside this input-security repair.

Related maintainer advisories were also checked: HTTP body/batch
[GHSA-f897-62hf-6gxq](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-f897-62hf-6gxq)
is covered by the patched server and explicit limits; client redirect
[GHSA-6prh-2h8m-c8cw](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw)
is patched in client 2.3.0. Client issuer
[GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)
is patched from 2.2.0; this repository's client use is development/test-only, with fixture tokens,
no bundled OAuth credential provider or persisted OAuth credentials. Experimental task-store
[GHSA-22jm-h49p-29qw](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-22jm-h49p-29qw)
does not affect the 2.x packages; this registry enables no task store. No old monolithic SDK or
separate Node/Express MCP transport package is installed.

## Enabled limits

`scripts/product-lab-mcp/input-limits.ts` defines the shared bounds:

- HTTP body: **262,144 bytes (256 KiB)** through SDK `createMcpHandler.maxRequestBodySize`.
  The SDK bounds actual streamed bytes as well as declared length, before parsing or server creation.
  Both modern and legacy HTTP paths use the cap. The adapters supply the original Web Request;
  neither passes an unbounded pre-parsed body.
- Tool arguments: **5,000 elements** through `McpServer.maxToolInputElements`. The SDK iteratively
  counts arguments, including unknown properties, before Zod validation. Applies to HTTP and stdio.
- Physical-count rows: **1–500** in the existing strict MCP preview schema. A 500-row request with
  all seven row fields and source metadata fits the element budget; the HTTP byte cap also applies.
  The shared CLI/core inventory service is unchanged.
- SDK legacy JSON-RPC batch cap: **100**; modern HTTP does not accept batches. A 101-message batch
  is rejected on both negotiated paths. No custom batch parser was added.

Netlify's route and the Cloudflare Worker call the same shared HTTP handler and registry, so both
code paths need the repair. Netlify currently returns its existing sanitized configuration error;
that is not evidence that the separately hosted Worker is safe. **The live Worker remains on its
previous artifact until a separately approved Worker deployment.** The new Netlify draft alone
cannot remediate it. No live attack fixture is used for verification.

## Verification and unchanged boundaries

- Baseline: 99/99 focused MCP/inventory tests. Repaired candidate: 110/110; independent reviewer
  separately ran 86/86 MCP tests. Full units: 4,587 pass, zero fail, one existing platform skip.
- Disposable PostgreSQL/PostgREST security and Finance suites: 22/22. Real MCP preview, invalid
  approval (unchanged stock/history), valid approved apply, verify and idempotent replay pass through
  the Next route, Worker adapter and actual local workerd. Existing V1A database boundary: 11/11.
- Bounded non-production fixtures reject oversized streamed bodies with absent, accurate and false
  lengths, excessive arguments, 501 count rows and excessive JSON-RPC batches. Rejected calls create
  no preview or physical-count RPC; subsequent valid reads work.
- TypeScript, source/touched-test ESLint, Next production build and Worker packaging dry-run pass.
  Unscoped root lint also traverses generated `.wrangler` bundles and reports their lint errors;
  application and touched security sources pass without changing generated files or lint config.
- Owner authorization, Host/Origin checks, project-key restrictions, request-scoped instances,
  durable owner-scoped previews, approval-code/payload binding, the sole count RPC and replay
  protection are preserved. No new database or financial writer exists.

Finance application files and migrations are byte-identical to the approved base. In particular:
`supabase/migrations/20261020232146_financial_stock_count_gains.sql` SHA-256 is
`e66aede4245d240036ab8278ad14cf68c38526522c622463e0dcbe0fc3f368be`.
The new app remains compatible with the old production view and must continue withholding October's
operating result until that exact migration is separately approved and applied.

## Final production sequence — separate approval required

1. Reconfirm the exact security merge/source tree, new draft inventory and hashes, production
   environment digest and current published deployment. Supersede old draft `6ad7ffc7bf018f9cf58f82ca`;
   never promote it. Recheck owner tabs/stock-write pause arrangements for the short rollout.
2. Refresh restricted, restorable schema/data/roles/migration-history backups; verify restore and
   read-only stock/Finance snapshot. Revalidate owner/RLS/service-role permissions, raw count and
   reversal boundaries, audit trigger protection and migration history. Abort on unexpected drift.
3. Publish the exact newly verified Netlify draft atomically, without rebuilding or changing site
   environment. Verify assets, authentication, guarded owner workflows and old-view Finance behavior.
   Keep the previous production deployment ready for application recovery.
4. Deploy the reviewed Worker from the same merged source/lockfile using its existing production
   bindings, without changing secrets or auth configuration. Record its exact version/deployment
   and prior recovery target. Verify discovery, unauthorized/non-owner rejection and owner read-only
   tool access. Do not send oversized attack fixtures, previews or count applies to production.
   Netlify publication alone does not close the live Worker security gate.
5. Only after both compatible applications pass and the final approval explicitly includes SQL,
   execute the existing guarded transaction for **only** version `20261020232146`: exact reviewed
   view migration plus its migration-history entry, with current preflight fingerprints and preserved
   view ACL/security-invoker settings. Never replay the two already-applied Financial Release 2
   migrations. No stock, cost, adjustment, expense, review or audit-history mutation is permitted.
6. Read-only postflight: all business/audit/history fingerprints unchanged; only the intended view
   and its one new migration-history entry differ. Reconcile October sales/COGS/margin unchanged,
   three gains retain unknown-valuation warnings, result shown only if remaining inputs are complete;
   September limitations persist. Repeat guarded browser checks; reopen fresh owner tabs before use.
7. If an application check fails, keep stock writes paused and atomically restore the prior compatible
   Netlify deployment or Worker version as applicable. A Worker rollback to vulnerable code reopens
   this security gate. If SQL fails, its transaction must roll back; do not run historical database
   rollback scripts. If postflight fails after commit, preserve backups, migrations and audit history,
   keep writes paused and investigate before any further SQL. Never report partial rollout as complete.

Ignored evidence: `outputs/mcp-security/` (dependency trees/audits, regression logs, local Worker
checks, read-only snapshots and the new draft's source/build/asset/browser/platform evidence).
Credentials and production business records are excluded from tracked reports.
