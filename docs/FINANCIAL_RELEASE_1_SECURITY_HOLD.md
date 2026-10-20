# Financial Release 1 security hold — 2026-10-20

**Production readiness: BLOCKED.** Finance code and deployment-plan independent reviews pass;
the dependency security gate does not. This is a WIP checkpoint, not merge or release approval.

`npm audit --omit=dev --json` against the unchanged main lockfile reports four affected packages:
one critical (`next`) and three high (`sharp`, `nanoid`, `source-map-js`). Finance has no package
or lockfile diff. Next is 16.2.11; locked Sharp is 0.35.3 (manifest lower bound `^0.35.0`).

Maintainer evidence:

- [Next AVIF image optimization RCE](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4): affected before 16.3.3.
- [Next ImageResponse RCE](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j): affected 16.2.0 through versions before 16.3.6.
- [Sharp Linux librsvg advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w): affected before 0.35.5; exploit conditions depend on Linux runtime and SVG decoding.
- Additional audit entries: Sharp/libheif `GHSA-rgj7-g3m4-5g8c`, Nanoid `GHSA-2v37-7h3g-55p8`,
  source-map-js `GHSA-68fv-2mgg-jv7q`, and Next cache/SSRF/disclosure advisories.

No exploit was attempted and deployed exploitability is not proven. There is no direct `next/og`
usage in app source. Content Studio does decode media with Sharp. These dependency advisories
remain unresolved; do not waive them because Finance itself adds no image processing.

## Verified before the hold

- Production refund deploy remains `6ad77d3799debf1d75d48671`; no automatic deployment integration
  or build hooks. PRs #106 and #107 merged without deploying.
- Production recovery state verified by read-only SQL: both migration versions recorded, three
  orders completed/paid without refunds, three corrections and one incident. No recovery rerun.
- Linux Node 24.19.0 clean locked install: 4,547 unit tests pass, zero fail; four explicit Windows-only
  cases skip on Linux. Disposable PostgreSQL suite: 191 pass, zero fail/skip, including new real
  correction-RPC-to-Finance reporting regressions. Type checking passes.
- Loopback-isolated disposable desktop browser run reached 35 passing assertions, including monthly reports,
  duplicate expense refusal/confirmation, idempotent save, void/correction history and reload.
  The run was interrupted during dependency installation; it is **not** a passing complete browser
  suite. The full suite must be rerun with the tracked write guard in the routing chain; mobile
  acceptance and remaining navigation regression checks are outstanding for this candidate.
- Local Linux Netlify build passes with adapter 5.16.3: Finance, seven API routes, all required Linux
  native libraries and 24 JS/CSS files packaged; no Windows native files. No upload was made.
- October production SELECT-only reporting: 33/33 completed orders fully costed, revenue PHP8,380,
  ingredient COGS PHP3,398.13, gross margin PHP4,981.87, no active refunds. Operating result correctly
  unavailable while the expense ledger is absent. September: 42 uncosted orders of 56; cost coverage
  and pre-start warnings retained, margin/result withheld. No historical transactions changed.

Local evidence is preserved under `outputs/finance-resume-2026-10-20/`, including the original work
snapshot, full test logs, audit JSON, guarded browser log and read-only production aggregate report.
The original dirty Finance checkout remains untouched. Clean preservation ref:
`safety/finance-pre-integration-clean-20261020` (`e71ddbba8a83657dc3a9fafc43dbaadc9b911f06`).

## Resume action

Prepare a separate, scoped dependency security repair against current main; assess supported patched
Next/Sharp/transitive versions and adapter compatibility rather than running an unreviewed `audit fix`.
Recheck the lockfile advisory list and rerun affected renderer/server-route/Netlify packaging checks.
Then integrate that repair into this Finance branch and complete the guarded disposable browser suite.
Only after renewed security and QA approval may this PR become merge-ready. Production migration,
Finance draft upload and promotion still require the user's separate approval and the exact
[Finance deployment plan](FINANCIAL_RELEASE_1_DEPLOYMENT.md).
