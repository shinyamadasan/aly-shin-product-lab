# Targeted dependency security repair — 2026-10-20

Base: `origin/main` at `44d0bb1a66ba3cbd936edeacb4e76540651afdf4`. Finance PR #108 is preserved
separately. Production remains refund deploy `6ad77d3799debf1d75d48671`; no merge, migration,
Netlify upload or deployment is performed by this repair.

## Dependency scope and evidence

The committed lockfile reproduced `npm audit --omit=dev --json`: one critical and three high
affected packages. The patched lockfile reports **zero vulnerabilities in production dependencies**.
Exact before/after audit responses are committed under `docs/security/2026-10-20/`.

| Dependency/path | Before | After | Reason |
| --- | --- | --- | --- |
| Direct `next`, also used by Geist | 16.2.11 | **16.3.8** | Includes critical fixes through 16.3.6 and subsequent SSRF/cache/disclosure fixes. |
| `eslint-config-next` and its Next plugin | 16.2.11 | **16.3.8** | Match the framework version. |
| Direct `sharp`; Next and dev Miniflare deduplicate to its override | 0.35.3 | **0.35.5** | Patch libheif/librsvg advisories; exact direct dependency and existing override. |
| Overridden PostCSS 8.5.23 → `nanoid` | 3.3.16 | **3.3.20** | Compatible patch inside existing `^3.3.16` range. |
| PostCSS / Tailwind node → `source-map-js` | 1.2.1 | **1.2.2** | Compatible patch inside existing `^1.2.1` range. |

Next's matching platform SWC/env packages and `@swc/helpers` 0.5.23 follow the selected framework.
Sharp's matching native packages become 0.35.5 and libvips packages 1.3.4; its WASM dependency requires
`@emnapi/runtime` 1.11.3. npm also records six existing bundled optional Tailwind WASM entries;
Tailwind itself is unchanged. An incidental FastQ refresh was removed, retaining 1.20.1.
React 19.2.4, PostCSS 8.5.23, the PostCSS override, Remotion and other direct dependencies are unchanged.
No forced audit fix, framework downgrade, migration change or general dependency refresh was used.

| Advisory | Affected range in reproduced audit | First patched boundary |
| --- | --- | --- |
| Next `GHSA-p293-qw3h-jr36`, `GHSA-2xp9-vwfh-vxw4` | `>=16.0.0 <16.3.3` | 16.3.3 |
| Next `GHSA-vcvr-r3jv-pc5j` | `>=16.2.0 <16.3.6` | 16.3.6 |
| Next `GHSA-4jqv-mc3x-m676`, `GHSA-39w2-rjm5-chcv`, `GHSA-f87g-xv8r-7p7x`, `GHSA-mcj8-r9mp-w47p`, `GHSA-cjq9-62q9-8jv4` | `>=16.0.0 <16.3.8` | 16.3.8 |
| Sharp `GHSA-rgj7-g3m4-5g8c` | `<0.35.4` | 0.35.4 |
| Sharp `GHSA-wq5f-xc86-pv6w` | `<0.35.5` | 0.35.5 |
| Nanoid `GHSA-2v37-7h3g-55p8` | `<3.3.18` | 3.3.18 |
| source-map-js `GHSA-68fv-2mgg-jv7q` | `>=1.0.0 <1.2.2` | 1.2.2 |

Maintainer references: [Next 16.3.8 security release](https://github.com/vercel/next.js/releases/tag/v16.3.8),
[Sharp 0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5),
[librsvg advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w).
Node 24.19.0 and React 19.2.4 satisfy the selected packages' published requirements.

## Compatibility changes

The matched ESLint configuration enables `react-hooks/set-state-in-effect`. Bake's selection fallback
now uses the existing component's guarded render-state pattern rather than setting state in an effect.
Browser verification found the initial asynchronous load lost an older/voided batch deep link. The
fallback now calls the existing `resolveBakeBatchId` and opens its existing older-version disclosure.
It preserves a valid selected batch and the voided warning; no Bake RPC, operation identity, inventory
deduction, cost calculation or database authority changes. Three recipe-select width classes prevent
the reproduced 320px overflow. Existing source-shape assertions are updated; real browser behavior
is checked independently. This is the only application compatibility change.

Next dev generated a new instruction banner in the isolated checkout. That incidental AGENTS.md
rewrite is excluded from the repair; project governance is preserved.

## Reproducible verification

Use the reviewed package.json and lockfile in a clean checkout. Linux x86_64,
`node:24.19.0-bookworm`, npm 11.17.0, separate Linux node_modules volume:

```sh
npm ci --include=optional --no-audit --no-fund
npm audit --omit=dev --json
npm ls next eslint-config-next sharp nanoid source-map-js --all
npm test
npm run typecheck
npx eslint . --ignore-pattern '.netlify/**' --ignore-pattern 'outputs/**'
RUN_POSTGRES_SMOKE=1 node --test --test-concurrency=1 tests/smoke/postgres/*.test.ts
npx --yes netlify-cli@27.10.2 build --context production
```

The database runner needs the Linux Docker CLI/socket and read-only Git history for two historical
schema tests. A Windows worktree's .git pointer is not valid inside Linux: mount the common Git
directory read-only and set `GIT_DIR` / `GIT_WORK_TREE=/app`. The initial full run passed 171 of
173 cases; two historical-schema cases failed solely on that path. Their corrected runner passes
4/4 tests, covering both failures. All 173 cases are verified; no database assertion was waived.

Guarded browser fixtures disable service workers, install `createGuardedContext`, and permit mutations
only on an explicit disposable loopback backend. Additional routing calls `fallback()`, preserving
the guard. No production credentials are provided to fixture servers or app servers. Media fixtures
use synthetic patterns and in-memory persistence; SQL/RLS behavior is independently covered by the
disposable PostgreSQL suite. The actual local Next app verifies owner authentication and unauthenticated
server routes. An intentionally invalid local project key makes MCP return its documented sanitized
configuration error; the integrated Finance app uses a syntactically valid disposable key to test 401.

Evidence directory: `outputs/security-finance-final-20261020/` (ignored local artifacts). Netlify
adapter **5.16.3** and CLI **27.10.2** are retained. The build does not upload. Before accepting it,
verify all static assets locally, all seven API routes, matching Next manifests, processed redirects
and headers, and the generated Linux function package. Packaged Sharp loads and decodes/transforms
PNG/JPEG/WebP/SVG: Sharp0.35.5, librsvg2.63.2, libvips8.18.7. No Windows native files may be packaged.
The [manual Netlify deployment lifecycle](NETLIFY_DEPLOYMENT.md) is unchanged.

## Remaining development-only findings

The broader `npm audit --json` still reports **9 high and 1 moderate affected packages**, all development
dependencies: MCP client; Next ESLint plugin/config, fast-glob, micromatch, braces; brace-expansion;
fast-uri; js-yaml; and postcss-selector-parser. The summary includes their dependency paths and advisories.
These are existing test/lint/build-tool paths, excluded from the production audit. MCP client appears
only in local tests, not application OAuth code. Build/lint inputs are trusted repository files.
No exploit was attempted or claimed.

The [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no patched release;
the latest compatible release remains 3.0.3. npm's suggested eslint-config-next14 downgrade would
break framework alignment and is rejected. Other development maintenance patches belong in separate
work. Independent review treats these residuals as documented tooling risk, not an unresolved runtime
Finance blocker; this report does not claim a clean full-development audit.

## Release control

Security code/QA approval permits opening a security-only PR. It does not authorize merge or deployment.
After that review, integrate the exact repair into the existing Finance candidate and complete its
full regression/guarded browser gates. Preserve the Finance expense migration byte-for-byte.
Production remains unchanged until separately approved release actions.
