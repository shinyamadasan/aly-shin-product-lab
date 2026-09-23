# REVIEW

> Claude's review verdicts. Append-only. Never rubber-stamp.
>
> Each entry ends by stating which merge gate was chosen (`done` = reversible, auto-merges ·
> `approved` = red-zone, HELD for human merge) and why. See CLAUDE.md "Risk-gated merge".

## 2026-07-24 — Rule Engine implementation

**Scope:** new `src/lib/rule-engine/` module, `readiness.ts` refactor, `batches.ts` extraction,
`costing.ts` target-food-cost fix, `tsconfig.json` change, 43 new tests.

**Verdict:** Sound. The engine is genuinely pure (no I/O, verified by a determinism test), every
category module reuses existing calculation functions instead of duplicating them
(`getCostingTotals`, `getMatchingSupplies`, `diffFormulaRows`), and the `readiness.ts` delegation
preserves every existing call site's function signature — confirmed by grepping all ~12 call
sites in `product-lab.tsx` before changing anything, not assumed.

**Not rubber-stamped — one real behavior change flagged, not hidden:**
`getReadinessScore()`'s `passed`/`total` numbers (rendered as "X/Y gates passed" on Dashboard and
Products) will show larger, more granular counts than the previous fixed "/6" once this ships,
because the engine evaluates ~26 applicable rules instead of 6. The `percent` itself is now
severity-weighted rather than a flat pass count — an intentional, documented upgrade (see
`docs/ARCHITECTURE.md`), not a bug, but it is a visible change to a number the business owner
looks at.

Several rules (QUAL-001/002/003/005, FIN-003/004/007, PROD-004) are simplified relative to their
full `RULES/*.md` spec because the finer distinction they describe needs data that only exists
inside free-text/JSON-in-notes columns, not structured fields — each documented inline with
`passed: null` used honestly rather than a fabricated heuristic pretending to be precise.

**Merge gate: `done`.** No data, auth, or security surface touched; no Supabase schema change;
fully covered by 69 passing automated tests (lint + typecheck + `node --test`); reversible via
git. The one flagged behavior change (gate-count display) is cosmetic/numeric, not a data
integrity or access-control concern, so it doesn't meet the red-zone bar on its own — but it's
called out above so a human reviewing this entry isn't surprised by it after deploy.

## 2026-07-24 — Integrate the AI Advisor into Product Lab

**Scope:** new `src/services/ai/` module, `src/components/ai-advisor-panel.tsx`, new
`ai_reviews` table (proposed SQL, not applied), `rule-engine/index.ts` export widening,
`product-lab.tsx` wiring, 18 new tests.

**A real architectural blocker was found and surfaced before writing code, not worked around
silently.** This app has zero server-side execution boundary — every component under `src/app`
is `"use client"`, and Supabase is called directly from the browser with its public anon key. An
AI provider's API key is a real secret; wiring a live call the same way the rest of the app talks
to Supabase would have shipped that key into the browser bundle. I stopped, explained this, and
asked the user how to proceed (add a Route Handler vs. something else; which provider) rather
than picking a default and building it. The user's answer changed the scope entirely: no live
provider, no Route Handler, no API keys, no server-side AI at all — a Copy-Prompt architecture
instead, with the response pasted back in manually. Everything in this entry reflects that
descoped, explicitly-approved design, not the original task text's literal ask for a wired
provider.

**Verdict:** Sound within that descoped design. `generateAdvisorPrompt()` is genuinely pure and
synchronous — verified by a determinism test and a same-input-produces-`deepEqual`-output test —
and every number that reaches the prompt is sourced from an existing calculation
(`evaluateProduct`, `getCostingTotals`), never a second one; a test locates the engine's exact
`nextBestAction.message` and `margin` value verbatim inside the assembled prompt text as direct
proof, not an assumption.

**Not rubber-stamped — one real bug this review's own test suite caught before commit:**
`hasUnresolvedSupplyRisk` (the Launch Review specialist-routing check) originally treated
`passed: null` (insufficient purchase history, the normal state at this business's scale) the
same as an active failure, which would have pulled the Supply Chain Manager into nearly every
Launch Review regardless of whether a real problem existed — violating the Rule Engine's own
null-safety discipline one layer up. Caught by a routing test, fixed before this entry was
written, re-verified: 90/90 passing.

**A known, undocumented-enforcement data gap, flagged not hidden:** `specialists.ts` is a
condensed, prompt-sized re-transcription of `ai-review/specialists/*.md`'s scope and verdict
triggers — necessary because a prompt pasted into a separate AI chat has no filesystem access to
read the real files, but it means two representations of the same specialists now exist. Nothing
currently enforces they stay in sync; a future edit to a specialist's `.md` file could silently
drift from its `.ts` counterpart. Documented in `docs/ARCHITECTURE.md`, not solved here.

**Merge gate: `done`.** No existing table, column, or call site was changed — `ai_reviews` is a
new, additive table proposed as SQL that has not been run, and the app functions identically
before and after it exists (the same `isSuppliesTableMissing`-style graceful-degradation pattern
already trusted elsewhere in this codebase). No AI provider, API key, or network call exists
anywhere in this change, so there is no new external-service or credential-handling risk to
red-zone. Fully covered by 90 passing automated tests; reversible via git. The one open item
before this is genuinely useful is running `supabase-add-ai-reviews.sql` — Copy Prompt works
without it, but Save Review does not.

## 2026-07-24 — Supply Inventory Loop, Milestone 5: RPC atomicity

**Scope:** two new Postgres functions (`confirm_purchase_import`, `confirm_bake`) appended to
`supabase-add-inventory.sql`; `confirmPurchaseImport`/`confirmBake`'s Supabase-configured branch
in `src/app/product-lab.tsx` swapped from sequential `.update()`/`.insert()` calls to one
`supabase.rpc(...)` call each. This is the first `supabase.rpc()` usage anywhere in this codebase
(confirmed via grep before writing anything).

**Verdict: sound, and genuinely minimal.** `git diff` on `product-lab.tsx` touches only the
`if (supabase && session) { ... }` block inside each of the two functions — the guard checks, the
call into `applyPurchaseImportConfirmation`/`applyBakeConfirmation`, and the entire `localStorage`
branch are byte-for-byte identical to Milestone 4. The two pure confirmation functions were not
opened. The RPC functions do not reimplement matching, unit conversion, weighted-average cost, or
insufficient-stock logic in SQL — they receive the *already-computed* result as `jsonb` and apply
it as one atomic transaction, which is what closes the actual gap (a mid-sequence failure
previously leaving inventory partially updated) without creating a second place business rules
could drift out of sync with the first. Atomicity itself wasn't just asserted: verified directly
against the live database by forcing `confirm_bake` to fail mid-loop (a malformed `id` in the
second of two ingredient updates) and confirming the first, already-executed update did not
persist.

**Not rubber-stamped — one trust-model fact worth stating plainly, not a regression:** neither RPC
re-validates business rules server-side. `confirm_bake` does not re-check insufficient stock;
either function will faithfully apply whatever ingredient quantities and ledger rows it's given.
This sounds like a gap, but it isn't a new one — this app's RLS already grants any authenticated
user unrestricted `select/insert/update/delete` on every table involved (`using (true) / with
check (true)`, the same template used everywhere else in this codebase), so a client could always
have written arbitrary inventory values directly, with or without this milestone. The RPC's own
guard (`confirm_purchase_import` rejects confirming a non-`draft` import, re-checked server-side
via `select ... for update` even when called directly, not just from the app's own client-side
pre-check) is the one place this milestone *tightens* enforcement rather than merely relocating
it. If this app ever needs to defend against a malicious or compromised client rather than just a
racing/refreshing legitimate one, that requires a real authorization boundary (a service role +
Route Handler, the same gap the AI Advisor review above already surfaced for a different feature)
— out of scope here and not something Milestone 5 was asked to solve.

**Merge gate: `done`.** Both functions are `security invoker`, running under the calling user's
own RLS-governed identity — no privilege escalation, no new capability beyond what direct table
access already granted. No auth, provider key, or external-service surface touched. Purely
additive to the schema (two new functions; no table, column, or policy changed); reversible via
git. Fully covered by 278 passing automated tests (unchanged from Milestone 4 — no new pure-logic
surface exists to test) plus 16 localStorage-mode and 22 real-Supabase-mode browser/database
checks, including a direct, deliberate-failure proof of atomicity against the live project. All
temporary test data removed and confirmed gone after verification.

## 2026-08-05 — PR #18 post-merge audit + production infrastructure verification (PROP-018–026)

**Scope:** PR #18 (`feat/asset-generation-foundation` → `main`, merge commit `abeb391`) shipped
Marketing Advisor v1 (PROP-018–022) and Asset Generation Foundation through real-byte
materialization and a read-only Creative Package asset UI (PROP-023–026), plus an unrelated
prerequisite fix (database-clock terminal timestamps for Creative Jobs, commit `23457b5`). This
entry covers two things done after the fact, since the merge itself was already complete before
either review started: a post-merge scope-and-health audit of the merge commit, and — as that
audit's one identified follow-up — a read-only production verification of the Creative Job RPC
functions and asset infrastructure.

**The PR was not what it was meant to be, and nobody caught it before merging.** It was intended
to ship exactly PROP-026's two commits (the read-only asset UI and its unmount-race fix). It
actually merged 13 — five Marketing Advisor commits, the two PROP-023/024 asset-foundation
commits, PROP-025's byte-materialization work, a schema-recovery migration, and the creative-jobs
timestamp fix — none of which had been merged to `main` by any earlier PR. Root cause: the branch
was legitimately stacked on `feat/marketing-advisor-invocation`'s tip (PROP-023's own dependency
note says so, and that was a reasonable call at the time), but nobody ran a `main`-diff before
opening or merging the PR, so the entire unmerged lineage rode along silently.

**Verdict on the merge itself: sound, not a revert candidate.** Every one of the 13 commits traces
to an owner-approved milestone (or, for PROP-026, a directly-authorized handoff) — checked against
`planning/PROPOSALS.md`'s own Decision/Risk/status records for each. No commit is unfinished,
speculative, or scope-creeping beyond what its own proposal approved. Full re-verification on
`main` after the merge: `npm run typecheck` clean, `npm run build -- --webpack` succeeds (same 16
routes, no new route), `npm test` 1172/1173 passing (1 pre-existing unrelated skip), `git diff
--check` clean against the merge's first parent. Zero inventory/costing/baking files were touched.
No new npm package, no new Vercel-facing environment variable — the Marketing Advisor CLI reuses
the exact `ADVISOR_SUPABASE_*` credentials the already-shipped Daily Advisor CLI already required.

**Not rubber-stamped — one real, unresolved risk the audit found and this entry closes.** Nine new
SQL migrations landed in this merge. Eight had some form of documented live-verification evidence
(PROP-025's own smoke-test account, or PROP-023's design notes). One did not:
`supabase-add-creative-job-finish-functions.sql` (commit `23457b5`) replaces
`completeRunningCreativeJob`/`failRunningCreativeJob`'s direct `.update()` calls with
`rpc("finish_creative_job"/"finish_creative_job_attempt", ...)` **with no fallback path** — if
those functions didn't exist in production, every Creative Job completion or failure would start
erroring immediately post-deploy, silently breaking an already-live, daily-use feature. No
"Applied and verified live" record for this migration existed anywhere in `MARKETING_MODULE.md`,
`planning/PROPOSALS.md`, or this file. **Verified directly against production today, read-only
first as required — not assumed from the migration file or prior docs.** Signed in as the same
`authenticated`-role user every script in this repo already uses, then called both functions with
a nil UUID (`00000000-0000-0000-0000-000000000000`) that matches zero real rows: both returned
`200 []` — proof the functions exist and execute correctly, with zero side effects (nothing
matched, nothing changed). **No migration was reapplied**, per the explicit instruction to leave
an already-present migration alone. The four PROP-023 asset tables and PROP-025's
`complete_asset_job_with_files` RPC were checked the same way and are present and ready — the RPC
check is the strongest possible proof available: calling it with a nonexistent Asset Job id made
it raise its own internal `P0001` business-logic exception ("... was not found in running state"),
which only a function that actually exists and runs its real guard logic can produce.

**One check came back inconclusive, not negative, and is recorded as such rather than
overclaimed.** The `generated-assets` Storage bucket could not be confirmed present via two
independent authenticated-role checks (`getBucket`, `listBuckets` — both empty/not-found). Before
trusting that as "missing," I'd already caught a same-shaped false negative in this exact session:
PostgREST's OpenAPI descriptor endpoint returned zero paths for the same authenticated call,
turning out to require a service-role ("secret") key entirely unrelated to whether anything
actually exists. I do not have service-role access, and getting it isn't part of this task's
scope, so I can't fully rule out the same class of false negative for the Storage bucket check.
Logged in `STATUS.md`'s "Needs human verification" for the owner to confirm via the Supabase
dashboard directly — not release-impacting today either way, since 0 asset files exist in
production and nothing auto-triggers Storage writes.

**Process fix, not just a one-off note.** `WORKFLOW.md` now has a mandatory Pre-PR Scope Gate
(`git log --oneline origin/main..HEAD` + `git diff --stat origin/main...HEAD`, run before opening
*and* before merging any PR) — the exact check that would have caught this before it shipped.

**Merge gate: `approved`.** This touched five new Supabase migrations with a live production
project and a private Storage bucket — squarely the red-zone (data/schema/storage) category this
repo's own risk framework holds for human merge, which is in fact exactly what happened (the owner
merged PR #18 directly, not an autonomous auto-merge). Nothing found here changes that
after the fact — reversible via git if ever needed, but the right gate for this category of change
was, and remains, human review before merge, not `done`.

## 2026-09-09 — Selling Wave 0A raw authority

Self-review: scope remains Wave 0A; no generalized operation framework or later-wave domain
model. Removed browser balance writes, preserved historical rows, retained existing owner
authorization, and explicitly blocked unsafe legacy posting until Wave 0B.

Evidence: 397 relevant tests; PostgreSQL 17 isolated assertions and rolled-back target-database
assertions passed; typecheck and production build passed. Existing data hashes unchanged.
New/changed implementation lint is clean except the unchanged pre-existing Bake selection
effect error. No connected browser, so visual acceptance is unverified. No hosted frontend
deployment or merge performed. Merge gate remains `approved` for schema/permission work.
See [the complete evidence and restrictions](planning/SELLING_WAVE_0A.md).

## 2026-09-09 — Selling Wave 0A independent approval and finalization

Gate: `approved`. The user confirmed the independent verdict: **WAVE 0A APPROVED — safe to
commit and proceed to operational reconciliation.** The reversal-boundary, migration-identity,
and visible-lockout repairs are included. All local/remote migration versions match; the final
CLI dry run reports the remote database up to date. Final diff review found no unrelated changes
or Wave 0B implementation. Verification: 403 focused tests, isolated/live PostgreSQL authority
assertions, typecheck, production build, and targeted repair lint passed as recorded in the report.
Commit and branch push are authorized. Physical inventory reconciliation must happen before
Wave 0B; Wave 0B is NOT STARTED. Hosted and real-device acceptance are not claimed.

## 2026-09-12 — Product Lab MCP Slice 1 implementation self-review

**Scope:** one local stdio server shared by Codex and Claude Code, with exactly two read-only tools:
`inventory_list` and `ingredient_inspect`. The implementation extracts V1A's authentication and
read-state loading into a shared Product Lab service while leaving the existing Inventory Operator
CLI as a separate guarded developer/debug workflow. Project-local client configuration and an
operator handoff are included; no schema, browser UI, deployment, or production operation is in
scope.

**Verdict:** ready for independent review. Tool discovery exposes exactly the requested two tools,
both adapters delegate to the shared application service, and structured outputs are bounded to
500 inventory rows plus five recent purchase and five recent movement records per inspection.
The existing conservative matcher remains authoritative: an ambiguous name such as `Biscoff`
selects nothing, and suggestions, inactive aliases, and unknown names disclose no ingredient
evidence. Authoritative nullable average cost remains nullable. Purchase evidence includes entered
and normalized quantities, unit cost, and source/import linkage where Product Lab stores it.

**Security and parity evidence:** the common auth boundary rejects secret/service-role keys before
network access, validates the bearer token with `auth.getUser`, and requires the owner app role.
The MCP imports no write service and exposes no generic SQL or RPC surface. Transport tests cover
valid, expired/invalid, non-owner, and privileged-key cases. In a separate manual rehearsal, real
Codex and Claude Code processes discovered and invoked the same server against a controlled loopback Product Lab fixture
and returned the same canonical ingredient and quantity. That rehearsal touched no production
system. Repository verification passed: focused and V1A regression tests, typecheck, scoped lint,
production build, `npm audit` (0 vulnerabilities), and `git diff --check`.

**Operational caveat:** project-local MCP configuration is intentionally inert until the checkout
is trusted in Codex or approved in Claude Code, and the clients must inherit the three Product Lab
environment variables. The owner access token is short-lived and must not be persisted. A first
controlled production read remains an explicit owner/reviewer step; no production read or write was
performed here.

**Merge gate: `approved`.** This adds an authenticated path to live business data even though it is
strictly read-only. Hold for independent human review and merge authorization. No commit, push, PR,
merge, or deployment was performed.

## 2026-09-13 — Product Lab MCP Slice 1 independent-review fixes

**Input verdict:** `APPROVED WITH FIXES`. Architecture and the unreachable-write boundary were
accepted; the reviewer requested four targeted corrections only. No redesign or Slice 2 work was
performed.

**Finding 1 — resolved:** MCP operations no longer call the CLI-oriented full-state loader.
`inventory_list` issues one ingredient-only query selecting exactly its response columns, requests
an exact count, orders by name then id, and applies a server-side limit of 500.
`ingredient_inspect` paginates minimal ingredient-name and alias rows in 1000-row pages, returns
without querying evidence on every non-match/unsafe match, then filters detail, purchase, movement,
and direct source-link reads to the selected ingredient. Purchase and movement reads each apply a
server-side limit of five. The optional purchase-history relaxation in V1A can only create an
unsafe suggestion, never a safe match, so MCP does not globally read supply history merely to
enrich that hint; the existing CLI retains the full V1A matching path unchanged.

**Finding 2 — resolved:** the automated parity case is now named protocol-client parity and claims
only what it runs: two independent MCP SDK clients receiving equivalent structured results. The
earlier real Codex/Claude check is documented separately as a manual controlled loopback rehearsal.

**Finding 3 — resolved:** movement notes were removed from the service result and MCP schema.
Backend/auth/internal messages are mapped to stable public `configuration_error`,
`authentication_error`, or `read_failed` responses. Stderr receives only a safe internal category;
tests prove raw backend detail, access tokens, and project keys cross neither channel.

**Finding 4 — resolved:** the operator guide now distinguishes a CLI launched from prepared
PowerShell from an already-running IDE/desktop host, and tells the operator to obtain a fresh token,
update the launching environment, and restart the MCP process/client/host after expiry. No token
persistence or refresh machinery was added.

**Evidence:** 72/72 focused MCP/read-query/V1A regression tests passed. Full `npm test` passed
3656/3657 with 0 failures and 1 pre-existing skip. Typecheck and changed-file lint are clean;
production build generated all 22 pages; `npm audit` reports 0 vulnerabilities; `git diff --check`
is clean. PostgreSQL/Docker smoke suites are outside `npm test` and were not run because this change
adds no schema or database-write behavior. No production read or write was performed.

**Merge gate: `approved`.** The four requested fixes are complete and the branch is ready for
targeted re-review. Authenticated business-data access remains human-merge territory. No commit,
push, PR, merge, or deployment was performed.

## 2026-09-13 — Product Lab MCP Slice 1 targeted re-review approval

**Verdict: `APPROVED`.** The independent targeted re-review confirms all four findings are resolved,
no P0/P1 blocker remains, and Slice 1 may proceed to commit and PR after normal checks. Architecture
and scope remain locked; no redesign or Slice 2 work is authorized.

**Accepted non-blocking P2 notes:** the legacy CLI's `inventory:list` output does not expose
`total`/`truncated` metadata when the shared server-bounded list exceeds 500 rows. MCP inspection
also omits the CLI's optional supply-history enrichment for unsafe suggestions so it never performs
a global supply read. Exact, alias, normalized, and ambiguity decisions remain shared; suggestions
remain non-authoritative in both paths.

**Merge gate: `approved`.** Commit and PR are authorized. Merge still requires normal PR checks and
explicit human authorization. No production read/write, deployment, or Slice 2 work is authorized.

## 2026-09-13 — Product Lab MCP Slice 2 implementation self-review

**Scope:** expose the existing Inventory Operator V1A physical-count preview/apply/verify workflow
through the shared Product Lab MCP. The MCP surface is exactly the two Slice 1 reads plus three
physical-count tools. No new inventory rule, database migration, RPC, generic write surface, other
mutation category, provider-specific server, or production operation is included.

**Architecture and code-health verdict:** would ship for independent review. The orchestration that
previously lived in `scripts/inventory-operator/run.ts` is extracted once into
`scripts/product-lab/inventory-count-service.ts`; CLI and MCP both call it. V1A core still owns
matching, unit conversion, deterministic preview/hash/operation identity, approval binding, and RPC
arguments. The existing `public.apply_inventory_physical_count_batch` remains the sole mutation and
continues to delegate business semantics to the private raw inventory authority. The same shared
verifier reads exact ingredient/ledger state back and is the only path that reports `verified`.

**Approval and security verdict:** Apply's schema contains only `preview_id` and `approval_code`.
It creates a fresh authenticated client before loading/applying the artifact, so preview-time auth
is never reused. Tests reject expired and non-owner tokens, secret/service-role keys, wrong/missing
approval, extra payload fields, missing/tampered previews, stale state, and verification mismatch.
Public MCP failures are stable and sanitized; stderr contains only an internal category. Codex has
a per-tool `prompt` override and Claude has an explicit project `ask` rule. Both server instructions
and the Claude workflow require a new owner message containing the exact approval code between
Preview and Apply.

**Verification:** 40/40 focused MCP/Slice 1/V1A tests passed. Full `npm test` passed 3657/3658
(0 failures, 1 pre-existing skip). Typecheck and changed-file lint passed. The production build
compiled and generated all 22 pages. `npm audit` reports 0 vulnerabilities. Codex accepted the
tool-specific approval configuration and the Claude settings JSON parsed successfully.
`git diff --check` passed. PostgreSQL smoke was unavailable: `psql` is absent and Docker Desktop's
Linux engine is not running. No test was silently counted as a database pass.

**Production boundary:** no Product Lab credentials were used; production reads and writes are both
zero. No migration, deployment, commit, push, PR, or merge was performed.

**Merge gate: `approved`.** This intentionally exposes one live mutation category, even though it
is narrow, owner-authenticated, preview-bound, client-approved, stale-guarded, atomic, idempotent,
and verified. Hold for independent code/security review and explicit human merge authorization.

## 2026-09-13 — Product Lab MCP Slice 2 independent-review fixes

**Input verdict:** `BLOCKED` with one P1 and two P2 findings. The architecture and mutation scope
were accepted. This pass changes only the Codex approval proof/configuration, authoritative verify
output, test claims, and their documentation.

**Finding 1 — resolved:** the owner explicitly trusted the Product Lab repository. Installed Codex
0.147.0 reported no managed configuration requirements. Project config now declares the human
`user` approvals reviewer, enables all five Product Lab tools, and gives
`inventory_count_apply` a per-tool `prompt`. A real installed-client acceptance against a loopback
fixture returned Preview `pc_1730a493c05f6769fb67` and approval code `1730-A493`, stopped for a new
owner message, then displayed a human tool prompt containing the exact preview and code. Fixture
instrumentation proved zero mutations before tool approval. After the owner's separate approval,
exactly one reconciliation event executed and authoritative Verify returned `verified` with zero
failures. Static tests claim only the declarations. CLI overrides outrank project config, so
`--approve-for-me` and `approvals_reviewer = "auto_review"` overrides are forbidden for Apply.

**Finding 2 — resolved:** Verify now returns each reconciliation row's `cost_reconciled_at` from
the authoritative ingredient read-back. The regression tampers the stored local Apply artifact to
contain a false 1999 timestamp and proves Verify still returns the authoritative `null` value.

**Finding 3 — resolved:** the flow test now claims only approval-code and payload boundaries. The
static client-config test says the Codex and Claude files *declare* their approval settings; it does
not claim that parsing those files proves effective client behavior. Runtime behavior is recorded
separately from the installed-client acceptance above.

**Validation:** focused MCP/Slice 1/V1A tests passed 40/40. Full `npm test` passed 3657/3658 with
zero failures and one pre-existing skip. Typecheck, changed-file lint, and the production build are
clean; the build generated all 22 static pages. The current registry `npm audit` reports six
dependency advisories (five high, one critical). No dependency change was made because the reviewer
limited this repair to Findings 1–3; the audit result remains visible rather than being counted as
a pass. PostgreSQL smoke remains unavailable because `psql` is absent and Docker Desktop's Linux
engine is not running. No database smoke is claimed.

**Production boundary:** the acceptance used only a loopback fixture and fake credentials. No
production read/write, migration, deployment, commit, push, PR, or merge was performed.

**Merge gate:** the three requested findings are resolved and ready for targeted re-review. The
dependency audit remains a separate repository-level blocker for release handling.

## 2026-09-14 — Product Lab Netlify Migration Slice 1: platform-neutral origin policy + Node pin

**Scope:** `scripts/product-lab-mcp/origin-policy.ts` (Host/Origin allowlist logic), 17 tests in
`tests/product-lab-mcp-origin-policy.test.ts` (rewritten to cover local/production-like/Netlify/
Vercel-regression matrix), `.nvmrc` (new) + `package.json` `engines.node` (Node version pin). No
change to `src/app/api/mcp/route.ts`, auth, OAuth, or any Supabase-facing code.

**Verdict:** Sound. The prior implementation gated localhost trust on `!env.VERCEL` — correct only
by accident, since that condition is also true for every *other* platform's production deployment.
The fix gates on `NODE_ENV !== "production"` instead, a signal Next.js itself sets identically
regardless of host (verified against Next's own deploying-to-platforms doc and Vercel's own
Functions runtime behavior, not assumed), so no non-Vercel production environment can inherit
localhost trust the way the bug allowed. Netlify's build-time `URL` var is parsed down to a bare
hostname before being trusted (Vercel's equivalent vars are already bare; Netlify's is a full URL
and would never have matched a real Host header otherwise) and is documented as best-effort, not
load-bearing, because Netlify does not guarantee build-scoped vars reach a Function at request time
(confirmed by fetching Netlify's own current docs, not assumed) — `PRODUCT_LAB_MCP_PUBLIC_HOSTNAME`
remains the mechanism an operator should actually rely on. All 17 origin-policy tests pass, full
suite 3702/3703 (1 pre-existing skip, 0 fail), typecheck/lint/build clean, `npm audit` unchanged at
the known 6 pre-existing advisories.

**Not rubber-stamped:** the existing Vercel-regression test fixtures (`{ VERCEL: "1" }` alone) were
themselves only ever realistic under the old buggy gate — a real Vercel deployment always sets
`NODE_ENV=production` alongside `VERCEL=1`. Those fixtures were corrected to include both, which is
a fixture fix, not a behavior relaxation: a bare `VERCEL=1` with no `NODE_ENV` is not a shape any
real Vercel deployment produces, so no live Vercel environment loses protection from this change.

**Production boundary:** no Supabase configuration, DNS, OAuth registration, migration, or
production inventory mutation was touched. No deployment cutover; Vercel remains canonical.

**Merge gate: `approved`** — red-zone, held for human merge. This changes production Host/Origin
access-control logic for an authenticated MCP endpoint; the task that produced this change
explicitly stops short of merging (PR only) pending independent review and a real Netlify trial
deployment.

## 2026-09-18 — Operations Dashboard V1 + navigation calm-down

**Scope:** `/` becomes the Dashboard, Today moves to `/today`; grouped navigation
(`lab-state.ts`, `app-shell.tsx`); old product-proof Dashboard replaced by `dashboard-page.tsx` plus
`src/lib/dashboard/*`; `route-redirects.ts`/`next.config.ts`; 41 new tests, 5 existing tests
updated to the new contract. No schema, migration, auth or Supabase-facing change.

**Verdict:** Sound, with the judgement calls below stated rather than buried.
- Every number reuses its owner: `buildSellingSummary`, `deriveFinishedStockBalances`,
  `getPreparationByProduct`, the inventory-status helpers. A structural test forbids the dashboard
  from importing the revenue/pieces/fulfilment modules.
- Finished-stock demand counts `new` orders only. Checked against the Wave 2 migration, not assumed:
  reservation happens at `new -> confirmed`, so confirmed/ready are already inside `reserved`. A
  replayed-ledger test proves it, and a mutation (adding confirmed/ready to demand) makes it fail.
- A failed Orders read is contained; "You're caught up" is never claimed over unread orders.

**Not rubber-stamped:**
- "Sales" was relabelled "Paid today / Paid last 7 days": the canonical figure is cash received
  (`paidAt`), which is not sales booked. Deviates from the brief's preferred wording on purpose.
- Profit NOT built. `order_raw_cogs` is ingredient-only, fulfilled-only, and period-mismatched to
  revenue. Follow-up spec: `planning/DASHBOARD_PROFIT_V1.md`. Recent activity and repeat-customer
  rate also deferred (no honest source / no customer-origin field).
- The brief's More list omitted Product Detail, and its Operations list added Bake (which was not in
  the nav). Product Detail is kept under More so no page loses its link; Bake is added.
- Sign out previously lived only on the old Dashboard; moved into the shell so it is not lost.
- Lint: `eslint` flags `src/components/bake-page.tsx:89` (`react-hooks/set-state-in-effect`).
  Pre-existing on `origin/main` (file untouched; reproduced on a pristine checkout). Not fixed here.
  Bare `npm run lint` also walks `.worktrees/`, which is not this repo's code.
- Header badges (Stage: Pre-launch / Model / Focus) still say pre-launch. Not in scope; flagged.

**Human-only checks not done:** Dashboard against real owner data (sits behind login), and a real
phone. Layout was checked with fixtures at 1440px and a true 390px viewport in headless Edge.

**Merge gate: `done`.** Presentational and routing change with no data/auth/security surface,
reversible via git. Old `/?job=` bookmarks and `/dashboard` are covered by redirects.

## 2026-09-19 — Operations Dashboard V1 pre-merge corrections

**Scope:** `ProductLab`'s `view` prop is now required (default `"today"` removed); global AppShell
chrome updated (sidebar sentence, header badges Stage/Model/Focus). Closes two items the 2026-09-18
entry listed as open. No dashboard scope added; no data, schema or route change.

**Verdict:** Sound. All 18 `<ProductLab>` callsites already passed `view`, so removing the default
changes no behaviour. Proven both ways rather than assumed: deleting `view` from a route fails
`tsc` (TS2741) and fails the new route-scan test. Header badges now read Selling / Home-based
preorder / Bakery operations; layout and grouping untouched.

**Not rubber-stamped:** "Stage: Selling" is a wording judgement supplied by the owner, not derived
from data. The pre-existing `bake-page.tsx:89` lint error is unchanged (file not modified;
reproduced on pristine `origin/main` in the prior pass).

**Merge gate: `done`.** Type/copy change only, reversible via git.

## 2026-09-19 — Operational friction cleanup V1 (Inventory + Bake)

**Scope:** `src/app/product-lab.tsx` (`InventoryWorkspace`'s primary-nav rendering only),
`src/components/inventory-stock-page.tsx` (rewritten), `src/components/inventory-page.tsx`,
`src/components/bake-page.tsx`, `src/components/raw-inventory-reconciliation.tsx` (one `id`
attribute), `src/lib/inventory-cost.ts`, `src/lib/inventory-status.ts`, `docs/FEATURES.md`, plus
27 new tests across `tests/inventory-cost.test.ts`, `tests/inventory-status.test.ts`, and
`tests/raw-inventory-ui.test.ts`. Explicitly NOT touched: `src/lib/inventory-tabs.ts` (the tab/
query-param contract itself), any Supabase migration, `confirm_bake_v3`/`certify_ingredient_cost_
baseline`, Orders, Daily Log. Pre-PR scope gate run against `origin/main` (157fec4): diff is
exactly these 11 files, nothing else.

**Verdict:** Sound. Information-hierarchy pass, not an architecture or backend change --
proven, not assumed: `inventory-tabs.test.ts` (tab key order + the "Items" label) and
`route-redirects.test.ts` (every old bookmark) both pass unmodified, because `inventory-tabs.ts`
itself was never edited; the primary nav's 3-pill list is a `.filter().map()` derived from that
same array (tested against the real import, not a hand-copied duplicate), so it cannot drift out
of sync with the tab contract. Cost-certification duplication (3 independently-drifting inline
copies of the same "uncertified" condition, across the Stock table, Ingredient Master, and two
places in Bake) was consolidated into one `isCostBaselineUncertified()` helper reused everywhere;
`confirm_bake_v3`'s own server-side guard, `cost_reconciled_at`, and `certify_ingredient_cost_
baseline` are byte-for-byte untouched. `readyToConfirm`'s guard conditions (insufficient stock,
uncertified cost, actual-pieces validity, full resolution) are unchanged text, just verified by a
new AST-level test rather than only by inspection. Full suite 3841/3842 (1 pre-existing skip, 0
fail, up from the 3817/3818 baseline), typecheck clean, build clean. Lint (`npx eslint src`,
scoped to avoid the pre-existing `.worktrees/` slowdown noted in the 2026-09-18 entry) shows
exactly the same single pre-existing `bake-page.tsx` `react-hooks/set-state-in-effect` error,
reproduced against a pristine `origin/main` checkout before this work started -- not introduced,
not fixed.

**Not rubber-stamped:**
- Need to Buy's richer view (suggested-buy quantity) was deliberately NOT ported into the new
  Stock filter -- the boring Stock table only ever shows Item/On hand/Status per the brief's own
  mockup. The old `?tab=need-to-buy` bookmark still renders the original, unmodified `NeedToBuyPage`
  (with the suggested quantity) verbatim; it's just no longer a primary nav pill. This is a
  narrower interpretation of "reachable via Stock/filter" than "identical richness inline" --
  flagged rather than assumed to be what was wanted.
- "Count / correct stock" opens `RawInventoryReconciliation` via a plain `getElementById` +
  `.open`/`.scrollIntoView` call, not lifted React state -- matches this file's own existing
  pattern (`LowStockThresholdField`'s ref-based native-event dispatch) rather than introducing a
  new one, but it is still an imperative DOM reach-through, not idiomatic React.
- The Bake mapping-table disclosure is labeled "View ingredient mapping (N)", not the brief's
  literal mockup text "View recipe deductions" -- that exact phrase was reused for two different
  toggles in the brief's own mockup (mapping table in one section, quantity deductions in another),
  which would have made two adjacent, differently-scoped disclosures carry an identical label.
  Deviated on purpose; flagging rather than silently picking one.
- Batch-amount quick presets (0.5x/1x/2x) were added per the brief's optional suggestion; no
  separate "Custom" button exists since the existing numeric field already is the custom control.
- A mid-task line-ending bug was caught and fixed before commit: two `src/lib` files and their
  test files picked up CRLF line endings from an edit-tool pass (root cause not fully diagnosed --
  it did not reproduce on every file edited the same way); normalized back to LF and reverified
  (typecheck/tests) before either commit, so neither commit's diff carries the whole-file noise
  that would have caused.

**Human-only checks not done:** No browser-automation tool (Playwright/Puppeteer) is available in
this environment, so the 1440px/390px responsive check required by the brief was NOT performed
against a real rendered page -- only verified statically (Tailwind breakpoint classes follow this
codebase's own existing responsive conventions; `next build` succeeds with no layout-affecting
compile errors). This is a real gap, not a formality -- flagged per this repo's own honesty rule
rather than claimed as done. A real owner-data / real-device pass is also outstanding, same as the
2026-09-18 entry's own unresolved item.

**Production boundary:** No Supabase schema, migration, RPC, or production data was touched or
written to. No deploy, no merge -- both commits sit on `feat/ops-friction-cleanup-v1` only, per
the task's explicit instruction to stop before either.

**Merge gate: `approved`** -- held for human merge. Not because the change is architecturally
risky (it's presentational/information-hierarchy only, and every backend safeguard is verifiably
unchanged), but because the task explicitly requires a stop-before-merge checkpoint and the
1440px/390px visual check is still a human-only outstanding item.

## 2026-09-19 — Operational friction cleanup V1: Purchases + Manage Items

**Scope:** `src/lib/purchase-item-resolution.ts` (new, pure), `src/components/purchase-item-field.tsx`
(new), `src/lib/unit-conversion.ts` (`inferCanonicalUnit`, shared with `guessCanonicalUnit`),
`src/app/product-lab.tsx` (`saveSupply`/`ensureItemForNewPurchase`, `PurchaseLogPage`, removal of
the per-row Buy plumbing), `src/components/inventory-page.tsx` (Manage Items), `docs/FEATURES.md`,
and tests (`purchase-item-resolution.test.ts` new; `raw-inventory-ui.test.ts` extended). Explicitly
NOT touched: any migration, `post_raw_purchase`, `confirm_bake_v3`, cost-certification RPCs, CSV
import (`PurchaseImportWizard`), Bake, Orders, Daily Log.

**Verdict:** Sound, with the judgement calls below stated. The Item is resolved or created at
Save time, never while typing: the form renders from one pure planner (`planPurchaseItem`) and
`saveSupply` re-runs the same resolution against the current catalog before writing, so a stale form
cannot create a duplicate. Item creation reuses `saveIngredient` (no new write path); the purchase
still posts through `post_raw_purchase` with the unchanged operation id. Proven by behavior, not only
by string checks: the real `ensureItemForNewPurchase` source is executed with stubbed collaborators
for the create / near-match / archived / ambiguous / bad-base-unit / retry cases, including "Item
created, purchase failed, retry twice" creating the Item exactly once. Full suite 3894 pass, 0 fail,
1 pre-existing skip; typecheck and build clean.

**Not rubber-stamped:**
- The near-match rule is a judgement call, deliberately conservative and documented on
  `arePossibleNameMatch`: same words reordered, a trailing s/es, or edit distance 1 (shorter name >= 5
  chars) / 2 (>= 12 chars). It will sometimes ask when two names really are different products
  ("Salted butter" vs "Unsalted butter" at distance 2); that is what "Create anyway" is for. Tune with
  real data before trusting the thresholds.
- A retry after a failed purchase is protected by an in-memory ref (`itemsCreatedForPurchaseRef`) plus
  the exact-match resolution once the reloaded catalog arrives. If the Item is hard-deleted in that
  window the retry fails at the database (truthfully reported) rather than recreating it. It does NOT
  survive a page refresh -- but after a refresh the Item exists in the catalog, so the exact match
  reuses it. Two steps remain two writes; no migration was added to make them atomic.
- Similar-but-archived candidates are shown as information only ("Restore it in Manage Items"); only an
  EXACT archived match offers "Restore and use", to avoid a second restore/select code path.
- Manage Items dropped the always-visible purchase summary, value and per-row action buttons; they
  are behind Manage, not deleted. Search reuses `matchesStockSearch` (name substring) rather than a
  new matcher.
- A shell-backtick slip briefly emptied three identifiers in the Manage Items FEATURES.md row; caught
  by reading the committed diff and corrected in the following docs commit.

**Human-only checks not done:** no real browser/phone pass at 390px or 1440px (no browser automation
here); the smart Ingredient field, datalist suggestions, and Manage expansion were verified through
structure and behavior tests only. A real owner-data run of "Item created but purchase failed" is also
outstanding.

**Production boundary:** no Supabase schema, migration, RPC, or production data was touched or
written. No merge, no deploy; commits sit on `feat/ops-friction-cleanup-v1` only.

**Merge gate: `approved`** — held for human merge and a real-device pass; presentational/orchestration
change with every backend safeguard unchanged.

## 2026-09-19 — Operational friction cleanup V1: final consolidated visual correction

**Scope:** `src/lib/quantity-display.ts`, `inventory-display.ts`, `bake-batch-option.ts` (new, pure);
small additions to `inventory-cost.ts` (`getStockValueDisplay`), `purchase-history.ts`
(purchase search), `inventory-tabs.ts` (`resolveInventoryFocus`); UI in `inventory-stock-page.tsx`,
`inventory-page.tsx`, `bake-page.tsx`, `product-lab.tsx` (Purchases history rows only) and
`inventory/page.tsx`. Not touched: any migration, `post_raw_purchase`, `confirm_bake_v3`,
cost-certification RPCs, purchase delete/edit rules, Orders, Daily Log, package-lock.json.

**Verdict:** Sound; display and navigation only. Every changed quantity is formatted at render time
from the same numbers as before -- the deduction payload, insufficient-stock math and
`readyToConfirm` are unchanged and re-asserted by tests. The Sea Salt case (4.7 g rendering as
"0.00 kg") is covered by formatter tests, including a "never displays a non-zero value as zero"
sweep. The purchase total shown is the stored `totalCost`, never re-multiplied from a rounded unit
price. Stock value is only presented for a verified cost; otherwise "Verify cost first", with the
recorded cost shown separately as unverified Cost basis. Full suite 3929 pass, 0 fail, 1
pre-existing skip; typecheck and build clean.

**Not rubber-stamped:**
- `formatQuantity` switches g->kg / ml->L at 1000, so Stock now reads "3.862 kg" where it used to
  read "3862 g", and a Bake row can mix units (current in kg, uses in g). Readable, but a judgement
  call worth eyeballing against real quantities.
- Cost-focused mode state was lifted into the workspace so `?focus=costs` can start it and it
  survives tab switches; it lifts itself when no Items still need verification.
- The By Item search also matches a purchase's brand/supplier, so an Item stays visible when only
  one of its older purchases matches.
- Removing the per-row Log Purchase leaves the blank-draft path in `supplyEditorKey` unused by any
  caller; left in place rather than opportunistically refactored.

**Human-only checks not done:** no real browser or 390px/1440px pass (no browser automation here);
the new layouts are verified structurally and by behavior tests only.

**Production boundary:** no schema, migration, RPC or data touched. No merge, no deploy.

**Merge gate: `approved`** -- held for human merge and a real-device pass.

## 2026-09-19 — Inventory cost verification: UX simplification + timeout handling

**Scope:** `src/lib/cost-verification.ts` (new, pure), `src/components/inventory-page.tsx`
(CertifyCostForm rewrite, row cost-mode action, "Verify cost" wording), `src/app/product-lab.tsx`
(certify handler now delegates to `runCostCertification`; `loadSupabaseData` returns a boolean),
tests `cost-verification.test.ts` (new) and `raw-inventory-ui.test.ts` (wording + focused-list
updates), `docs/FEATURES.md`. Not touched: any migration, `certify_ingredient_cost_baseline`,
`confirm_bake_v3`, purchase posting, weighted-average costing, Orders, Bake, CHANGELOG.md.

**Verdict:** Sound. The owner's failed verification ("upstream request timeout") was a gateway 504 on
the RPC request itself -- the message prefix exists only on the RPC error branch, and postgrest-js
turns a non-JSON body into a code-less error. The RPC body is O(1) (two indexed statements, no
firing triggers) and ran in ~190 ms including every rejection path in the disposable-Postgres smoke
run, so the stall was before/around it (connection wait or a row lock), not in its logic; exact stage
is not provable without server logs. A timeout cannot be assumed uncommitted, so it is now an
uncertain outcome resolved by a read-back; the RPC is never retried (a replay is also rejected by
the RPC's own stale-expected-value check, so no duplicate audit row either way). A post-commit reload
failure could not previously flip the result to "failed"; it is now explicit (`refreshed`).

**Not rubber-stamped:**
- The generated evidence note is prefixed `Latest purchase:` (the brief's example had no prefix) so
  an auto-generated note is distinguishable from a typed one in the audit trail.
- "Verify this cost" accepts the latest purchase as the baseline; it is not a reconstructed
  weighted average, and the panel says so.
- Unit cost is computed in the Item's base unit (a kg purchase of a gram Item converts); the
  pre-existing row "Latest purchase" line still shows cost per purchase unit.
- Cost-focused mode now keeps an Item listed after it is verified (until the mode is left) so its
  inline result stays visible.
- Which stage inside the RPC stalled in production is inferred, not observed.

**Human-only checks not done:** no real browser / phone pass; the panel is verified by typecheck,
build, and behavior/source tests only -- `ship-pending-human-review` for layout and feel.

**Production boundary:** no production write, certification, migration, or deploy. Postgres
evidence came from the disposable Docker smoke harness only.

**Merge gate: `approved`** -- held for human merge and a real-device pass.

## 2026-09-19 — Bake: current-recipe picker simplification

**Scope:** `src/lib/bake-batch-option.ts` (pure `buildBakeBatchChoices`, `resolveBakeBatchId`,
`isOlderBakeBatch`), `src/components/bake-page.tsx` (selector only), `tests/bake-batch-picker.test.ts`
(new), one assertion in `raw-inventory-ui.test.ts`, `docs/FEATURES.md`. Not touched: formula
parsing, deductions, cost-verification guard, `confirmBake` / `confirm_bake_v3`, operation-id logic,
any migration or data, Inventory, Orders, CHANGELOG.md.

**Verdict:** Sound; selection/presentation only. "Current" is the first batch under Bake's
pre-existing per-product order, so nothing new is stored. Partition tests prove each batch of a
listed product appears exactly once across current + older. Downstream Bake lines are re-asserted
unchanged by source scans (operation key, `confirmBake` args, `readyToConfirm`).

**Not rubber-stamped:**
- A batch whose product is not in `products` was never in the picker and still is not (still
  reachable via `?batch=`, as before).
- Missing `dateMade` sorts last; ties keep loaded order -- same as the old inline sort.
- The pre-existing lint error (`react-hooks/set-state-in-effect` on the disappeared-batch fallback
  effect) is unchanged and untouched.
- An old assertion banning `<optgroup>` in Bake was narrowed: only the older-version disclosure uses it.

**Human-only checks not done:** no browser/phone pass -- `ship-pending-human-review` for the
disclosure's look and the primary select's "Older version selected below" placeholder on mobile.

**Production boundary:** no schema, migration, RPC or data touched. No merge, no deploy.

**Merge gate: `approved`** -- held for human merge and a real-device pass.

## 2026-09-21 — Cost verification: manual fallback takes purchase facts, not unit-cost math

**Scope:** `src/lib/cost-verification.ts` (pure `calculateManualCostBasis`, `buildManualCostEvidence`,
`manualCostUnitOptions`), `src/components/inventory-page.tsx` (CertifyCostForm's manual form only),
`tests/cost-verification.test.ts`, `docs/FEATURES.md`. Not touched: the latest-purchase one-click
path, `certify_ingredient_cost_baseline` and its args, `runCostCertification` / timeout read-back,
Bake's verified-cost guard, purchase posting, any migration or schema, Orders, CHANGELOG.md.

**Verdict:** Sound. The operator enters total paid + quantity + unit; the cost is total / quantity
converted to the ingredient's base unit via the existing `convertToBaseUnit` (no second conversion
table), kept at full precision, and the evidence note is generated
(`Manual cost basis: PHP 220.00 / 1 kg = PHP 0.22/g`). The same form serves both "no usable purchase"
and "Enter a different cost manually". The RPC still receives the same six args.

**Not rubber-stamped:**
- The unit is a picker limited to units that convert to the base unit, so an incompatible unit cannot
  be chosen in the UI; the helper still rejects incompatible/unknown units (tested) as defence in depth.
- Zero/negative/non-finite paid or quantity, an underflowing quantity and an overflowing cost are all
  rejected; free or unknown-cost stock is deliberately NOT accepted (separate policy decision).
- Three older UI assertions encoded the removed manual form (evidence textbox, typed PHP/unit field,
  "no Verify this cost in the fallback") and were rewritten to the new contract, not deleted.
- The evidence display rounds to 4 decimals (the stored cost does not), so a cost below PHP 0.00005
  per unit would display as PHP 0.00 in the note; the certified value is still exact.

**Human-only checks not done:** no browser/phone pass -- `ship-pending-human-review` for the compact
layout on mobile (paid / quantity + unit / calculated cost / button).

**Production boundary:** no schema, migration, RPC or data touched; no certification performed.
No merge, no deploy.

**Merge gate: `approved`** -- held for human merge and a real-device pass.

## 2026-09-21 — Ops polish V2 (consolidated wave)

**Scope:** manual-cost feedback + timeout wording (`inventory-page.tsx` CertifyCostForm, `cost-verification.ts`);
Orders stock refresh (`orders-page.tsx`, `orders/transitions.ts`, one prop in `product-lab.tsx`); Bake
voided-current (`bake-batch-option.ts`, `batch-safety.ts` `isVoidedBatch`, `bake-page.tsx`); Purchases new-Item
unit pre-check, category and copy (`purchase-item-resolution.ts`, `purchase-item-field.tsx`, `ensureItemForNewPurchase`
and PurchaseLogPage in `product-lab.tsx`, `inventory-stock-page.tsx` empty copy); tests; `docs/FEATURES.md`. Not
touched: `certify_ingredient_cost_baseline`, `confirm_bake_v3`, the order-lifecycle RPCs and `updateOrderStatus`,
`post_raw_purchase`, `saveIngredient`, any migration or schema, public ordering, CHANGELOG.md.

**Verdict:** Sound. Each part is client-side presentation or ordering; every write still goes through the same database
authority.

**Not rubber-stamped:**
- Orders refresh reuses the parent's `loadSupabaseData` (no second finished-stock query). It runs only after a
  DB-accepted Confirm / Complete / release; `orderStatusChangeMovesStock` is tied by a parity test to the transitions the
  repository routes through an RPC. A refused change reloads no stock. Known limit: if another tab moved an order and this
  screen still shows the old status, a Cancel decided from the stale status may skip the stock reload; the orders list
  still reloads, and the database is unaffected.
- The stock reload is awaited inside the action's busy state, so buttons stay disabled for the length of one full reload.
- Bake: a voided newest batch no longer displaces a valid recipe; a voided deep link is still honored, labeled Voided and
  flagged, but `readyToConfirm` is deliberately NOT changed (presentation only) -- the database refuses it, as before.
- New-Item purchases: unit and category are checked before `saveIngredient`. Only the unit conversion is pre-checked; a
  zero quantity or price would still fail after creation (pre-existing, unchanged).
- Copy: only the purchase field label, purchase report column and empty stock state changed. The count-correction panel
  still says "ingredient" throughout (out of the purchase flow).
- Lint: the pre-existing `react-hooks/set-state-in-effect` in Bake's fallback effect is unchanged and untouched.

**Human-only checks not done:** no browser/phone pass -- `ship-pending-human-review` for the manual-cost form, the Bake
"no current recipe" / voided notices, and the Purchase form's category row.

**Production boundary:** no schema, migration, RPC, data or production write. No merge, no deploy.

**Merge gate: `approved`** -- held for the independent review pass and a real-device check.

## 2026-09-21 — Cost verification + Inventory polish V3

**Scope:** `src/lib/cost-verification.ts` (purchase-fact formatters, request deadline, attempt tracker, uncertain
timeout outcome), `src/components/inventory-page.tsx` (CertifyCostForm layout + Saving/Checking phase, row copy),
`src/app/product-lab.tsx` (`certifyIngredientCostBaseline`: tracker gate, abort signals, background reload, Item-named
messages), tests `cost-verification.test.ts` (extended) and `raw-inventory-ui.test.ts` (one assertion narrowed),
`docs/FEATURES.md`. Not touched: any migration, `certify_ingredient_cost_baseline`, `confirm_bake_v3`, Orders, Bake,
purchase posting, costing, CHANGELOG.md.

**Verdict:** Sound for UX and client reliability; the production timeout's exact stage is inferred, not observed.
- Root cause (inferred): the RPC body is not slow. Disposable Postgres at 1.2M ledger rows (200k on one Item): latest-row
  lookup 0.3 ms via `inventory_transactions_ingredient_idx`, RPC ~6-8 ms end to end, no trigger fires (the only
  `ingredients` triggers are `before update of base_unit` / `of name`). A row-lock wait returned a CODED `57014` at the 8 s
  statement timeout, whereas production returned an uncoded gateway "upstream request timeout" -- so the stall was most
  likely upstream of SQL execution (connection/pool/gateway), not lock wait or a scan. No server logs were reachable, so this
  is not proven; the RPC also worked in production before (Dari Creme Butter Milk, 2026-09-12). No SQL change is justified.
- Client contributors that ARE real and fixed: the button was held for the full-page reload (21 unbounded selects incl. the
  whole ledger) after a successful save; no request had a deadline; closing and reopening a panel discarded the lock.
- Behaviour change to check: a timeout whose read-back shows no saved change is now UNCERTAIN and locked (was a
  re-submittable failure), because a slow request can still commit. The owner must reload to unlock -- intended.

**Not rubber-stamped:**
- A 15 s deadline can classify a merely-slow request as uncertain; it is resolved by the read-back and never retried, so the
  worst case is one extra reload, not a duplicate audit row.
- The tracker's uncertain state lasts until a page reload (a ref, not persisted). A reload clears it, matching the message.
- `CertifyCostResult.verified.refreshed` is now always true from the handler (refresh failure is reported at page level);
  the panel's `refreshed` branch is dead-but-harmless and was left rather than widening the change.
- One pre-existing assertion (default row shows no "Latest purchase") was narrowed to "not outside the cost-focused branch".

**Human-only checks not done:** no browser/phone pass -- `ship-pending-human-review` for the new panel layout, the
Saving -> Checking result labels under a throttled connection, and the compact row copy.

**Production boundary:** no production write, data mutation, migration, certification, merge or deploy. Read-only
production facts came from the `product-lab` MCP (`ingredient_inspect`, `inventory_list`); measurements ran in a
throwaway local Docker Postgres.

**Merge gate: `approved`** -- held for the single post-wave review and a real-device check.

## 2026-09-22 — Selling Format save trust (read-back verification + honest draft copy)

**Scope:** `src/lib/selling-formats.ts` (`verifySellingFormatsReadback`, `verifySellingFormatPackagingLinesReadback` --
pure comparison, 0.005 numeric tolerance), `src/app/product-lab.tsx` (`addSellingFormat`/`removeSellingFormat` copy +
tone; `saveCosting`'s normal remote save path gets a targeted read-back before the success message), new test file
`tests/selling-format-save-trust.test.ts` (22 tests). Not touched: the duplicate-new-version RPC save path
(`create_batch_with_costing`), any migration, any Supabase write beyond what already existed, `loadSupabaseData`'s own
shape, the dirty-state snapshot architecture (`costing-form-snapshot.ts`).

**Root cause:** "Add selling format" only pushed a row into local React state (`formatRows`) and told the operator
"Selling format added." in green success styling -- indistinguishable from an actual save. The remote save path had
the mirror problem the other direction: it upserted `selling_formats` / `selling_format_packaging_lines` and
immediately said "Costing updated."/"Costing saved." without ever reading back what Supabase actually persisted, so a
silent partial write (e.g. an RLS policy or trigger quietly dropping/altering a row) would still show as success.

**Verdict:** Sound and narrowly scoped.
- `addSellingFormat`/`removeSellingFormat` now use `info` (amber) tone, not `good` (green), with copy that says the
  row is only "in this draft" and names the exact button ("Update costing") that persists it.
- The normal save path, after every selling-format/packaging-line write and delete already in that function
  succeeds, re-reads `selling_formats` scoped by `.eq("costing_id", costingSummaryId)` and, only if any formats were
  submitted, `selling_format_packaging_lines` scoped by `.in("selling_format_id", submittedFormatIds)` -- never the
  broad `loadSupabaseData()` full-table load as the verification authority. `verifySellingFormatsReadback` /
  `verifySellingFormatPackagingLinesReadback` compare the submitted rows against what came back (id, every field,
  numeric tolerance for float round-tripping) and return a description of the first mismatch, or `null`.
- On a read-back error or mismatch: `setMessageTone("bad")`, a message containing the required exact sentence
  ("Costing was written, but the selling format did not match when read back from the database. The editor was left
  open; review the format and save again."), and a `return` with **no** `setEditingCosting(null)` -- the editor stays
  open, and no branch issues a second `.upsert(`/`.insert(` call (asserted directly in the new test file's
  "never a blind second write" test, which slices exactly that code block and greps it).
- Only after every check passes does the success message change to "Costing updated and verified." / "Costing saved
  and verified.".
- The read-back is skipped entirely when `isSellingFormatsTableMissing` is true, matching every other
  `selling_formats` access in this function -- legacy/local configs never see a readback attempt against a table that
  doesn't exist.
- Existing dirty-state architecture (`formatRows`/`packagingLineRows` diffed by `costing-form-snapshot.ts`) was not
  touched; both local actions still call `setFormatRows`/`setPackagingLineRows`, so the unsaved-changes guard still
  fires exactly as before.

**Not rubber-stamped:**
- The mismatch/error messages append a parenthetical detail (e.g. `(...)` with the specific field or Supabase error)
  after the required exact sentence, for operator/debugging value -- verified by a test that the exact sentence is
  present as a substring, not that the message is only that sentence.
- A brand-new (not-yet-saved) costing's save button reads "Save costing", not "Update costing" -- the draft-added-row
  copy's "Click Update costing below" wording was specified verbatim by the task as the preferred copy and is used
  as given, even though it's only literally accurate once a costing already has an id.
- The duplicate-new-version save path (`create_batch_with_costing` RPC) was deliberately left alone per the task's
  scope -- it still reports "New version and costing saved." without a read-back.

**Production boundary:** no Supabase write beyond what this save path already performed before this change (the new
code only adds `.select()` reads); no migration; no Cookies-product data created or touched; verified against
production only by reading the task's supplied evidence (`costing_id 8e3be560-...`, batch `c2ca3b64-...`), never by
querying production directly. No merge, no deploy.

**Merge gate: `approved`** -- held for human review before merge to `main` per the task's explicit instruction not
to merge or deploy.

## 2026-09-23 — Selling Format save trust: fix completeness gap found by independent review (BLOCK)

**Scope:** Same two files as 2026-09-22 above, `src/lib/selling-formats.ts` and `src/app/product-lab.tsx`, plus
`tests/selling-format-save-trust.test.ts` (22 -> 32 tests). Nothing else touched: same boundary as the prior entry
(no migration, no duplicate-new-version RPC path, no inventory/orders/Cookies data, no production write).

**Root cause (the blocker):** An independent review of the 2026-09-22 fix reproduced a real gap:
`verifySellingFormatsReadback`/`verifySellingFormatPackagingLinesReadback` only checked that every *submitted* row
round-tripped correctly (a subset check), never that every *persisted* row was one of the submitted ones (the other
half of set equality). Concretely, `verifySellingFormatsReadback([], [staleFormat])` returned `null` -- "verified" --
even though a stale row was still in the database. This is reachable in production: `selling_formats` DELETE calls
in the write path (`.delete().in("id", removedFormatIds)`) do not error on Supabase/PostgREST when they silently
match zero rows (RLS exclusion, a stale client-cached id list from a concurrent edit, etc.), and the read-back that
exists specifically to catch a silent partial write could not catch a silent partial *delete*.

**Repair:**
- Both `verifySellingFormatsReadback` and `verifySellingFormatPackagingLinesReadback` now also check the reverse
  direction: after the existing per-submitted-row loop, build a `Set` of submitted ids and look for any persisted row
  whose id isn't in it. Any such row returns a `"... is still in the database even though it should have been
  removed."` mismatch. `null` is now returned only when the submitted and persisted id sets are exactly equal, not
  merely when submitted is a subset of persisted.
- `saveCosting`'s packaging-line read-back query is now scoped to `[...submittedFormatIds, ...removedFormatIds]`
  (`relevantFormatIdsForLineReadback`), not just `submittedFormatIds` -- so when every format for a costing is
  removed (`submittedFormatIds.length === 0`), the packaging-line read-back no longer skips entirely; it verifies
  that the removed formats' lines are actually gone too, rather than trusting `ON DELETE CASCADE` as unverified proof.
- No change to the write path itself (still one upsert + one scoped delete per table, no blind retry), no change to
  the numeric tolerance, no change to which fields are compared, no change to the success/failure message wiring
  (still exactly one `"...verified."` success message, still `setMessageTone("bad")` + editor-stays-open + no second
  write on any mismatch).

**New behavioral coverage (not source-regex):** exact-set-of-many passes; empty-submitted/empty-persisted passes;
empty-submitted-with-a-stale-persisted-row fails (the reproduced case); a reduced submitted set with one leftover
removed row fails; the same four shapes for packaging lines; a "bounded save-flow" test that calls the real
`verifySellingFormatsReadback`/`verifySellingFormatPackagingLinesReadback` in the same sequential order `saveCosting`
does and asserts the all-formats-removed-with-a-stale-row case cannot reach `{ verified: true }`. The one previously
passing test whose expectation the new completeness rule intentionally overturns (an unrelated-costing's persisted
row was tolerated before; is now reported as stale, on the reasoning that the real caller already scopes its query
to this costing's id, so an extra row here means that scoping broke and should fail loud) was updated in place, not
deleted, with its rationale documented alongside it.

**Not rubber-stamped / accepted trade-off:** the new completeness check does not distinguish "a delete silently
no-op'd" from "someone else concurrently added a format to this same costing between this operator's load and this
save" -- both now report as a mismatch. Given this app's single/small-operator usage pattern and that the task
explicitly asked for strict, unconditional set equality (not a concurrency-aware exception), this is treated as the
correct fail-loud trade-off: a rare false-positive "please reopen and check" is preferable to a false "verified" that
was the actual bug.

**Production boundary:** identical to the 2026-09-22 entry -- no new Supabase write, no migration, no production
access, no merge/push/deploy.

**Merge gate: `approved`** -- held for human review before merge to `main`, per the same explicit instruction as the
prior entry.
