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
