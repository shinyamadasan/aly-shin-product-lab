# Run this ONCE to register the Creative AI background worker with Windows Task Scheduler.
#
#   Right-click PowerShell -> "Run as Administrator", then:
#     pwsh -File "scripts\creative-workers\install-background-worker.ps1"
#
# To remove it later:
#     Unregister-ScheduledTask -TaskName "Aly & Shin Product Lab Creative AI Worker" -Confirm:$false
#
# WHAT THIS REGISTERS
#
#   A one-shot process, every minute, that processes at most ONE queued creative_ai Creative Job
#   and exits. It is not a daemon and holds nothing between runs. If the machine is off or asleep,
#   jobs simply stay queued -- nothing fails and nothing is lost.
#
# WHY EVERY MINUTE
#
#   The Content MVP does not need sub-minute pickup. A job queued by the owner is picked up within
#   0-60 seconds, then normal generation takes roughly 20-40 seconds. Overlapping runs are expected
#   and harmless: the worker takes a local lock and a second invocation exits cleanly (exit 0), and
#   the database claim RPC remains the real protection against a job being executed twice.
#
# WHY -WakeToRun IS *NOT* SET (deliberate, unlike the command-dispatcher task)
#
#   A one-minute trigger with WakeToRun would wake this PC ~1440 times a day and defeat sleep
#   entirely. Content generation is not urgent enough to justify that. The machine sleeps; queued
#   jobs wait; -StartWhenAvailable picks them up once it is awake again.
#
# WHY IT RUNS AS THE LOGGED-ON USER
#
#   Claude CLI and Codex CLI authenticate through SUBSCRIPTION sessions stored in this user's
#   profile (~/.claude, ~/.codex). SYSTEM or another account has no such session, so the task must
#   run as the owner. No API key exists or is wanted.
#
# PATH (audited, not assumed)
#
#   Task Scheduler does NOT source an interactive shell profile. It builds the process environment
#   from the registry instead: machine PATH + this user's PATH. All three binaries this worker needs
#   are already on those persistent paths, so no PATH manipulation is needed here:
#
#     node    C:\Program Files\nodejs\                                  (machine PATH)
#     claude  %APPDATA%\npm                                             (user PATH)
#     codex   %LOCALAPPDATA%\Programs\OpenAI\Codex\bin                  (user PATH)
#
#   The preflight below verifies all three resolve before the task is registered, so a missing tool
#   is reported now rather than discovered as silent failures at 3am.
#
# SECRETS
#
#   None are embedded here, passed as arguments, or logged. The worker loads Supabase credentials
#   from .env.advisor.local -- the same file every other scheduled script in this repo already uses.

$ErrorActionPreference = 'Stop'

$taskName = "Aly & Shin Product Lab Creative AI Worker"

# Derived from this script's own location -- never a hardcoded personal path, so the task is
# correct in a clone, a worktree, or a moved checkout. scripts\creative-workers\ -> repo root.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# --------------------------------------------------------------------------- preflight
if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    Write-Host "FAILED: no package.json at $repoRoot -- this script must live in the repository." -ForegroundColor Red
    exit 1
}

$packageName = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).name
if ($packageName -ne 'aly-shin-product-lab') {
    Write-Host "FAILED: $repoRoot is package '$packageName', not 'aly-shin-product-lab'." -ForegroundColor Red
    Write-Host "        Refusing to schedule a worker against the wrong repository." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $repoRoot '.env.advisor.local'))) {
    Write-Host "WARNING: .env.advisor.local not found at $repoRoot." -ForegroundColor Yellow
    Write-Host "         The worker needs it for Supabase credentials and will exit 2 without it." -ForegroundColor Yellow
}

# The three executables the scheduled process must be able to find. Checked here so a PATH problem
# surfaces at install time, in front of a human, instead of as a nightly silent no-op.
foreach ($tool in 'node', 'claude', 'codex') {
    $found = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Host "FAILED: '$tool' is not on PATH for this user." -ForegroundColor Red
        Write-Host "        The scheduled task inherits the registry PATH, so it would not find it either." -ForegroundColor Red
        exit 1
    }
    Write-Host ("  {0,-8} {1}" -f $tool, $found.Source) -ForegroundColor DarkGray
}

$nodePath = (Get-Command node).Source

# --------------------------------------------------------------------------- register
# Safe to re-run: the existing task is removed first.
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# node is invoked directly rather than through `npm run`, so there is no shell, no npm wrapper
# process, and no argument re-tokenisation between Task Scheduler and the worker.
#
# -WorkingDirectory is set EXPLICITLY to the repo root. Task Scheduler otherwise defaults to
# %SystemRoot%\System32, which is how a scheduled job ends up resolving relative paths against the
# wrong project entirely -- the exact mistake class the worker's own package.json identity guard
# also defends against.
$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument 'scripts\creative-workers\background-worker.ts' `
    -WorkingDirectory $repoRoot

# Every minute, indefinitely, starting now.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# IgnoreNew: Task Scheduler itself refuses to start a second copy while one is running. The worker's
# own file lock still exists as the real guarantee, because a scheduler restart or a crashed run can
# defeat this setting -- belt and braces on a one-minute cadence.
#
# ExecutionTimeLimit 20 min sits just above the worker's 15-minute creative_ai outer ceiling, so a
# genuinely wedged process is terminated by Windows rather than surviving as a zombie.
#
# No -WakeToRun: see the header.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Processes at most one queued creative_ai Creative Job per run, every minute, using the local Claude and Codex CLI subscriptions. One-shot process, not a daemon." `
    -Force | Out-Null

Write-Host ""
Write-Host "Task registered: '$taskName'" -ForegroundColor Green
Write-Host "  Repo:      $repoRoot" -ForegroundColor Green
Write-Host "  Runs:      every 1 minute (no WakeToRun -- the PC is allowed to sleep)" -ForegroundColor Green
Write-Host "  Per run:   at most 1 queued creative_ai job, processed serially" -ForegroundColor Green
Write-Host ""
Write-Host "Verify:    Get-ScheduledTask -TaskName '$taskName'" -ForegroundColor Cyan
Write-Host "Run once:  Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Cyan
Write-Host "Remove:    Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false" -ForegroundColor Cyan
