# Manual Netlify deployment

Production: `https://app.alyandpon.com`; site `07c4bd1b-638f-4103-8979-1bfe5153adde`.
Production remains refund deploy `6ad77d3799debf1d75d48671` until a separately approved release.

## Source and platform gates

Build an isolated checkout/export of the reviewed commit. Preserve a source SHA and archive hash;
never deploy a dirty working tree. `netlify.toml` is committed and selects `.next` plus the existing
Next adapter. No Git provider/repository, Netlify build hook, repository webhook or GitHub workflow
is configured (verified 2026-10-20). Merging a PR does not deploy. Keep deployment manual.

## Verified Linux procedure

Use `node:24.19.0-bookworm`, Linux x86_64, with source at `/app` and a Linux-only dependency volume
at `/app/node_modules`. Supply the existing Netlify login in `NETLIFY_AUTH_TOKEN` without printing it.
From `/app`:

```sh
npm ci --include=optional --no-audit --no-fund
npx --yes netlify-cli@27.10.2 deploy --build --context production --dir .next \
  --site 07c4bd1b-638f-4103-8979-1bfe5153adde \
  --message "Reviewed release <source SHA>" --json
```

This creates a draft. The validated adapter is `@netlify/plugin-nextjs@5.16.3`; check the generated
function manifest before accepting another version. Preserve Linux sharp/libvips/resvg and all
Next server routes. Do not deploy a Windows dependency tree or a static export.

The adapter's `onPostBuild` temporarily replaces `.next` with prepared public/static files before
the CLI uploads; `onEnd` restores the build and leaves static output in `.netlify/static`. Thus the
combined build/deploy publishes `.next`. A bare `--no-build` upload without a configured publish
path fell back to the repository root and omitted all Next assets. `--dir .netlify/static` is also
wrong during the combined build's temporary publish lifecycle. Do not bypass that lifecycle.

## Draft and release gates

Compare the deployment-file inventory and SHA-1 hashes against `.netlify/static` after completion;
the API normalizes path case, so also request original-case URLs. Require 200 for every JS/CSS asset,
no source-tree uploads, processed headers/redirects, and the Linux server-function manifest/routes.
Verify authentication, Orders, Content Studio/Saved Creatives and desktop/mobile navigation.

Production-context drafts share production Supabase. Use `createGuardedContext` from
`scripts/qa/production-write-guard.mjs`; block service workers and all non-read preview/function
requests. Never click payment/refund/order/expense mutations against production. Test mutations only
on a verified disposable backend. Reuse the existing browser evidence for unchanged code.

After all gates and the release's explicit production approval, publish the already-tested atomic
draft through Netlify's Publish Deploy action/API, then perform guarded non-mutating smoke checks.
Record the previous published deploy as rollback before promotion; restore that atomic deploy if needed.
No rebuild during promotion. No automatic migration application. Finance requires separate approval
for both its migration and production deployment.

Incident evidence: [asset repair](NETLIFY_REFUND_ASSET_REPAIR_2026-10-20.md).
Platform references: [Next.js adapter](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)
and [atomic rollback](https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/#rollbacks).
