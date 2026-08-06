# Daily Recommendation Readiness (PROP-034)

A scheduled worker that ensures the Opportunity Today (PROP-035) will select has already been
advanced to a ready Creative Package before the owner opens the app. It is not a content
generator and not a copywriter -- see `planning/PROPOSALS.md`'s PROP-034 entry for the full
Truthfulness Principle. This file is the practical day-to-day operator guide; the approved
architecture lives in PROPOSALS.md, not here.

## What it does, in order

0. Acquires a single-instance run lock (`creative-prep/.run.lock`) before anything else -- rejects
   (exit 3) if another instance is already running, recovers automatically if the lock is stale
   (dead pid, or older than the lock module's own staleness window). This is the exact same lock
   contract Daily Advisor uses (`scripts/daily-advisor/lock.ts`, imported directly, not copied) --
   see that script's own README for the mechanism itself.
1. Signs in to the same dedicated Supabase Auth worker account Daily Advisor already uses (see
   Setup below -- no separate credentials needed if Daily Advisor is already configured).
2. Selects the newest Opportunity that still needs advancing (`selectPreparationCandidate` --
   status `new` or `accepted`, ordered by `detected_at`). If nothing is eligible, reports a clean
   no-op and exits 0.
3. Advances it exactly as far as its current state requires, using existing, already-tested
   functions only -- never anything reimplemented here:
   - `new` -> accepts it.
   - No Creative Job yet -> creates one with `workerType: "opportunity_brief"` (never the `mock`
     default).
   - Job `queued` -> executes it and materializes the Creative Package in one step.
   - Job `completed` with no package yet -> materializes the package only, without re-executing.
   - Job already has a ready package -> no-op.
4. Writes a structured result to `creative-prep/output/YYYY-MM-DD.jsonl` (appended -- every
   invocation that day is preserved, including a failed scheduled run followed by a successful
   manual catch-up) and `creative-prep/output/latest.json` (overwritten, convenience pointer only
   -- never read as a source of truth, same convention as Daily Advisor's `latest.md`).
5. Exits with a code that reflects whether the selected Opportunity can actually become ready
   without help -- see "Exit codes" below. **A failed or suspected-stale Creative Job is a non-zero
   exit**, not a shrug -- Task Scheduler and any future monitoring must not read a blocked
   recommendation as a successful run.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Ready, no-op, or a benign skip (a Creative Job started running less than `CREATIVE_PREP_RUNNING_STALE_AFTER_MS` ago -- likely still active elsewhere). |
| 1 | A genuine operation failure, a Creative Job that actually failed, or a `running` Creative Job whose `started_at` is missing/invalid or at/past the staleness threshold ("suspected stale"). All of these mean the selected Opportunity cannot become ready without an operator. |
| 2 | Preflight abort -- missing Supabase credentials. |
| 3 | Another instance already holds the run lock. |

## Suspected-stale detection is reporting-only -- it never recovers anything

This schema deliberately has no heartbeat, retry-count, or repair mechanism for a Creative Job --
`tests/creative-job-attempts-schema.test.ts` and `tests/asset-job-attempts-schema.test.ts` both
assert the migration SQL contains none. `CREATIVE_PREP_RUNNING_STALE_AFTER_MS` (5 minutes, in
`run.ts`) exists only so this script can tell an operator the difference between "still plausibly
executing" and "long enough that it almost certainly isn't." **It never claims, resets, retries,
or otherwise mutates the Creative Job row** -- confirmed by test (`tests/creative-prep-run.test.ts`
deep-compares the Opportunity and Creative Job rows before and after every running-state case).
Genuine stale-job recovery is a separate, not-yet-scoped proposal, only worth building if real
usage proves it necessary.

## Setup

Reuses Daily Advisor's existing `.env.advisor.local` and its dedicated Supabase Auth worker
account -- if Daily Advisor is already configured on this machine, nothing further is needed here.
See `scripts/daily-advisor/README.md`'s own Setup section for how that file and account were
created.

## Manual run (catch-up)

```
npm run creative-prep
```

Safe to run at any time, including immediately after a failed scheduled run -- every run is
idempotent (see PROP-034's entry in `planning/PROPOSALS.md`), so there is no `--force` flag and
nothing to accidentally duplicate.

## Scheduling

**Not yet registered.** Run manually (above) and verify real output before registering this as a
Scheduled Task -- see "Deployment checklist" below.

Chained a few minutes after Daily Advisor's own trigger, so Daily Advisor's Opportunity-detection
and persistence step has already finished when this runs. Daily Advisor's task fires at 6:00 PM
Arizona time (`US Mountain Standard Time`, this machine's confirmed timezone -- see
`scripts/daily-advisor/README.md`'s own Scheduling section for why that's not the naive-looking
value); this one is set ten minutes after it:

```
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NonInteractive -ExecutionPolicy Bypass -Command "cd ''C:\Users\Admin\Desktop\Vibe code\Coffee and Bakery business\05_App_And_Tech\aly-shin-product-lab''; npm run creative-prep"'
# 6:10 PM Arizona -- ten minutes after Daily Advisor's own 6:00 PM Arizona trigger, giving its
# Opportunity-persistence step time to finish first.
$trigger = New-ScheduledTaskTrigger -Daily -At "6:10PM"
Register-ScheduledTask -TaskName "Aly & Shin Product Lab Creative Prep" -Action $action -Trigger $trigger `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -WakeToRun) `
  -Description "Ensures the newest Opportunity has a ready Creative Package before the owner opens the app. Runs after Daily Advisor."
```

`-WakeToRun` and `-MultipleInstances IgnoreNew` mirror Daily Advisor's own registration for the
same reasons documented there.

**If you ever run this setup on a different machine**, recompute the ten-minute offset from
whatever time Daily Advisor's own task is actually registered at on that machine -- don't assume
6:00 PM Arizona.

## Concurrency and the run lock

Same two-mechanism model as Daily Advisor, reusing the identical lock module:

- **Idempotency** -- calling `runCreativePreparation` again when everything is already ready is a
  safe, cheap no-op by construction (every underlying function it calls already guarantees this;
  nothing new was built to re-derive it). No `-Force`/`--force` flag exists because there is
  nothing to force past.
- **The run lock** (exit 3) -- "is another instance currently running, right now?" A file lock at
  `creative-prep/.run.lock` (`{ pid, startedAt }`), acquired atomically as the first action of
  `run.ts`, before anything else. A stale lock (dead pid, or older than the lock module's own
  staleness window) is recovered automatically -- no manual cleanup needed after a crash.

## Deployment checklist

1. **Run the worker once for real** against Supabase (`npm run creative-prep`) and confirm today's
   dated file, `creative-prep/output/YYYY-MM-DD.jsonl`, shows a real Opportunity reaching
   `outcome: "ready"` with a `creativePackageId`.
2. **Verify in Supabase directly** (or via the Opportunities page) that the selected Opportunity
   now has a `completed` Creative Job and a `ready` Creative Package whose content is real,
   truthful text -- never "MOCK ONLY" or "NON-AI TEST."
3. **Register the Scheduled Task** above.
4. **Confirm registration**, independently of the run itself: `schtasks /query /tn "Aly & Shin
   Product Lab Creative Prep" /v /fo list` (or `Get-ScheduledTask` in PowerShell) -- checks the
   trigger time and command line, not that it has fired yet.
5. **After it has fired at least once on its own**, confirm via `Get-ScheduledTaskInfo` (Last Run
   Time / Last Result) and by checking that day's dated output file.

## Environment variables

Same file, same variables, as `scripts/daily-advisor/README.md`'s own table (`ADVISOR_SUPABASE_URL`,
`ADVISOR_SUPABASE_ANON_KEY`, `ADVISOR_SUPABASE_EMAIL`, `ADVISOR_SUPABASE_PASSWORD`,
`ADVISOR_TIMEZONE`) -- reused directly, nothing new introduced.

## Testing

- `tests/creative-prep-run.test.ts` -- the orchestration core (`runCreativePreparation`), every
  state-table row, idempotency, and every stale-running sub-case, against dependency-injected fake
  clients. No real Supabase call, ever, in this file.
- `tests/creative-prep-cli.test.ts` -- the CLI shell (`runCreativePrepCli`): lock refusal, stale-lock
  reuse, lock release on every exit path, JSONL history preservation, and `latest.json` behavior,
  against real temporary directories but a fake Supabase client. No real Supabase call here either.
