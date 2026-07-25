# Daily AI Advisor — Investigation & Proposed Architecture

**Status: implemented.** This document is the original investigation and design; the reasoning in
§1 (prior-art investigation), §5 (ranking-tier design), §6 (security model), and §8 (fallback
behavior table) was spot-checked against the shipped code and substantially held — those sections
are not marked stale below. The concrete architecture in §2, the file list in §3, the diagram in
§4, the scheduling approach in §7, and the delivery-time proposal in §9 item 2 did **not** ship as
written — each is marked inline. **`scripts/daily-advisor/README.md` is the accurate,
operator-facing source of truth for the current implementation**; this file is kept as the
historical record of the reasoning, not rewritten line-by-line to match the final build.

**Complete reconciliation, verified against the repo (not assumed):**

1. **Delivery workflow file:** `n8n-telegram-daily-advisor.json` (repo root) — not
   `n8n-telegram-product-lab-briefing.json` as §2/§3 name it.
2. **Output location:** `daily-advisor/output/{latest.md, YYYY-MM-DD.md}`, published via a
   dedicated git worktree to the `automation/daily-advisor` branch — never `main`, never
   `planning/PRODUCT_LAB_BRIEFING.md`/`.meta.json` as §2/§3/§4 describe. `latest.md` is written
   for convenience but deliberately never read by the delivery workflow, to avoid resending stale
   content on a missed run — the workflow reads the dated file only.
3. **Schedule:** the worker generates at **9:00 AM Asia/Manila**, registered as a Windows
   Scheduled Task firing 6:00 PM the previous day in this host's own timezone (`US Mountain
   Standard Time` / Arizona, UTC-7 — Task Scheduler triggers fire in the host's OS timezone, not
   Manila's). The n8n delivery workflow's own Schedule Trigger fires at cron `20 9 * * *` (09:20,
   a 20-minute buffer). Not the "06:00 generation / ~06:30 send" §2/§7/§9 propose.
4. **File layout:** all worker logic lives under `scripts/daily-advisor/` — `run.ts`
   (orchestration), `supabase-read.ts`, `claude-invoke.ts`, `render-briefing.ts`,
   `portfolio-ranking.ts` (the §5 ranking design, shipped essentially as designed, just not under
   `src/services/ai/`), `prompt.ts` (the §5 Claude-enrichment prompt), `persistence.ts`, `env.ts`,
   `lock.ts` (concurrency guard), `orphan-check.ts`, `sample-fixtures.ts`. **No**
   `src/services/ai/daily-brief*.ts` files were created (§3), and **no**
   `src/lib/supabase-mappers.ts` extraction happened (§3/§10 step 1) — the worker reads and maps
   Supabase rows itself, inside `scripts/daily-advisor/supabase-read.ts`, rather than sharing a
   mapper with `product-lab.tsx`.
5. **Scheduler registration:** there is **no** `setup-daily-advisor-scheduler.ps1` script (§3/§7)
   — the Windows Scheduled Task is registered directly via the `Register-ScheduledTask`
   PowerShell block documented in `scripts/daily-advisor/README.md`'s "Scheduling" section.
6. **`npm run advisor`** (§7 says "not made yet") now exists (`package.json`), running
   `node scripts/daily-advisor/run.ts`.
7. No `ai_briefings` Supabase table was created — persistence is local files only this phase,
   behind a `BriefingWriter` interface a future Supabase writer could implement without touching
   ranking or rendering (§9 item 3's "propose only" option was the one taken).
8. The data-source explicitness requirement (`--source supabase|sample`, no silent fallback) was
   added during implementation and is not in the original investigation below.

## 1. What already exists (inspected before proposing anything)

Three separate systems in this repo are relevant, and none of them already do this:

**`src/services/ai/`** (shipped this session) — the Copy-Prompt AI Advisor. Its prompt-assembly
pipeline (`context.ts` → `routing.ts` → `prompts.ts` → `advisor.ts`) is **single-product,
single-action, human-initiated**: a person clicks a button for one product, gets one prompt, and
manually runs it through an AI chat. There is no portfolio view, no scheduling, no CLI
invocation anywhere in it — `generateAdvisorPrompt()` is synchronous and never calls a process.
It is the right *pattern* to extend, not a thing this task reuses unmodified.

**`src/lib/rule-engine/`** — the deterministic evaluator this whole feature must stay downstream
of. `evaluateProduct(product, context, { includeLaunch? })` already returns everything a single
product's health needs: `productHealth`, `readinessPercentage`, `blockers`/`warnings`/`infos`,
`nextBestAction`, and the full `ruleResults[]`. Nothing here needs to change. What doesn't exist
yet is a **cross-product** ranking — every existing priority function
(`rule-engine/priority.ts`'s `getPriorityScore`) ranks findings *within one product* to pick that
product's `nextBestAction`. Nothing in the codebase today asks "across all six products, which
finding matters most this morning" — that's new logic this task needs, built as a sibling to
`priority.ts`, never inside it (see §5).

**AI-DEV-OS** (`AI-DEV-OS.md`, `SYSTEM-OVERVIEW.md`, `WORKFLOW.md`, `run-claude.ps1`,
`setup-task-scheduler.ps1`, `tools/*.ps1`, `n8n-telegram-*.json`) — a *different system for a
different job*: it triages feature ideas and drives a Claude-plans/Codex-builds pipeline for
**changing the app's own code**. It is not a briefing tool and this task doesn't touch it. But it
is the load-bearing precedent for "scheduled AI worker that reaches a human" in this repo, and
its delivery mechanics are directly reusable:

- `run-claude.ps1` is a Task-Scheduler-triggered PowerShell launcher with a fail-fast preflight
  (repo exists, git available, correct branch, clean tree, required scripts/CLI present), a
  commit-scope guard (only an explicit allow-list of paths may be committed; anything else halts
  the run uncommitted), structured logging to a `.log` file, and clear exit codes (0 = clean/
  disabled, 1 = mid-run halt, 2 = preflight abort).
- `tools/Generate-Digest.ps1` writes a **structured markdown file** (`planning/DIGEST.md`) and
  does nothing else — it never messages anyone. **`n8n-telegram-digest.json`** is the delivery
  half: a 07:00 cron trigger reads that file straight off GitHub's raw-content API
  (`GET /repos/.../contents/planning/DIGEST.md`) and sends it via a named Telegram credential
  (`Telegram Bot - Aly & Shin Product Lab`). Confirmed by reading the exported workflow JSON, not
  assumed: this is the exact "PowerShell/Node produces a file, n8n reads GitHub, n8n sends
  Telegram" split the task's preferred flow describes, already built and already proven for
  another purpose in this same repo.
- `AI-DEV-OS.md`/`docs/DECISIONS.md`/`STATUS.md` confirm this pipeline itself is still template
  scaffolding for this specific app (`$AUTOMATION_ENABLED = $false`, `docs/DECISIONS.md` has only
  one unfilled `TODO` entry, `STATUS.md` is empty) — the *scaffolding* is unfinished, but the
  *delivery mechanism* (`Generate-*.ps1` → markdown file → n8n GitHub-raw read → Telegram) is a
  real, working pattern independent of that unfinished state, and is what this design reuses.

**Two facts found while reading the actual data layer that change the design, not assumed from
memory:**

1. **Products are not in Supabase.** `product-lab.tsx` imports `products` from
   `src/lib/sample-data.ts` — a hardcoded array of 6 products. A `products` table exists in
   `supabase-schema.sql` with RLS policies defined for it, but the app never reads or writes it.
   The worker must read the product list the same way the app does — from `sample-data.ts` — not
   from a Supabase query that would silently return nothing.
2. **RLS policies are `to authenticated`, not `to anon`.** Every table the Rule Engine needs
   (`product_batches`, `costing_summaries`, `tasting_feedback`, `supply_entries`) grants
   `select`/`insert`/`update`/`delete` only to Supabase's `authenticated` role. The browser app
   satisfies this via a real login (`supabase.auth.signInWithPassword`) — `LoginScreen` blocks
   the whole app until a session exists. The public anon key alone, unauthenticated, would read
   **zero rows** from any of these tables under the current policies. This directly answers one
   of the task's required questions (see §6): the anon key is not sufficient by itself; the
   worker needs an authenticated session, not a bigger key.

## 2. Recommended architecture

> **⚠ Superseded — file names, paths, and schedule below are the ORIGINAL plan, not what
> shipped.** See the reconciliation at the top of this document, or
> `scripts/daily-advisor/README.md`, for the current file layout, output location, and schedule.
> The pipeline *shape* (Task Scheduler → PowerShell launcher → Node worker → Rule Engine per
> product → portfolio ranking → deterministic render → optional Claude enrichment → write output
> → git publish → n8n reads GitHub raw → Telegram) is accurate; the specific paths/names in the
> diagram are not.

```
Windows Task Scheduler ("Aly & Shin Product Lab Daily Advisor", configurable time)
    │
    ▼
daily-advisor.ps1  (repo root -- thin launcher, mirrors run-claude.ps1's preflight/log/exit-code shape)
    │  preflight: repo exists, git available, clean main, node on PATH, required env vars present
    │  invokes:
    ▼
scripts/daily-advisor/run.ts  (Node, native TS -- same node --test-compatible relative-import
                                convention already used by rule-engine/* and services/ai/*)
    │
    ├─ 1. Idempotency check: read planning/PRODUCT_LAB_BRIEFING.meta.json.
    │      If date === today and no --force flag -> log + exit 0, nothing else runs.
    │
    ├─ 2. Sign in to Supabase (email/password from local env vars -- see §6), read
    │      product_batches / costing_summaries / tasting_feedback / supply_entries, map
    │      snake_case rows -> camelCase RuleEngineContext (reused mapper, see §5).
    │      products[] comes from src/lib/sample-data.ts, not a query.
    │
    ├─ 3. For every product: evaluateProduct(product, context, { includeLaunch: true })
    │      -- the EXACT existing Rule Engine call, unmodified, imported directly.
    │
    ├─ 4. rankPortfolio(products, results) -- NEW pure function (src/services/ai/daily-brief.ts)
    │      -- deterministic, the 8-tier order from the task spec (see §5). This IS the
    │      briefing's real content; nothing after this step can change WHICH items appear or
    │      their ORDER, only add prose around them.
    │
    ├─ 5. renderDeterministicBriefing(ranked) -- pure function, markdown string.
    │      This is the fallback. It is complete and postable on its own -- Claude is additive,
    │      never required for a valid briefing to exist (see §8).
    │
    ├─ 6. Attempt Claude enrichment (skipped entirely on any failure, see §8):
    │      buildPortfolioPrompt(ranked) -> spawn("claude", [fixed argv incl. --tools ""], ...)
    │      -- same verified-safe invocation shape as LOCAL_AI_BRIDGE.md's investigation, reused
    │      here as a batch call instead of a browser-triggered one. Hard timeout; parsed
    │      server-side; only Claude's prose is extracted, nothing else.
    │
    ├─ 7. Write planning/PRODUCT_LAB_BRIEFING.md (+ .meta.json marker) to disk.
    │
    └─ 8. Optionally insert one row into a new ai_briefings table (if it exists -- same
           graceful-degradation pattern as isAiReviewsTableMissing; briefing generation never
           fails because this table is missing).
    │
    ▼
daily-advisor.ps1 resumes: commit-scope guard allows ONLY
    planning/PRODUCT_LAB_BRIEFING.md + planning/PRODUCT_LAB_BRIEFING.meta.json
    -> git add, commit, push (retry-with-rebase, same as run-claude.ps1's Push-MainWithRetry)
    │
    ▼
n8n-telegram-product-lab-briefing.json (new workflow, cloned shape from n8n-telegram-digest.json)
    cron trigger (e.g. 06:30, before the existing 07:00 proposal digest)
    → GitHub raw read of planning/PRODUCT_LAB_BRIEFING.md
    → Telegram send, via the SAME already-configured "Telegram Bot - Aly & Shin Product Lab"
      credential the other three workflows already use
```

**Why this shape and not a live HTTP server:** the task explicitly says this is not an in-browser
feature and must not expose a public endpoint. A batch script that writes a file and exits has no
listening port at all — requirement 8 ("do not expose a public HTTP endpoint") is satisfied by
construction, not by a firewall rule. This also means none of `LOCAL_AI_BRIDGE.md`'s
origin-validation / request-schema / health-check machinery is needed here — that design was for
a *browser* calling a *local server on demand*; this worker has no caller to authenticate against
at all, it runs on a timer and talks to nothing but Supabase, the `claude` binary, and git.

## 3. Files actually shipped (corrected — this section originally read "Expected files, none
created yet"; the list below is verified against the repo, not the original plan)

```
daily-advisor.ps1                          -- Task Scheduler launcher (preflight, invoke, commit, log)
scripts/daily-advisor/run.ts                -- orchestration entry point
scripts/daily-advisor/supabase-read.ts      -- authenticate + load the tables the Rule Engine needs
scripts/daily-advisor/claude-invoke.ts      -- spawn() wrapper: fixed argv, timeout, JSON parse, error classes
scripts/daily-advisor/render-briefing.ts    -- ranked findings -> markdown (deterministic + Claude-enriched variants)
scripts/daily-advisor/portfolio-ranking.ts  -- rankPortfolio()-equivalent: the §5 tier design, shipped here
scripts/daily-advisor/prompt.ts             -- Claude-enrichment prompt assembly, the §5/§6 design
scripts/daily-advisor/persistence.ts        -- BriefingWriter -- writes latest.md + YYYY-MM-DD.md
scripts/daily-advisor/env.ts                -- loads/validates ADVISOR_SUPABASE_* env vars (§6's credential model)
scripts/daily-advisor/lock.ts               -- concurrency guard (not in the original plan)
scripts/daily-advisor/orphan-check.ts       -- stale-lock/orphan-run detection (not in the original plan)
scripts/daily-advisor/sample-fixtures.ts    -- fixture data for `--source sample` (not in the original plan)
n8n-telegram-daily-advisor.json             -- the n8n workflow (cloned shape, dated-file fetch, Telegram send)
tests/daily-advisor.test.ts                 -- ranking, prompt assembly, fallback, idempotency, no-mutation
tests/smoke/daily-advisor.test.ts           -- opt-in, real Claude call, excluded from `npm test`'s glob
daily-advisor/output/latest.md              -- generated output, published to automation/daily-advisor
daily-advisor/output/YYYY-MM-DD.md          -- generated output, published to automation/daily-advisor
```

**Not built, by design or by different choice than §9 anticipated:** `src/lib/supabase-mappers.ts`
(no shared mapper extraction — the worker maps rows itself), `src/services/ai/daily-brief*.ts` (the
ranking/prompt logic that would have lived there instead lives in `scripts/daily-advisor/` — see
above), `setup-daily-advisor-scheduler.ps1` (the Windows Task is registered via the
`Register-ScheduledTask` block in `scripts/daily-advisor/README.md`, not a standalone script),
`supabase-add-ai-briefings.sql` (no `ai_briefings` table was proposed or created).

## 4. Data flow (detail)

> **⚠ Superseded — the `planning/PRODUCT_LAB_BRIEFING.md` path below is the ORIGINAL plan, not
> what shipped.** The real output path is `daily-advisor/output/{latest.md, YYYY-MM-DD.md}`,
> published to the `automation/daily-advisor` branch (see the reconciliation at the top of this
> document). The rest of the flow below — ranking, deterministic render, optional Claude
> enrichment, n8n GitHub-raw read, Telegram send — is accurate.

```
sample-data.ts products[]  ──┐
Supabase (authenticated) ────┼─→ RuleEngineContext { batches, costings, tastings, supplies, now }
                              │
                              ▼
            for each product: evaluateProduct(product, context, { includeLaunch: true })
                              │
                              ▼
              PortfolioFinding[] = every RuleResult, tagged with its product
                              │
                              ▼
                    rankPortfolio()  (deterministic, 8-tier order, §5)
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
      renderDeterministicBriefing   buildPortfolioPrompt
      (always runs, always valid)  (optional Claude enrichment, §8)
                    │                   │
                    │                   ▼
                    │           claude -p --tools "" ...
                    │           (success: prose + one optional
                    │            AI-tagged improvement idea;
                    │            failure: nothing, caught, logged)
                    └─────────┬─────────┘
                              ▼
                planning/PRODUCT_LAB_BRIEFING.md (+ .meta.json)
                              │
                              ▼
                    git commit + push (allow-listed paths only)
                              │
                              ▼
        n8n: GitHub raw read → Telegram send (existing bot credential)
```

## 5. Prioritization design — a deliberate SECOND ranking, not a duplicate of the first

`rule-engine/priority.ts`'s `getPriorityScore` already ranks findings, but it answers a
**different question** than this task asks: "within this one product, what's the single next
action" (weighted Financial > Food Safety > other Quality > Supply > Production > Development).
The Daily Brief asks "across the whole portfolio, what needs attention **today**," and the task
specifies an explicit, different order: Safety/quality blockers → Financial → Experiment
observations due → Launch blockers → Production repeatability → Supply failures → Warnings →
Improvements. These orders genuinely disagree (existing: Financial outranks Quality; requested
here: Safety/quality blockers outrank Financial) — because they're not the same decision. Building
a second, explicitly-named ranking (`rankPortfolio`, new file) that mirrors *none* of
`getPriorityScore`'s weights and states in its own comment why the order differs is the honest
choice; silently reusing `getPriorityScore` for this would either violate the task's explicit
ordering or quietly change what `nextBestAction` means elsewhere. Neither module recomputes a
`RuleResult` — both only re-sort results `evaluateProduct()` already produced.

Implementation shape (pure function, unit-testable without any I/O):

```ts
type PortfolioTier =
  | "safety-quality-blocker"   // QUAL-005 always; any quality blocker
  | "financial-blocker"        // financial severity: blocker, or passed === false at all
  | "experiment-due"           // see gap below -- always empty today
  | "launch-blocker"           // category: launch, passed === false
  | "production-repeatability" // category: production, severity blocker/warning
  | "supply-failure"           // category: supply, passed === false, severity !== info
  | "warning"                  // any remaining severity: warning
  | "improvement";             // severity: info, or Claude's own optional suggestion
```

`rankPortfolio` flattens every product's `ruleResults` into `(product, result)` pairs, assigns
each a tier per the table above (first matching tier wins, checked in the order listed), sorts by
tier then by the existing `getPriorityScore` as a same-tier tiebreak (reusing it for *within-tier*
ordering only, not for the top-level tier assignment — this is the one place it's reused, and only
as a tiebreaker), and returns the top N plus a "no action needed" bucket for products with zero
blockers/warnings/infos.

**Honest gap, flagged not worked around:** "Active experiment observations due today or overdue"
has no queryable data behind it. `ARCHITECTURE.md` already documents this exact hole — DEV-004
"has no structured experiment entity to check against at all — always returns `passed: null`."
There is no due-date field anywhere in `ProductBatch`, `TastingFeedback`, or any other type. This
tier will be **structurally empty** in the first version, exactly like DEV-004's honest null,
not filled with a keyword-search heuristic over `wentWrong`/`improveNext` text (that would be
guessing a due date that was never recorded). If this tier needs to produce real content, it needs
a schema addition first (e.g., an `experiments` table with a due date) — flagged in §9 as an
unresolved decision, not built here.

**"Estimated effort where evidence supports it":** no `RuleResult` or any other type carries an
effort/time field, so the deterministic ranking cannot honestly estimate effort — it omits the
line entirely, same discipline as the experiment gap. Effort estimation is delegated to Claude's
optional enrichment pass, explicitly tagged "AI estimate" wherever it appears (never presented as
a rule-engine fact), and simply absent from the deterministic fallback when Claude doesn't run.

**"Links or identifiers to open the relevant record":** the app has no URL-based deep linking at
all — `selectedProductId` is React state (`useState`), never reflected in the URL, confirmed by
grepping `product-lab.tsx` for router/search-param usage and finding none. The briefing can only
cite a stable identifier (`product.id` / `product.name`, e.g. "Brownies") for the reader to select
manually in the app's own product picker — not a clickable link. A `?product=<id>` query param
would be a small, separate follow-up if ever wanted; out of scope here.

## 6. Security model

**Secrets, all local-only, never in the browser bundle:**

| Secret | Source | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | existing `.env.local` | Already public-facing by design (RLS-protected); reused as-is. |
| Supabase login email/password | new local-only env file (e.g. `.env.advisor.local`, gitignored) | Required because RLS is `to authenticated` — see §1. Real credential, not a public key; must never be committed. |
| Claude CLI auth | the OS user's own `~/.claude` OAuth session | Never touched, forwarded, or read by the worker — same as `LOCAL_AI_BRIDGE.md`'s finding; the worker only invokes the binary. |
| GitHub PAT, Telegram Bot token | already exist as **named n8n credentials** (`GitHub PAT - Aly & Shin Product Lab`, `Telegram Bot - Aly & Shin Product Lab`) | The worker never touches these at all — n8n owns delivery entirely, exactly as it already does for the proposal digest. This is a deliberate simplification: this design needs zero new Telegram/GitHub secrets anywhere in the Node/PowerShell layer. |

**Does the anon key suffice under current RLS, or is a dedicated credential necessary?** (task's
explicit required question) — **The anon key alone is not sufficient.** Every table this feature
reads is `to authenticated` only (§1). The worker needs a real Supabase Auth session. Two ways to
get one, both evaluated:

- **Recommended for this phase: authenticate as the existing operator account** via
  `supabase.auth.signInWithPassword()`, credentials from a local, gitignored env file. Zero schema
  or policy changes (satisfies "do not apply Supabase changes"). Honest limitation, stated plainly
  rather than glossed over: this repo currently has exactly one authenticated role, and its RLS
  policies grant that role full `select/insert/update/delete` on every table — there is no
  narrower "read-only" role to log in as. The worker is *written* to only ever call `.select()`
  except for its one intentional write (the optional `ai_briefings` insert), but that's a
  code-level discipline, not a database-enforced guarantee. This is the same trust level the
  interactive app itself already operates at, not a new exposure.
- **Considered and not recommended: a Supabase service-role key.** Bypasses RLS entirely — a
  strictly broader credential than the login above, not a narrower one, despite feeling more
  "backend-y." Would also mean managing a second, more dangerous secret class locally. Rejected on
  a least-privilege basis.
- **Not available in this phase:** a genuinely scoped read-only Postgres role/policy is the
  correct long-term answer, but creating one is a Supabase schema/policy change, which the task
  explicitly excludes from this design. Recorded as an unresolved decision in §9.

**Never sent to Claude:** the Supabase session, auth tokens, raw database rows, or anything beyond
the same kind of pre-aggregated, already-computed structures `services/ai/prompts.ts` already
sends today (`ruleEngineOutput`, costing/tasting summaries) — extended to a portfolio array of the
same shapes. No password, no email, no row IDs beyond `product.id` (already a public-ish slug like
`"brownies"`, not a database secret).

**Logging:** structured, one line per phase (mirroring `run-claude.ps1`'s log style) — timestamps,
phase name, pass/fail, product counts, tier counts. Never logs the full assembled prompt, the full
Claude response, the Supabase password, or raw CLI stdout/stderr by default (matches requirement).
An opt-in verbose flag could log the full prompt for local debugging only — not default behavior.

## 7. Scheduling approach

> **⚠ Superseded — no `setup-daily-advisor-scheduler.ps1` script exists.** The Windows Scheduled
> Task is registered directly via the `Register-ScheduledTask` PowerShell block in
> `scripts/daily-advisor/README.md`'s "Scheduling" section, at 6:00 PM Arizona time (= 9:00 AM
> Asia/Manila) on this host — not the "06:00" default this section proposes. Adjusting the time
> means editing and re-running that block, not an `-At` flag. The reasoning below (new/separate
> task from the AI-DEV-OS pipeline, `-WakeToRun` for offline-at-trigger-time) held.

Windows Task Scheduler, a **new, separate task** from the existing "Aly & Shin Product Lab Claude
Overnight" one — different concern (product/business briefing vs. code-build pipeline), same
reasoning the earlier `ai-review/` investigation already applied when it kept that framework
separate from AI-DEV-OS.

- `setup-daily-advisor-scheduler.ps1` registers "Aly & Shin Product Lab Daily Advisor" with a
  `-At <time>` parameter (default recommendation: **06:00**, so it finishes with margin before
  the existing 07:00 proposal-digest send and the new briefing workflow's own read at ~06:30).
  Configurable per the task's requirement — re-run the setup script with a different `-At` to
  change it, same pattern as the existing scheduler script's own comment ("To change the time:
  edit the `-At` parameter and re-run"). *(Not what shipped — see the note above.)*
- **Manual run:** `node scripts/daily-advisor/run.ts` directly, or an `npm run advisor` script
  (package.json addition, not made yet).
- **Force flag:** `--force` bypasses the idempotency check (§below) for testing — generates and
  overwrites today's briefing even if one already ran.
- **Idempotency:** `planning/PRODUCT_LAB_BRIEFING.meta.json` records `{ "date": "YYYY-MM-DD",
  "generatedAt": ISO timestamp, "claudeUsed": boolean }`. Every run checks this file first; if
  `date` already equals today and `--force` wasn't passed, the run logs "already generated today"
  and exits 0 without touching Supabase, Claude, git, or n8n. This is the cheapest possible guard
  (one file read, no network calls) and also protects the Claude usage-window budget
  (`LOCAL_AI_BRIDGE.md` §4) from an accidental double-fire.
- **Exit codes**, mirroring `run-claude.ps1`'s convention so the same mental model applies to both
  schedulers: `0` = clean run (generated, or skipped idempotently), `1` = mid-run failure (Supabase
  unreachable, git push failed after retries, etc. — briefing may be partially written but wasn't
  committed), `2` = preflight abort (environment problem, nothing attempted).
- **Offline-at-scheduled-time:** `-WakeToRun` on the registered task, same as the existing
  scheduler (the PC needs to be asleep-but-wakeable, not off, for this to help — same S3/S4-not-S5
  reasoning `run-claude.ps1` already documents for its own shutdown branch). If the PC is fully
  off, the task simply doesn't fire; nothing crashes, no partial state — the next day's run
  proceeds normally since idempotency keys off calendar date, not "did yesterday's run happen."

## 8. Deterministic fallback behavior

Designed so the fallback isn't a separate code path that can drift from the "real" output — it
**is** the real output's foundation. `renderDeterministicBriefing(ranked)` runs unconditionally,
first, and produces a complete, valid, two-minute-readable briefing from the ranked findings alone
(date, portfolio summary line, highest-priority product + its exact `nextBestAction`-equivalent
top finding, up to three concrete actions quoting `RuleResult.recommendation` verbatim, the
"no action needed" product list, honest omissions for the experiment/effort gaps). Claude is then
attempted as a strictly additive enrichment pass over that same ranked data — never a replacement
generator, never a second source of truth for which findings exist or their order (§5's "Claude
may explain and organize... must not silently reorder").

Every failure mode in the task's Reliability list resolves to the same branch: catch, log a
one-line reason, deliver the deterministic content, mark `claudeUsed: false` in the meta file.

| Failure | Detection | Outcome |
|---|---|---|
| Claude executable missing | `spawn` ENOENT | Caught, logged, deterministic briefing delivered |
| Claude login expired | CLI's own auth-error JSON/exit code | Same |
| Subscription usage exhausted | CLI's own usage-limit error (same shape as `LOCAL_AI_BRIDGE.md`'s Codex test) | Same |
| Timeout | hard wall-clock timer, `kill()` the child | Same |
| Malformed Claude JSON | `JSON.parse` throws, or `result` field missing | Same |
| Supabase unavailable | query error / network throw | **Different** — no data means no honest ranking either; briefing generation halts (exit 1), nothing is committed or sent. A briefing built on stale or absent data would be worse than a skipped morning, per "fail loud." |
| No active products | `sample-data.ts` products array is never empty in practice, but the ranking function itself handles zero-products gracefully — an explicit "no products configured" line, not a crash |
| Incomplete product data | Already the Rule Engine's own discipline — `passed: null` propagates through unchanged; the briefing surfaces "insufficient data" findings honestly rather than guessing |
| Telegram delivery failure | n8n's existing behavior — `n8n-telegram-error-alert.json` is already the standing Error Workflow for the other three Telegram flows; the new workflow should be wired to the same Error Workflow rather than inventing new alerting |
| Duplicate execution | idempotency check, §7 | Second run is a fast no-op |

**Why Supabase-unavailable is NOT treated the same as Claude-unavailable:** Claude is optional
enrichment; Supabase data is the entire deterministic foundation everything else is built from. A
"fallback" that fabricates a briefing without real data would be indistinguishable from a
hallucination and is exactly what the Rule Engine's `passed: null` discipline exists to prevent
elsewhere in this app — extended here rather than special-cased away.

## 9. Unresolved decisions (need your call before implementation)

1. **Where does the Supabase login credential live day to day?** A new gitignored
   `.env.advisor.local` is the minimal option; a proper OS-level secret store (Windows Credential
   Manager) would be more robust but is more work and isn't this repo's existing convention
   anywhere else (the app itself just uses a plain `.env.local`). Recommend matching existing
   convention unless you want to raise the bar generally.
2. **Delivery time — resolved, not what was proposed here.** Shipped as 9:00 AM Asia/Manila
   generation (registered 6:00 PM Arizona time on this host) / 9:20 AM Asia/Manila Telegram send
   (n8n cron `20 9 * * *`), not the "06:00 / ~06:30" proposed below. See the reconciliation at the
   top of this document.
3. **`ai_briefings` persistence — build it now or skip it?** The task says "optionally save to
   Supabase." Recommend the same additive, not-yet-applied SQL file pattern as `ai_reviews`
   (`supabase-add-ai-briefings.sql`, proposed only) so history exists once you choose to run it,
   without blocking the feature on a schema change today.
4. **Experiment due-dates tier.** Confirmed empty until a real schema exists for it (§5). Worth
   scoping as a small follow-up feature (a `next_check_date` field somewhere, or a lightweight
   `experiments` table) if this tier matters to you in practice — not decided here.
5. **Should the daily worker's git commits go straight to `main` (like `run-claude.ps1` does for
   planning docs), or would you rather they landed as a PR you glance at before merge?** The
   AI-DEV-OS precedent auto-commits planning-doc-only changes directly; this worker's writes are
   similarly narrow (two generated files, allow-listed), but it's your call whether a daily
   automated push to `main` — even of a docs-only file — needs the same trust bar as the code
   pipeline's red-zone gate, or is closer to the digest's "reversible, low-stakes" tier.
   **Resolved, and neither literal option:** the worker never touches `main` at all — output
   publishes to a dedicated `automation/daily-advisor` branch via a separate git worktree, which
   is never merged. See the reconciliation at the top of this document.

## 10. Smallest implementation sequence (for when you approve)

1. Extract `src/lib/supabase-mappers.ts` from `product-lab.tsx`'s `loadSupabaseData` (mechanical,
   pure, additive — same category of refactor as the earlier `batches.ts`/`costing.ts`
   extractions; app behavior unchanged, verified by the app still passing its existing tests).
2. Add `src/services/ai/daily-brief-types.ts` + `daily-brief.ts` (`rankPortfolio`, pure, fully
   unit-testable with zero I/O) + tests proving the 8-tier order against hand-built fixtures.
3. Add `src/services/ai/daily-brief-prompt.ts` (`buildPortfolioPrompt`, pure string assembly,
   mirrors `prompts.ts`) + a test proving a specific `RuleResult.message` appears verbatim in the
   built prompt (same style as the existing AI Advisor test suite).
4. Add `scripts/daily-advisor/render-briefing.ts` (deterministic markdown renderer) + tests —
   this alone is already a shippable, useful artifact (a briefing generator you can run by hand),
   before any CLI-invocation code exists at all.
5. Add `scripts/daily-advisor/claude-invoke.ts` (spawn wrapper) + `run.ts` (orchestration,
   idempotency, Supabase auth) — wire the enrichment pass in as strictly additive over step 4's
   output.
6. Add `daily-advisor.ps1` + `setup-daily-advisor-scheduler.ps1`, test with a manual run first
   (`-Scheduled` omitted, matching `run-claude.ps1`'s own interactive-vs-scheduled distinction).
7. Clone `n8n-telegram-product-lab-briefing.json` from the digest workflow's shape, point it at
   the new file path and schedule, wire its Error Workflow to the existing alert workflow.
8. Only after a few days of manual/observed runs: register the actual Scheduled Task.

Each step is independently testable and independently useful — step 4 alone gives you a working
briefing generator you can run by hand before any scheduling, CLI invocation, or Telegram wiring
exists at all.

## 11. What this document is not

Not a package.json script, not a database migration, not a scheduled task, not a running process,
not a git commit. Per the task: **investigation and proposed architecture only, stopping here for
approval.**
