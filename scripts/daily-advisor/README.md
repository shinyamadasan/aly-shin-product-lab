# Daily AI Advisor

A scheduled worker that reads Product Lab's real data, evaluates every product through the
existing deterministic Rule Engine, ranks the results into a two-minute morning briefing, and
optionally adds a short Claude-generated note on top. It is **not** the in-browser Copy-Prompt AI
Advisor (`src/services/ai/`, `src/components/ai-advisor-panel.tsx`) -- that feature is unchanged
and still the only in-app AI surface. This is a separate, offline batch worker with no UI of its
own.

Full investigation and design rationale: `../../DAILY_AI_ADVISOR.md`. This file is the practical
day-to-day operator guide.

## What it does, in order

0. Acquires a single-instance run lock (`daily-advisor/.run.lock`) before anything else --
   rejects (exit 3) if another instance is already running, recovers automatically if the lock is
   stale (dead pid or older than 60 minutes). Never bypassable by `--force`. See "Concurrency and
   the run lock" below.
1. Reads `--source` (`supabase` or `sample`) -- **required, never defaulted.** Supabase mode signs
   in to a dedicated Supabase Auth user and reads `product_batches`, `costing_summaries`,
   `tasting_feedback`, `supply_entries`. If anything about that fails -- including an
   authenticated read that returns zero rows everywhere, which cannot be told apart from a broken
   RLS policy or the wrong project -- the run stops with an error; it never falls back to sample
   data silently. Sample mode uses small, obviously-synthetic fixture data (`sample-fixtures.ts`)
   and is for development/testing only.
2. Evaluates every product (from `src/lib/sample-data.ts` -- see "Why products always come from
   sample-data.ts" below) through the unmodified `evaluateProduct()` Rule Engine call. Also checks
   for operational records (batches/costings/tastings) whose `product_id` doesn't match any
   product in the static catalog -- these are logged and surfaced as a diagnostics line, never
   silently dropped, and never affect ranking.
3. Ranks every finding across the whole portfolio into 8 tiers (`portfolio-ranking.ts`) -- a
   deliberately different order from the single-product `nextBestAction` ranking; see
   `DAILY_AI_ADVISOR.md` section 5 for why both are correct. Any active blocker-severity finding
   is guaranteed to rank above every warning and info-level item, regardless of category.
4. Renders a complete markdown briefing from that ranking alone (`render-briefing.ts`) -- this is
   the guaranteed output, valid with zero AI involvement.
5. Optionally asks Claude Code CLI (`claude -p --tools "" ...`, the exact zero-tool shape verified
   in `LOCAL_AI_BRIDGE.md`) for a short, bounded addition: an explanation, sequencing advice, and
   one labeled optional suggestion. Any failure here (missing binary, expired login, exhausted
   quota, timeout, malformed output, or output exceeding a 2 MB bound) is caught and logged; the
   deterministic briefing from step 4 ships unchanged, and raw CLI output is never included in an
   error.
6. Writes `daily-advisor/output/latest.md` and `daily-advisor/output/YYYY-MM-DD.md` locally.
7. `daily-advisor.ps1` (the launcher) publishes those two files to the dedicated
   `automation/daily-advisor` branch -- **never to `main`**.

## Why products always come from `sample-data.ts`, in both modes

Live inspection found a `products` table in `supabase-schema.sql` that the app never actually
reads -- `product-lab.tsx` imports the product list from `src/lib/sample-data.ts` regardless of
whether Supabase is configured. `--source supabase` therefore means "real batches, costings,
tastings, supplies from Supabase" -- the product catalog itself is the same static list either
way, because that's genuinely how the live app works today, not a shortcut this worker took.

Every briefing states this as two separate lines, not one, so catalog provenance and operational
provenance can never be conflated (an earlier single "Data source: Supabase" line implied the
whole briefing, including which products exist, came from the database, which was never true):

```
Product catalog: Static application data      <- Supabase mode
Operational data: Supabase

Product catalog: Sample fixtures               <- Sample mode
Operational data: Sample fixtures
```

## Setup

1. `cp .env.advisor.local.example .env.advisor.local` and fill in real values. This file is
   gitignored (`.gitignore`'s `.env*` rule) -- never commit it.
2. Create a **dedicated** Supabase Auth user for this worker (Supabase dashboard -> Authentication
   -> Users -> Add user). Do not reuse your own login, and do not use the service-role key -- see
   `DAILY_AI_ADVISOR.md` section 6 for why. This account authenticates through the same RLS
   policies the app already has (`to authenticated`); there is currently no narrower read-only
   role, which is a known, documented limitation, not an oversight.
3. Make sure `claude` is on `PATH` and logged in (`claude auth status`) if you want AI enrichment.
   Not required -- the worker produces a complete briefing without it.

## Manual run

```
npm run advisor -- --source sample              # safe, no credentials needed, no Claude usage unless logged in
npm run advisor -- --source supabase             # real data, requires .env.advisor.local
npm run advisor -- --source supabase --force     # regenerate even if today's file already exists
npm run advisor -- --source sample --skip-claude # deterministic-only, for fast iteration
```

Or via the launcher (also handles publishing to the artifact branch):

```
pwsh ./daily-advisor.ps1 -Source supabase
pwsh ./daily-advisor.ps1 -Source sample -SkipClaude
```

## Scheduling

Not registered automatically by this implementation -- register it yourself once you're happy
with a few manual runs (matches `run-claude.ps1`'s own "watch one run before enabling" caution).
Recommended: **9:00 AM Asia/Manila**, Windows Task Scheduler:

```
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NonInteractive -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\Vibe code\Coffee and Bakery business\05_App_And_Tech\aly-shin-product-lab\daily-advisor.ps1" -Source supabase'
$trigger = New-ScheduledTaskTrigger -Daily -At "9:00AM"
Register-ScheduledTask -TaskName "Aly & Shin Product Lab Daily Advisor" -Action $action -Trigger $trigger `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew) `
  -Description "Generates the daily Product Lab briefing and publishes it to automation/daily-advisor."
```

Note the trigger time is in the *scheduling machine's local OS timezone* (Task Scheduler has no
timezone concept of its own) -- if the machine's OS timezone is already Asia/Manila, `9:00AM`
above is correct as written; otherwise adjust the `-At` value so it fires at 9:00 AM Manila time.
This is separate from `-Timezone`/`ADVISOR_TIMEZONE`, which only controls what calendar date the
*briefing* is dated for, not when the task fires.

Idempotent by design: if `daily-advisor/output/YYYY-MM-DD.md` (for "today" in the configured
timezone) already exists, a run without `-Force` logs and exits 0 without touching Supabase,
Claude, or git.

## Concurrency and the run lock

Two independent, deliberately different mechanisms:

- **Same-day idempotency** (exit 0) -- "has today's briefing already been generated?" Bypassable
  with `-Force`/`--force`, by design, for testing.
- **The run lock** (exit 3) -- "is another instance currently running, right now?" A file lock at
  `daily-advisor/.run.lock` (`{ pid, startedAt }`), acquired atomically (exclusive file create) as
  the very first action of both `run.ts` and `daily-advisor.ps1`, before either even looks at
  `-Force`. **`-Force` cannot bypass this** -- forcing a regeneration while a real run is in
  flight still gets rejected, not raced. `daily-advisor.ps1` holds the lock across BOTH generation
  and publication as one span (it sets `ADVISOR_LOCK_OWNED_EXTERNALLY=1` when it invokes `node` so
  `run.ts` doesn't try to acquire the same lock again under a different pid). A stale lock (the
  recorded pid is no longer running, or the lock is older than 60 minutes -- comfortably above any
  real run's worst-case duration) is detected and recovered automatically on the next run; no
  manual cleanup is needed after a crash. `Register-ScheduledTask`'s `-MultipleInstances
  IgnoreNew` above is a second, OS-level layer of the same protection, cheaper because it stops a
  second Task Scheduler launch before it even starts -- the file lock is what also protects a
  manual `npm run advisor` run overlapping a scheduled one.

## The artifact branch, not `main`

`daily-advisor.ps1` never commits to whatever branch you have checked out. It maintains a
dedicated worktree at `.worktrees/daily-advisor` (gitignored) tracking `automation/daily-advisor`,
copies `daily-advisor/output/` into it, and commits+pushes there directly -- no PR, per the task's
"lightweight automated update process... contains only briefing output" decision. Your own
feature-branch work is never touched, staged, or blocked by this.

## Consuming the briefing (n8n / GitHub raw)

`../../n8n-telegram-daily-advisor.json` (repo root) is the delivery workflow, structurally cloned
from `n8n-telegram-digest.json`'s proven shape (same credential names, same node types/versions,
same raw-content GitHub fetch pattern) but reading from the **dated** file, not `latest.md`:

```
GET https://api.github.com/repos/shinyamadasan/aly-shin-product-lab/contents/daily-advisor/output/{today in Asia/Manila, YYYY-MM-DD}.md?ref=automation/daily-advisor
Accept: application/vnd.github.raw
```

**`latest.md` is deliberately not used for scheduled delivery.** An earlier draft of this workflow
fetched `latest.md` and gated sending on a placeholder-text check -- an independent pre-import
review found that design had no freshness protection: if the worker failed or never ran on a
given day, `latest.md` still holds a real, non-placeholder briefing from whenever it last
succeeded, and that stale content would pass the placeholder check and get sent as if current.
Fetching the Asia/Manila-dated file instead closes this by construction: **no dated file for
today means the GitHub node 404s, the workflow halts there (default n8n behavior -- no
`continueOnFail` is set), and nothing is sent** -- not a stale resend, not a placeholder message.
This is computed with an explicit-timezone n8n expression,
`{{ $now.setZone('Asia/Manila').toFormat('yyyy-LL-dd') }}`, which does not depend on or inherit
whatever timezone the n8n host/instance itself happens to be configured with.

The workflow has three nodes after the schedule trigger: the GitHub fetch above, a **Code node**
("Prepare Telegram message chunks") that splits the raw markdown into pieces safely under
Telegram's 4096-character limit (paragraph boundaries preferred, then line boundaries, hard
character splitting only as a last resort -- never drops content, labels each piece `Daily
Advisor (i/N)` only when there's more than one), and the Telegram send itself -- which n8n runs
once per chunk automatically, in order. Telegram `parse_mode` is deliberately left unset (plain
text): neither this workflow nor the proven Digest workflow escapes special Markdown characters
before interpolating free text, and this briefing includes Claude's unconstrained AI note, which
is more likely than the Digest's templated content to contain a character that breaks Markdown
parsing outright.

Import it into n8n and follow its `_setup_notes` (credentials, the manual-test sequence, the
Error Workflow step below) **while leaving it inactive** -- activation is its own explicit step,
only after a real Supabase briefing has actually been published and manually verified. Not yet
imported or activated by this change. The worker itself never holds a Telegram credential or
makes an outbound call beyond Supabase and the local `claude` binary -- n8n owns delivery
entirely. Also not done by this file: n8n's per-workflow Error Workflow setting isn't portable
through JSON import/export, so pointing this workflow at the existing
`[Aly & Shin Product Lab] Error Alert` workflow (the same alerting the other three
`n8n-telegram-*.json` workflows already use) has to be set by hand in the n8n UI after import.

## Environment variables (`.env.advisor.local`)

| Variable | Required for | Notes |
|---|---|---|
| `ADVISOR_SUPABASE_URL` | `--source supabase` | Same project as the app's `.env.local`, but kept in a separate file deliberately (task decision 1) |
| `ADVISOR_SUPABASE_ANON_KEY` | `--source supabase` | |
| `ADVISOR_SUPABASE_EMAIL` | `--source supabase` | The dedicated worker account, not your own login |
| `ADVISOR_SUPABASE_PASSWORD` | `--source supabase` | |
| `ADVISOR_TIMEZONE` | optional | Defaults to `Asia/Manila`. Controls which calendar date the briefing is dated for. |
| `ADVISOR_CLAUDE_BIN` | optional | Defaults to `claude` (resolved from `PATH`) |

## Testing

- `npm test` runs `tests/daily-advisor.test.ts` alongside the rest of the suite -- pure functions
  and dependency-injected fakes only (a fake `spawn` for `claude-invoke.ts`, a hand-built stub
  client for `supabase-read.ts`). No real Claude call, no real Supabase call, ever, in this file.
- `npm run advisor:smoke` runs the one opt-in test that makes a real Claude call, and only if
  `ADVISOR_SMOKE_TEST=1` is set -- otherwise it reports skipped. Costs one real Claude usage-window
  call; run deliberately, not routinely.

## Known limitations (see `DAILY_AI_ADVISOR.md` for full detail)

- No dedicated read-only Supabase role exists yet -- the worker's authenticated user has the same
  full CRUD access the interactive app has under current RLS, even though this code only ever
  calls `.select()`. That's a code-level discipline, not a database-enforced guarantee.
- "Active experiments" reports only what's structurally true today (has an unsettled retest batch,
  or the latest batch has no tasting recorded) -- it never claims something is "due" or "overdue"
  because no due-date field exists anywhere in the schema. See the follow-up logged in
  `planning/ROADMAP.md` under "Known issues" for the `experimentStatus`/`nextObservationAt` fields
  that would make this more specific.
- No Supabase persistence of generated briefings this phase -- `persistence.ts`'s `BriefingWriter`
  interface is the seam a future Supabase-backed writer would implement instead of the file writer,
  without touching ranking or rendering.
