# Financial Release 1 final QA — 2026-10-20

**Technical production readiness: PASS.** Finance is prepared for owner review and release approval.
Neither PR is merged into main by this task; no Finance production migration, upload or deployment
has been performed. Production remains refund deploy `6ad77d3799debf1d75d48671`.

## Candidate and scope

Existing Finance candidate `7dcf5c088704e6cae4873519dbe3de39d66f0baa` (PR #108) integrates the exact
reviewed security repair `f201920f5ea012407df44bd129ccba47cf021fac` (PR #109). The only integration
conflicts were REVIEW.md, STATUS.md and planning/DONE.md; both histories are retained.

Finance calculation/repository/page code, refund code, database migrations and Netlify configuration
are unchanged from the existing Finance candidate. Accounting decisions remain D-009/D-010. The
expense migration is byte-identical, SHA-256:
`ddd837ee7b9d3a05e4b520e035358b712584bed33f8707d655f82869fe94e6b0`.
The original dirty Finance checkout and safety refs remain intact.

## Security and dependencies

Runtime audit before: one critical and three high affected packages. After: **zero vulnerabilities**
under `npm audit --omit=dev --json`, both on the security-only source and integrated Finance source.

| Package | Previous resolved version | Reviewed resolved version |
| --- | --- | --- |
| Next.js | 16.2.11 | 16.3.8 |
| eslint-config-next | 16.2.11 | 16.3.8 |
| Sharp | 0.35.3 | 0.35.5 |
| Nanoid | 3.3.16 | 3.3.20 |
| source-map-js | 1.2.1 | 1.2.2 |

React, the Netlify adapter and unrelated direct dependencies are retained. Full development audit
still has 9 high / 1 moderate affected packages in existing test/lint/build tools, including unpatched
`braces`. Independent review classifies these as documented non-runtime tooling risk; a full clean
development audit is not claimed. See [precise paths/advisories and evidence](DEPENDENCY_SECURITY_2026-10-20.md).

## Verification results

| Gate | Result |
| --- | --- |
| Full Linux unit suite | 4,547 pass, zero fail; four explicitly Windows-only cases skipped on Linux. |
| Full Linux disposable PostgreSQL suite | 191 pass, zero fail or skipped. |
| TypeScript and source ESLint | PASS with the matched framework configuration; generated build/evidence files excluded. |
| Production-context Netlify build | PASS, Node24.19.0 bookworm x86_64, CLI27.10.2, adapter5.16.3. No upload. |
| Packaged assets and routes | All23Next static assets locally return200 with byte/hash identity;22JS/CSS, all7APIroutes, Finance page present. Next build-manifest references resolve. |
| Packaged native processing | Sharp0.35.5/librsvg2.63.2/libvips8.18.7 load from the generated Linux function; PNG/JPEG/WebP/SVG decode and transform. No Windows native libraries. |
| Finance desktop/mobile acceptance | **64/64 PASS** at1280/390/320: month selection, warnings/withholding, expense create, duplicate warning/confirmation, idempotent save, correct/void audit history, filters, persistence, touch navigation and responsive amounts. |
| Integrated Orders/refund acceptance | **36/36 PASS**: eligibility, guarded correction, stale-state refusal, preserved paid/completion/COGS facts, history after reload, confirmation, and Cancel making **zero write requests**. Desktop plus390/320 forms. |
| Integrated navigation/server-route acceptance | **40/40 PASS** at1280/390/320: authentication, Orders, Inventory, Bake asynchronous selection/missing link/visible older-voided disclosure, Content Studio, no runtime/asset failures, all7unauthenticated APIroute gates including configured MCP401. |
| Media acceptance reused from exact security source | Synthetic JPEG/PNG/WebP/MP4 uploads, signed preview/reload/product filtering; real5-slide1080×1350carousel and exact ZIP export; playable11.05sReel with byte-identical export;320/375/390/1280layouts. Content Studio source and patched dependencies are unchanged in Finance. |
| Independent code/security/safety review | APPROVED; no unresolved blocking implementation, accounting or data-integrity finding. |

Disposable database coverage includes expense RLS/privileges, direct-write rejection, idempotency,
concurrent duplicates, append-only correction/void history, migration additivity and rollback guards;
real order completion, frozen fulfilled COGS, genuine refunds and audited correction → reporting.
No financial mutation was tested on production or a preview sharing production.

The browser app was exported from the resolved merge index, with only tracked source files and
an isolated dev output directory. Its286source files match the integrated candidate exactly. The
test server had only explicit loopback Supabase configuration and a dummy publishable key. Tests
installed the unchanged mandatory write guard, blocked service workers and external traffic, and
used `fallback()` in additional routes. SQL mutations targeted only freshly created `finqa` containers.
Media fixture persistence is in memory; database authorization is separately tested in PostgreSQL.

## Production read-only reconciliation

Guarded SELECT-only reporting confirms October:33completed orders,33fully costed, revenue PHP8,380,
ingredient COGS PHP3,398.13, gross margin PHP4,981.87, no active refunds. The expense ledger is still
absent, so operating result remains unavailable rather than assuming zero expenses.

September retains42uncosted orders of56, incomplete-cost and pre-start warnings, estimated-cost
disclosure and withheld gross margin/operating result. No historical business transaction changed.
Read-only recovery state matches the earlier verified state exactly: the two applied recovery
migration versions, three Paid/completed orders without refunds, three correction rows and one incident.
No migration or recovery script was replayed.

## Evidence and next release action

Local logs, screenshots, fixtures and JSON results: `outputs/security-finance-final-20261020/`.
Committed `docs/security/2026-10-20/finance-final-qa.json` summarizes the exact gate results, browser
assertions and artifact identifiers. Reproduce source checks using the commands in the dependency
report; the Finance database suite includes its existing expense and report integration tests.
Browser harnesses reuse the existing acceptance cases with `createGuardedContext`; the isolated
fixture backend and captured source export remain with the local evidence.

Owner review of security PR #109 and Finance PR #108 is next. After source-control approval and
separate explicit production approval, follow [the exact Finance plan](FINANCIAL_RELEASE_1_DEPLOYMENT.md):
apply only the reviewed expense migration transaction, verify and record only its version, create
a Linux production-context Netlify draft, run guarded read-only draft smoke checks (including edge
asset200/hash checks), then promote that exact draft and perform non-mutating production smoke checks.
Do not replay refund/recovery migrations or use broad `db push`. Keep prior refund deployment as
atomic rollback. Actual Netlify draft-edge verification is a future approved release step, not claimed
by the local package checks. Physical iOS Safari/Android feel remains human verification.
