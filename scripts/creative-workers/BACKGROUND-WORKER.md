# Creative AI Background Worker (S3D)

Processes queued `creative_ai` Creative Jobs automatically on this machine, so the owner does not
have to run the worker by hand. This is the practical operator guide; the execution architecture it
invokes belongs to S3E-A2 and is not re-explained here.

**It changes nothing about how a job runs.** Claim, AI execution, provider routing, retries,
persistence and package materialization are all the existing, already-proven path. This worker only
decides *when* to invoke it.

```
Task Scheduler (~1/min) -> one-shot node process -> lock -> at most 1 job -> exit
```

## What it does, in order

0. **Repository identity check.** Reads `package.json` and refuses to continue unless the name is
   `aly-shin-product-lab` (exit 2). Runs *before* any credential or Supabase access, so a worker
   pointed at the wrong project never touches the database.
1. **Acquires a single-instance run lock** (`creative-ai-worker/.run.lock`). If another run holds it,
   logs the skip and exits **0** — see "Exit codes" below for why this is not an error.
2. **Loads Supabase credentials** from `.env.advisor.local` — the same file Daily Advisor and
   Creative Prep already use. No new credentials and no new secret store.
3. **Reads the queue**: `status = queued` AND `worker_type = creative_ai`, limit 1. Other worker
   types and non-queued jobs are filtered in the query, not after fetching.
4. **Runs at most one job**, through the existing trusted runner and the real `creative_ai` executor.
5. **Releases the lock and exits.**

## Deliberate design choices

**Not a daemon.** No `while(true)`, no service, no PM2, no listener. A short-lived process that
exits means crashes and code updates are uneventful — nothing to restart, nothing holding stale code
in memory, and a machine that is off simply does not run it.

**One job per run.** The AI is subscription-backed and local. Draining a queue would fire several
expensive generations back to back and spike quota for no MVP benefit. At a one-minute cadence a
backlog still drains steadily.

**Serial, never concurrent.** Two generations at once would contend for the same local CLI
subscription session and double the quota burst. There is no `Promise.all` over jobs anywhere.

**No scheduler-level retry.** If a job fails, the runner has already persisted that honestly
(status, bounded error message, execution trace). The worker does not requeue it, does not retry the
AI, and does not touch provider behaviour — that is S3C-D's business. A job that is no longer
`queued` is simply not seen again.

## Two locks, two different jobs

| | Protects against | Owner |
|---|---|---|
| `creative-ai-worker/.run.lock` | needless overlapping scheduled workers **on this machine** | this worker |
| `claim_creative_job_with_attempt` | the same job being executed twice, **ever** | the database |

The database claim RPC is the real correctness guarantee. The file lock is an operational nicety.

**Stale-lock threshold: 30 minutes.** Comfortably longer than the 15-minute `creative_ai` outer
executor ceiling, so a healthy long run is never mistaken for a dead one — and well under the shared
60-minute default, because on a one-minute cadence an hour-long dead lock would silently disable
generation for an hour. The age threshold is only the backstop: a lock whose recorded PID is no
longer alive is reclaimed on the very next run, so an ordinary crash recovers in ~60 seconds.

## Exit codes

| Code | Meaning |
|---|---|
| **0** | Ran normally — including *nothing queued*, *another run holds the lock*, and *the job itself failed and was persisted as failed* |
| **1** | Infrastructure failure (queue unreadable, sign-in failed, unexpected crash) |
| **2** | Preflight abort (wrong repository, missing Supabase credentials) |

A held lock exits **0 on purpose**, unlike Creative Prep's exit 3. That script runs nightly, where an
overlap is genuinely notable. This one runs every minute against generations that take tens of
seconds, so overlaps are routine — reporting each as a task failure would fill Task Scheduler's
history with red and train the owner to ignore it.

## Offline behaviour

If the machine is off, asleep, or disconnected, queued jobs simply **stay queued**. Nothing is marked
failed merely because the worker was unavailable. `-StartWhenAvailable` picks them up on the next
wake.

## Running it manually

```
npm run creative-ai:worker
```

Expected on an empty queue: lock acquired → `queued creative_ai jobs found: 0` → lock released →
exit 0, in roughly 2–3 seconds including Node startup.

## Scheduling it

```powershell
# Run once, from an Administrator PowerShell:
pwsh -File "scripts\creative-workers\install-background-worker.ps1"
```

The script derives the repository root from its own location (never a hardcoded personal path),
verifies the package name, preflights that `node`, `claude` and `codex` all resolve, and registers a
task that runs **every minute** with the working directory set explicitly to the repo root.

**Remove it again:**

```powershell
Unregister-ScheduledTask -TaskName "Aly & Shin Product Lab Creative AI Worker" -Confirm:$false
```

### Why it runs as the logged-on user

Claude CLI and Codex CLI authenticate through **subscription sessions stored in this user's profile**
(`~/.claude`, `~/.codex`). SYSTEM or any other account has no such session. There is no API key and
none is wanted.

### PATH (audited, not assumed)

Task Scheduler does not source an interactive shell profile — it builds the process environment from
the registry: machine PATH plus this user's PATH. All three required binaries are already on those
persistent paths, so the setup script needs no PATH manipulation:

| Tool | Location | Which PATH |
|---|---|---|
| `node` | `C:\Program Files\nodejs\` | machine |
| `claude` | `%APPDATA%\npm` | user |
| `codex` | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` | user |

The install script verifies all three resolve before registering anything, so a missing tool is
reported to a human at install time rather than discovered as silent 3am failures.

### Why no `-WakeToRun`

A one-minute trigger with `-WakeToRun` would wake this PC ~1440 times a day and defeat sleep
entirely. Content generation is not urgent enough to justify that. The machine sleeps; queued jobs
wait.

## Logging

Operational only: worker started, lock acquired/skipped, queued jobs found, job id and outcome,
duration, infrastructure errors. **Never** prompts, model output, provider stdout/stderr,
credentials, or environment contents. This is not a telemetry system.
