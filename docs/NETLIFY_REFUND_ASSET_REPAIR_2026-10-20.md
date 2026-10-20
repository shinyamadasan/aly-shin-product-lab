# Refund hotfix: Netlify static-asset repair, 2026-10-20

Source: `91811efbdb8f6630d971ed378e16bdc1d4f2747a`, PR #106. This is deployment work only. Financial Release 1, migrations, incident recovery SQL and production business-data writes are excluded.

## Confirmed original failure

Failing draft: `6ad702fbb8a23e0bdf05e141`.

Example browser request:

```text
https://6ad702fbb8a23e0bdf05e141--elegant-bombolone-754d65.netlify.app/_next/static/chunks/2nwqoerny79-z.js
HTTP 404
Content-Type: text/plain; charset=utf-8
Body: Not Found
```

The HTML referenced 14 JavaScript assets and one stylesheet; direct HTTP checks found all 15 missing. Guarded Playwright reproduced missing JavaScript requests and failure to hydrate the login form.

The retained Linux build, build ID `wMe0osJ7oJlAUlyeOURKz`, contains the example file in both `.next/static/chunks/2nwqoerny79-z.js` and `.netlify/static/_next/static/chunks/2nwqoerny79-z.js`. Both are 22,466 bytes, SHA-1 `e1af1e8378ddd1d3acb8935c62d01a4680e19f79`. The root build manifest and Orders route build manifest reference that exact filename. Thus the referenced asset was generated, with the correct Next.js URL mapping.

Netlify's deployment-file API returned 884 files, including `/src/`, `/scripts/`, `/supabase/`, package files and documentation, but **zero JavaScript files** and no `/_next/static/` assets. The deploy included one server handler, explaining why HTML still returned 200. Its summary recorded no processed redirects or headers. The adapter output on disk contains the static files, generated routing/header configuration and a Linux server-function manifest (`@netlify/plugin-nextjs@5.16.3`, Node 24, streaming handler, `/*` with `prefer_static: true`).

Cause: the standalone upload selected the repository root, not the adapter's static publish directory, and did not load the adapter-generated routing/header configuration. The site API has no build/publish settings, and the source has no root `netlify.toml`. Netlify CLI 27.10.2's `getDeployFolder` falls back to the working directory in a noninteractive upload with no `--dir` and no configured publish path. Hidden build directories are excluded from that source-root upload. This is an omitted deployment artifact, not a mismatched application build or an application asset-prefix defect.

No connected browser UI was available for Netlify Deploy File Explorer. The authenticated deployment-file API inventory is retained as the programmatic evidence; do not describe it as a visual Explorer inspection.

## Reproducible build and upload

Use an isolated export of the exact source commit, never the dirty Financial Release 1 checkout:

```powershell
git archive --format=zip --output=source-91811ef.zip 91811efbdb8f6630d971ed378e16bdc1d4f2747a
Expand-Archive -LiteralPath source-91811ef.zip -DestinationPath isolated-source
```

The source archive used here has SHA-256 `5f6f628575673517daabda9ad01412ad30ac0ad6659882b6064c4e2e5e04e5e3`. Add this deployment-only configuration to the isolated export:

```toml
[build]
command = "npm run build"
publish = ".next"

[[plugins]]
package = "@netlify/plugin-nextjs"
```

Build in `node:24.19.0-bookworm`, Linux x86_64, with the export mounted at `/app` and a separate Linux dependency volume at `/app/node_modules`. Supply the existing Netlify CLI login through `NETLIFY_AUTH_TOKEN`; never put the token in source or logs. Run from `/app`:

```sh
npm ci --include=optional --no-audit --no-fund
npx --yes netlify-cli@27.10.2 deploy --build --context production \
  --dir .next \
  --site 07c4bd1b-638f-4103-8979-1bfe5153adde \
  --message "Refund hotfix 91811ef: clean Linux build; explicit adapter publish lifecycle" \
  --json
```

Do not use `--prod` until the draft gates pass. The `.next` build setting is the adapter's input. During the combined build/deploy, the adapter's `onPostBuild` temporarily replaces `.next` with the prepared static directory before the CLI deploy handler runs; its `onEnd` restores the Next build and leaves the static output at `.netlify/static`. Therefore the combined command must publish `.next`, not `.netlify/static`. A trial using the latter completed compilation and function bundling but failed during the build's deploy handler, before upload. The lifecycle was checked directly in the installed adapter and CLI source before correcting the command. The CLI packages the adapter's server functions and deployment blobs together with those assets. Do not copy a Windows dependency tree or deploy the unadapted `.next` build as a static site.

CLI 27.10.2 rejects both `--config` and the combination `--no-build --context production`. Initial attempts stopped before creating any deployment. Automatic approval review rejected a proposed manual copy of production secrets into draft-specific overrides. That path was abandoned; no overrides were uploaded. The supported build path above uses Netlify's existing production-context configuration handling and does not change site environment settings.

## Verification safety and evidence

Existing incident recovery records under the `hotfix/refund-incident-recovery` checkout remain intact. Its `scripts/qa/production-write-guard.mjs` passed 5/5 tests.

Every browser context uses one request handler combining the existing production-host decision with a block on every non-read request to preview/server-function origins. Service workers are disabled. Only production Supabase authentication and the pure owner check may use POST. No payment/order action is clicked against production data.

For confirmation/Cancel interaction tests, the draft's unchanged served client is used, but **all** Supabase requests are fulfilled from a disposable Postgres + real PostgREST + local auth shim. No Supabase request from that context reaches production; non-read preview-function requests are still blocked. The disposable rig uses the hotfix source without the expense-ledger migration. Its pre-existing optional media migration could not run because the lightweight rig lacks `storage.buckets`; real Content Studio loading is therefore verified separately against production reads.

Raw evidence and screenshots: `outputs/netlify-asset-repair/` (ignored operational artifacts). Live browser reports contain route/status evidence and no owner password or token. No application code was changed.

## Release state

Corrected draft: `6ad77d3799debf1d75d48671`, build ID `PjfSYE0Aq-XDKmL4JQPxt`.

Draft gates passed:

- Source identity: all 899 archived files still match after the build, zero differences. Only the deployment-only `netlify.toml` is added to the export.
- Deployment inventory: 37 entries (36 static files plus Netlify's configuration entry), zero repository-source leaks. The API lowercases filenames; matching hashes and HTTP requests to all original-case URLs prove this is normalization, not omission.
- All 36 static files, including all 24 JS/CSS assets, return 200 and match the Linux output SHA-1 hashes.
- Netlify summary: 3 redirects, 1 header rule, 1 server function, all processed successfully.
- Function ZIP: SHA-256 `869f9b7fcb5f6c352f9baef323c7a2eb49223e1fed8c5094bb6e073f60c06008`. Seven API routes are included (owner, public orders, MCP, production, manual production, Content Studio carousel/reel), along with Linux sharp, libvips and resvg. No Windows binaries.
- Guarded live-data browser pass: 32/32. Login hydrates, real owner authentication succeeds, Orders renders, desktop/mobile navigation works, Content Studio creation controls and Saved Creatives finish loading, original Reel availability boundary is retained. Carousel/production GET probes correctly return 405; authenticated Reel GET returns 200 with rendering unavailable on Netlify. No asset failures, browser runtime errors or forbidden request attempts.
- Guarded disposable-data browser pass: 35/35. At 1280, 390 and 320 px the real served Refund button opens the amount/customer confirmation, Cancel sends no write request, the order remains paid, and orders/refund-audit/inventory/stock fingerprints remain identical. The native mobile order dialog closes normally before navigation. Supabase traffic is redirected locally, and the owner-check GET is answered using the disposable database's signed-JWT owner RPC; real deployed owner authentication is independently covered by the live-data pass.

Initial harness failures were retained and resolved without application changes: the first Content Studio sample preceded hydration; a local JWT was correctly rejected by the real Netlify owner function until the test owner-check was wired to the disposable backend; mobile navigation was correctly blocked by the open native order dialog until the test closed it.

Self-review against `SELF_REVIEW.md`: smallest deployment/configuration repair; no application redesign, duplicated app logic, speculative feature, source drift or unrelated edit. QA against `QA.md`: functional, responsive, regression, data-safety, documentation and Git-scope checks pass for this deployment repair. Existing broad application test evidence is retained in the hotfix review; the application unit/Postgres suites were not rerun because application code is unchanged. Real-device iOS/Android rendering remains a human check; automated widths and screenshots were verified.

Production baseline and rollback target: `6ad0e1855136bc0b75fe73bf` (Content Studio source `27bc899`). The release operation will publish the already verified atomic draft, with no rebuild, migrations or business-data requests. PR #106 remains open and mergeable at the exact source commit; no PR merge is part of this deployment repair.

## Production result

Published the verified atomic deploy `6ad77d3799debf1d75d48671` to https://app.alyandpon.com on 2026-10-20 at 07:48 America/Phoenix (14:48 UTC). No rebuild occurred during promotion. Netlify's published-deploy identity matches the tested draft.

Post-release checks: **32/32 guarded non-mutating browser assertions pass** at 1280, 390 and 320 px. All 36 static files return 200 through the production domain with identical hashes. Zero forbidden request attempts, zero browser runtime errors, no JavaScript/CSS 404s. Authentication, Orders, Content Studio/Saved Creatives, navigation and the server routes pass. Production Refund was verified in served code only; it was never clicked. Refund/Cancel interaction evidence is exclusively the 35/35 disposable-data checks.

The exact source commit remains `91811efbdb8f6630d971ed378e16bdc1d4f2747a`; its isolated checkout has no tracked diff. This manual Netlify deployment has `commit_ref: null`, so source provenance is established by the Git archive hash and all 899 verified source files, rather than claiming Netlify recorded a Git commit it did not record.

No migration, Financial Release 1 change, production business-data write or incident-record rewrite was performed. Site environment settings are unchanged. Rollback deploy `6ad0e1855136bc0b75fe73bf` was confirmed ready before promotion; restoring that atomic deploy is the prepared rollback, with no database rollback or migration required. PR #106 remains OPEN; no merge was requested or performed.

Official platform references: [Next.js adapter](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/), [atomic publish/rollback](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/#rollbacks). The installed adapter/CLI lifecycle, actual deployment inventories and observed HTTP responses are the evidence for this incident's exact cause.
