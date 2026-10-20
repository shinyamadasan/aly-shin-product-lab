# STATUS

## 2026-10-20 -- Refund source-control closeout verified

PR #106 is merged (`0489e3b`). The independent recovery/deployment closeout review passes with no
remaining findings: repaired guard and RLS checks 20/20; real local Playwright interception passes;
disposable recovery Postgres 19/19. Production is unchanged at Netlify `6ad77d3799debf1d75d48671`.
Read-only production checks confirm both recovery migration versions recorded, all three recovered
orders Paid/no refund, 3 correction records and 1 incident record. No migration/recovery was rerun.
Validated Netlify configuration/procedure is included; Git integration/build hooks/GitHub deployment
automation are absent. The legacy Vercel CLI session was revoked with supported `vercel logout`;
the server reported success and the legacy access/refresh credential file was removed.

Finance remains separately held for integration and verification, with no production migration/deploy
authorized. Original uncommitted work is preserved at `safety/finance-pre-integration-20261020`
(`d86b0a3`), and the original working tree is unchanged. Real-device rendering remains human verification.

## 2026-10-19 -- Refund hotfix prepared locally (hotfix/refund-correction, off origin/main 27bc899)

Owner-only audited `correct_mistaken_refund` (migration `20261019120000_order_refund_correction.sql`), the
Orders-page "Correct mistaken refund" action, and a confirmation on the normal Refund button. Targets the one
mistaken refund in production (order 60b69833, PHP 200). Independent of Financial Release 1. **Not pushed, not
merged, migration NOT applied, nothing deployed.** Evidence: unit 4,466 pass (1 pre-existing skip), Postgres smoke
154/154, browser 35/35, tsc/build/eslint clean, independent review with no HIGH/MEDIUM findings. Runbook:
`docs/REFUND_CORRECTION_RUNBOOK.md`. Needs the owner: authorize the migration, the order
correction, the push/merge and the deploy. See D-010 and `REVIEW.md` 2026-10-19.

## 2026-10-14 — Content Studio Unification V1 local candidate

Implemented on isolated `feat/content-studio-unification-v1`, directly from accepted Fast Mode
`e544c36495ba84dbe1cbdb9f61ce21630e05b9fa`. One assisted/manual entry, one shared real-media
production component, safe product/format handoff and explicit PHP caption-price warnings.
CreateNow keeps its default asset presentation (FIX_FIRST: the `ritual` variant was removed from
CreateNow; Today's own recommendation surface still uses it). A pending/stuck assisted job offers
**Build with my photos** without touching the job. Today shares the same CreateNow surface (intended).
No push, deployment, migration, Supabase modification or production data write.

Verified: focused 151/151; full 4448 total / 4447 passed / 0 failed / 1 existing platform skip;
typecheck, lint of all changed code/test files and standard Turbopack production build PASS.
Browser acceptance PASS: manual without a job and after planning failure; assisted carousel/reel
prefills with blank offer/media/attestation; unsupported photo/story; no invented product; five-item
shortage; original submission/copy; PHP warnings before generation/export; authenticity reset;
actual carousel/Reel preview and byte-identical exports; widths 320/375/390/1280. Fixture Supabase
adapters and synthetic patterns only; no live owner session or real owner media used.

FIX_FIRST patch (after independent review of `7fb9a9d`): focused 151/151 + Today 26/26; full 4448 /
4447 / 0 / 1 skip; typecheck, lint, build PASS; browser smoke PASS incl. stuck-job manual escape.

Self-review and QA passed. Merge gate `approved`: ready for independent review, held locally.
Next action: independently review this candidate. STOP; do not push main or deploy.
Needs human verification (`ship-pending-human-review`): iOS Safari/Android Chrome, phone tap/scroll
feel, transition smoothness, spacing/polish, microcopy and workflow intuition with real owner media.


> Where the project is right now. The first thing any agent reads.

## 2026-10-13 — Content Studio Media Library V1 candidate

Implemented and locally verified on isolated `feat/content-studio-media-library-v1`, based on
`origin/main` at `30881f291855fc5a827b785423e7cca09673c20f`. No production schema application,
deploy, merge or real owner media upload. `product_media` preserves raw source authority while
reusing generated-media validation and private signing. Review gate: `approved`; see
`planning/CONTENT_STUDIO_MEDIA_LIBRARY_V1.md` and the append-only REVIEW entry.

Verified: focused 97/97; full 4407 passed / 1 pre-existing platform skip / 0 failed; local PostgreSQL
migration, owner RLS and four-fixture persistence; browser upload, photo previews, H.264 playback,
reload, Product/Unassigned/filter/selection; responsive widths 320/375/390/1280; lint/typecheck/build.
Browser uses local fixture adapters; PostgreSQL uses auth/storage schema stubs. Target Supabase
verification remains after separately authorized migration application. Recovery retains private
bytes on uncertain registration; orphan cleanup, delete, usage tracking and MOV/HEVC are deferred.

Needs human verification (`ship-pending-human-review`): real iOS Safari/Android Chrome rendering,
phone tap/scroll feel, transitions, spacing/polish, microcopy and workflow intuition. Next action:
review this candidate; separately authorize migration/target-environment checks before owner uploads.

**Milestone:** Marketing Advisor v1 (PROP-018–022) and Asset Generation Foundation through
real-byte materialization and read-only UI (PROP-023–026) both shipped and merged to `main` via
PR #18 (`feat/asset-generation-foundation`, merge commit `abeb391`, 2026-08-05). A post-merge
audit and production-infrastructure verification followed the same day — see the two entries
below and `REVIEW.md`. PROP-027 (External Creative Workspace as the first real Asset Job executor)
is **implemented and fully verified on `feat/prop-027`** (commits `5354ddd`..`f5d4976`,
2026-08-05) but **not yet merged to `main`** — see "Last shipped" below,
`MARKETING_MODULE.md`'s implementation record, and `planning/PROPOSALS.md`'s PROP-027 entry.
**Active task:** Product Lab MCP Slice 2 reviewer fixes are implemented locally on
`feat/product-lab-mcp-slice-2-inventory-count`, pending targeted re-review. The shared MCP still
implements the existing V1A physical-count preview/apply/verify workflow. Claude retains guarded
Apply. After the owner trusted the repository, real installed Codex 0.147.0 acceptance proved that
its human reviewer and per-tool prompt prevent Apply until separate owner and tool approvals.
No migration, production operation, commit, push, PR, merge, or deployment has been performed.
PROP-028 remains **not started** and is not authorized by this work.
**Owner:** —
**Blockers:** targeted re-review and human merge authorization remain. PostgreSQL smoke could not
run because no local PostgreSQL or running Docker engine is available. The current registry audit
reports six dependency advisories (five high, one critical); dependency upgrades are outside this
strict Findings 1–3 repair. PROP-027's separate Storage-bucket and
physical-phone checks also remain under "Needs human verification" below.

## Last shipped

- **2026-09-13 — Product Lab MCP Slice 2 reviewer fixes implemented locally, not committed:**
  verification now reports `cost_reconciled_at` from authoritative ingredient read-back and a
  regression proves a tampered local apply artifact cannot falsify it. Unit/static test names now
  claim only approval-code/payload and configuration-declaration coverage. Installed Codex 0.147.0
  inspection found no managed requirements. After the owner trusted the repository, a real
  loopback acceptance showed Preview, a new exact-code owner message, a human Apply tool prompt,
  zero execution before tool approval, exactly one reconciliation event after approval, and a
  successful authoritative Verify. Codex Apply is enabled with a human `user` reviewer and per-tool
  `prompt`; Claude Apply remains under `permissions.ask`.
  The MCP server surface, V1A rules, RPC, schema, transactionality, and database are unchanged.
  Validation: focused MCP/Slice 1/V1A tests 40/40; full suite 3657/3658 with zero failures and one
  pre-existing skip; typecheck, changed-file lint, 22-page production build, and `git diff --check`
  passed. The current `npm audit` reports six dependency advisories (five high, one critical);
  dependency changes are outside the reviewer's strict Findings 1–3 scope. Ready for targeted
  re-review.
- **2026-09-13 — Product Lab MCP Slice 2 implemented locally, not committed:** the shared MCP now
  exposes V1A's batch-native `inventory_count_preview`, `inventory_count_apply`, and
  `inventory_count_verify` beside the two Slice 1 read tools. CLI and MCP use one extracted
  application service; matching, normalization, hashing, approval binding, the existing atomic
  RPC, mutation receipts, stale guards, cost-certification rules, and read-back verification remain
  authoritative. Apply accepts only preview ID plus approval code, revalidates owner auth, and has
  a Claude `ask` client rule; the reviewer fix adds Codex's human reviewer. Focused tests passed 40/40; full suite
  passed 3657/3658 with one pre-existing skip; typecheck, changed-file lint, 22-page production
  build, zero-vulnerability npm audit, and `git diff --check` passed. PostgreSQL smoke was
  unavailable because Docker Desktop's engine is stopped and `psql` is absent. No database change,
  production read/write, commit, push, PR, merge, or deployment occurred. Ready for independent
  review.
- **2026-09-13 — Product Lab MCP Slice 1 targeted re-review approved:** all four requested findings
  are resolved and no P0/P1 blocker remains. Two accepted P2 notes remain: the legacy CLI list does
  not expose MCP truncation metadata, and MCP intentionally omits the CLI's optional global
  purchase-history suggestion enrichment. Neither affects safe match selection or the read-only
  boundary. Commit and PR are authorized; merge remains human-authorized. No production change was
  performed.
- **2026-09-13 — Product Lab MCP Slice 1 independent-review fixes complete, not merged:** replaced
  MCP's coarse full-state reads with operation-specific Supabase queries. Inventory listing now
  selects only returned ingredient columns with exact count, deterministic ordering, and a
  server-side 500 limit. Inspection paginates minimal ingredient/alias matching state, returns
  before evidence reads on unsafe/unmatched input, and filters both evidence queries to the safely
  selected ingredient with server-side limits of five. Movement notes are omitted; public tool
  errors are stable and sanitized; IDE/desktop environment inheritance and token-restart behavior
  are documented; automated parity is correctly named protocol-client parity. Verified: 72/72
  focused/V1A tests, full suite 3656/3657 (0 failures, 1 pre-existing skip), typecheck, changed-file
  lint, production build, `npm audit` with 0 vulnerabilities, and `git diff --check`. No production
  read/write or release operation was performed. Ready for targeted re-review.
- **2026-09-12 — Product Lab MCP Slice 1 implemented locally, not merged:** one shared local stdio
  server now exposes exactly `inventory_list` and `ingredient_inspect` to Codex and Claude Code.
  Both tools reuse V1A authentication, matching, unit conversion, and Product Lab reads; reject
  privileged project keys; require a validated owner token; return bounded structured facts; and
  expose no write or generic database surface. Automated service/transport/auth/protocol-client
  parity coverage,
  typecheck, scoped lint, production build, and a controlled loopback rehearsal through both real
  clients passed. No production read, production write, deployment, commit, push, PR, or merge was
  performed. The branch is ready for independent review; see `docs/PRODUCT_LAB_MCP.md` and
  `REVIEW.md`.
- **2026-08-05 — PROP-027, External Creative Workspace as the first real Asset Job executor**
  (branch `feat/prop-027`, commits `5354ddd`..`f5d4976`, not yet merged to `main`): fills the Asset
  Job pipeline's existing executor slot with a human working in any external creative workspace
  (ChatGPT, Claude, Midjourney, Canva) or a real camera, rather than integrating a paid
  image-generation API — a CTO-level review rejected the API-first assumption before any code was
  written, since it served none of the stated business goals and would have failed against this
  app's own 1080×1080 spec size on the first real call. Ships: Asset Job creation and canonical
  brief view/copy in the browser; workspace + AI/photograph/human-designed capture; browser
  upload with validate-before-claim; a matching desktop CLI (`export`/`import`); advisory (not
  hard) dimension checking so real camera photos and ChatGPT's 1024×1024 output both succeed; and
  provenance (`sourceWorkspace`/`sourceKind`) stored separately from `provider`/`model`, which stay
  reserved and untouched for a genuine future API executor. **Zero new SQL migration, RPC, table,
  or column** — every provenance fact rides inside the already-atomic
  `complete_asset_job_with_files` call. Full record: `MARKETING_MODULE.md`'s "PROP-027
  implementation record" and `planning/PROPOSALS.md`'s PROP-027 entry. Verified: `npm run
  typecheck` clean, scoped `eslint` clean on all 27 new/touched files, `npm test` 1227/1228 (1
  pre-existing unrelated skip, up from 1172 — 55 new tests), `npm run build -- --webpack` succeeds
  with no new route, `git diff --check` clean. **Not yet done:** the `generated-assets` Storage
  bucket's existence was never conclusively confirmed (see "Needs human verification" below) and
  the spec's own real acceptance gate — the full flow completed on a physical phone — has not been
  attempted.
- **2026-08-05 — Production infrastructure verification (post-PR #18 follow-up):** read-only
  verification against the real production Supabase project (not assumed from local migration
  files or docs) confirmed `finish_creative_job` and `finish_creative_job_attempt` (added by
  `supabase-add-creative-job-finish-functions.sql`, commit `23457b5`) **already exist and work**
  — proven via zero-side-effect RPC calls with a nil UUID that matched no real row, returning
  `200 []` for both rather than a "function not found" error. No migration was reapplied. Also
  confirmed present and ready: the four PROP-023 asset tables (`asset_jobs`,
  `asset_job_attempts`, `assets`, `asset_files` — all respond `200` with `0` rows, matching
  PROP-025's documented post-smoke-test cleanup state) and PROP-025's
  `complete_asset_job_with_files` RPC (proven live by the function raising its own internal
  "Asset Job ... was not found in running state" business-logic exception, the strongest
  available proof of existence). The `generated-assets` Storage bucket's existence could **not**
  be conclusively confirmed via authenticated-role API access (two independent checks both came
  back empty/not-found, but this project's Storage bucket metadata may simply not be visible to a
  non-service-role JWT — the same category of false negative caught and debugged earlier in the
  same session against the PostgREST OpenAPI endpoint). Not release-impacting either way: 0 asset
  files exist in production today, and asset materialization is CLI/manual-only, never
  auto-triggered. See `REVIEW.md`'s 2026-08-05 entry for the full account.
- **2026-08-05 — PR #18 post-merge scope & health audit:** merge commit `abeb391` (13 commits,
  not the intended 2 — see Process finding below) fully re-verified on `main`: `npm run
  typecheck` clean, `npm run build -- --webpack` succeeds (same 16 routes), `npm test`
  1172/1173 passing (1 pre-existing unrelated skip), `git diff --check` clean. No
  inventory/costing/baking file was touched by the merge. Recommendation: leave the merge intact
  — see `REVIEW.md`.
- **2026-08-05 — PR #18 merged to `main`:** ships PROP-018 through PROP-026 —
  Marketing Advisor v1 (Context Builder → Deterministic Recommendation Engine → Brief/Opportunity
  Draft Generator → manual export/import invocation → Queue-for-review persistence; all
  read-only/CLI-manual, no packages installed, no Vercel-facing env change) and Asset Generation
  Foundation (schema + mock executor proof → real byte materialization via private Storage → a
  read-only Creative Package asset UI on `/opportunities`, plus the unmount/stale-request race fix
  reviewed and merged as its own commit). Full milestone-by-milestone record: `MARKETING_MODULE.md`
  and `planning/PROPOSALS.md` (PROP-018 through PROP-025 entries; PROP-026 was authorized directly,
  not logged there — a documentation gap, not a scope problem). **Process finding:** the branch was
  stacked on another unmerged feature branch's tip, and nobody diffed it against `main` before
  opening the PR, so all of that unmerged lineage rode along with the two PROP-026 commits actually
  intended. `WORKFLOW.md` now has a mandatory Pre-PR Scope Gate to catch this before it happens
  again.
- **2026-07-25 — audit fixes** (branch `audit/improvement-proposals`): guarded `localStorage`
  parse against a corrupt-value white-screen (PROP-001); fixed 2 test type errors + added an
  `npm run typecheck` gate (PROP-002); replaced fragile substring "table missing" detection with
  Postgres/PostgREST error codes (PROP-003); pinned `sharp`/`postcss` via npm `overrides` →
  `npm audit` 0 vulnerabilities, down from 3 high (PROP-004); made `today` a live `getToday()`
  (PROP-007). Verified: typecheck ✓, tests ✓, lint ✓, build ✓, audit ✓.
- **2026-07-24 — Supply Inventory Loop Milestone 5** — see `CHANGELOG.md`/`TEST_REPORT.md`/
  `REVIEW.md`/`planning/DONE.md`. Pure infrastructure: replaced the sequential `.update()`/
  `.insert()` Supabase writes in `confirmPurchaseImport`/`confirmBake` with two atomic Postgres RPC
  functions (`confirm_purchase_import`, `confirm_bake`, `supabase-add-inventory.sql`). No business
  logic, UI behavior, or calculation changed. `localStorage` mode untouched. Verified end to end in
  both localStorage mode (16/16 checks) and the live Supabase project (22/22 checks, including a
  deliberate-failure atomicity/rollback proof).
- Also shipped that milestone cycle: Milestone 4 (2026-07-24) — expiration-status badge on the
  Inventory page, 3 new Dashboard cards; plus a refactor centralizing `inventory_transactions`
  construction into `src/lib/inventory-transaction.ts`.

## Needs human verification

- **Operations Dashboard V1 (`feat/ops-dashboard-v1`, not merged):** open `/` signed in as owner and
  confirm the numbers against `/orders` and `/bake`; check the sidebar/More disclosure on a real phone;
  confirm an old `/?job=<id>` link lands on `/today` with the job open. Not verifiable headlessly (login).
  Pre-existing, unrelated: `bake-page.tsx:89` fails `react-hooks/set-state-in-effect` lint on `main`.

- **Product Lab MCP Slice 2:** perform targeted re-review of the Codex human-review configuration,
  real installed-client acceptance evidence, authoritative `cost_reconciled_at` read-back, and
  corrected test claims. Do not perform a live physical count or production write during review.
- **Confirm the `generated-assets` Storage bucket via the Supabase dashboard directly** (or a
  service-role check) — agent tooling could not conclusively confirm it either way through
  authenticated-role API access on 2026-08-05 (see above). PROP-027's own frozen spec named this a
  hard blocker to check *before* implementation began; it was not resolved during that milestone
  either, so it is now carried forward as a blocker for the step after code: the first real browser
  or CLI upload will fail at the Storage step if the bucket does not exist. Still no user-facing
  impact today (0 asset files exist in production), but this should be confirmed **before**
  attempting the PROP-027 mobile acceptance test below, not after.
- **Run the PROP-027 mobile acceptance test**: the full create → view/copy brief → external
  workspace → upload → visible-Asset flow, completed on a physical phone in a mobile browser. This
  is the frozen spec's own stated real acceptance gate (not `npm test`) and has not been attempted
  by any agent — it requires a physical device. Depends on the Storage bucket check above.
- **Low-priority follow-up, not urgent:** `planning/PROPOSALS.md` reuses `PROP-018` through
  `PROP-024` for two unrelated proposals each (an older pending product-lab item and a
  since-implemented marketing-advisor/asset item share the same number). Flagged during the PR #18
  audit; renumbering was explicitly out of scope for that audit and this follow-up — record only,
  do not renumber without separate authorization.
- Branch `audit/improvement-proposals` is pushed and now merged up to date with `origin/main` — review
  the diff and merge to `main` when ready.
- Still open for a decision: PROP-005 (first UI/integration tests) and PROP-006 (phased break-up of
  the `product-lab.tsx` monolith).
- Supply Inventory Loop Milestone 5: nothing outstanding — both localStorage and real-Supabase modes
  fully verified against actual database state.

## 2026-09-09 — Selling Wave 0A stop point

Implementation and target database authority tests complete on
`feat/selling-wave-0a-raw-authority`. Existing 31 ingredient balances and 43 ledger rows are
unchanged. Verified physical counts are still operator work. Hosted frontend deployment and
interactive visual acceptance were not performed; no browser was connected. Do not run old
frontend protected-write flows or restore old grants. Wave 0B is not authorized or started.
Details: [SELLING_WAVE_0A.md](planning/SELLING_WAVE_0A.md).

## 2026-09-09 — Selling Wave 0A approved for finalization

Independent reviewer approved Wave 0A; user authorized committing the complete frontend,
migrations, tests, and documentation together and pushing `feat/selling-wave-0a-raw-authority`.
Final migration status matches remote with no pending SQL. Physical inventory reconciliation
must happen before Wave 0B. Wave 0B: **NOT STARTED**. Needs human verification: hosted frontend
availability and real-device interaction/visual acceptance; this finalization does not claim deployment.

## 2026-10-20 -- Refund hotfix Netlify asset repair released

Production `https://app.alyandpon.com` now publishes verified deploy `6ad77d3799debf1d75d48671`, exact
hotfix source `91811efbdb8f6630d971ed378e16bdc1d4f2747a`. Fixed the upload process: the failing draft
uploaded repository-root files instead of adapter-prepared static assets. Isolated Linux build plus
explicit `.next` publish configuration runs Netlify's adapter lifecycle correctly. No application code,
Financial Release 1 change, migration, production environment setting or business record changed.

Verification: 36/36 static files return 200 and match build hashes; draft read-only browser 32/32,
disposable-data Refund/Cancel 35/35, production non-mutating smoke 32/32; desktop/390/320 px pass.
No forbidden write request attempted; all test contexts block production data and preview-function
mutations. Linux server routes/native dependencies packaged. Disposable QA processes stopped with
fixture data retained. PR #106 remains OPEN and mergeable. Rollback: `6ad0e1855136bc0b75fe73bf`.

Details: `docs/NETLIFY_REFUND_ASSET_REPAIR_2026-10-20.md`; incident recovery records remain intact.
Needs human verification: real-device iOS Safari/Android Chrome appearance and touch feel.
