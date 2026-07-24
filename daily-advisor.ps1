# Daily AI Advisor launcher -- intended for Windows Task Scheduler ("Aly & Shin Product Lab
# Daily Advisor", recommended 9:00 AM Asia/Manila -- see scripts/daily-advisor/README.md), but
# safe to run manually at any time.
#
# Modeled after run-claude.ps1's shape (fail-fast preflight, structured log, clear exit codes) but
# deliberately lighter in one specific way: this script does NOT require the repo to be on `main`
# with a clean working tree. Unlike run-claude.ps1, it never commits anything to whatever branch
# is currently checked out here -- all of its git writes happen inside a separate, dedicated
# worktree checked out to automation/daily-advisor (see Phase 2), so a developer mid-feature-branch
# work is never blocked from getting their morning briefing.
#
# Exit codes (same convention as run-claude.ps1, plus one new code): 0 = clean run (briefing
# generated+published, or nothing new to do), 1 = mid-run failure, 2 = preflight abort (nothing
# was attempted), 3 = another instance already holds the run lock (nothing was attempted).
param(
    [ValidateSet("supabase", "sample")]
    [string]$Source = "supabase",
    [switch]$Force,
    [switch]$SkipClaude
)

$projectPath = "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
$logFile = "$projectPath\daily-advisor-session.log"
$artifactBranch = "automation/daily-advisor"
$worktreePath = Join-Path $projectPath ".worktrees\daily-advisor"
$lockPath = Join-Path $projectPath "daily-advisor\.run.lock"
$lockStaleAfterMinutes = 60

Set-Location $projectPath

function Write-Log {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

function Abort-Preflight {
    param([string]$Reason)
    Write-Log "PREFLIGHT ABORT: $Reason"
    exit 2
}

# --- Single-instance lock, spanning BOTH generation (Phase 1, invoking node) and publication
#     (Phase 2) as one critical section -- the two phases together are what must never overlap
#     with another full run. run.ts acquires this exact same lock file itself when invoked
#     directly (e.g. `npm run advisor`, which never publishes), so a manual node run and a
#     launcher-orchestrated run correctly detect and reject each other if truly concurrent. When
#     THIS script invokes node (Phase 1 below), it sets ADVISOR_LOCK_OWNED_EXTERNALLY=1 so run.ts
#     doesn't try to acquire the same lock a second time under a different pid and reject itself.
function Test-ProcessAlive {
    param([int]$ProcessId)
    try { Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}

function Test-LockStale {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $true }
    try {
        $info = Get-Content $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $true  # malformed lock file -- never block forever on a file we can't read
    }
    if (-not $info.pid -or -not $info.startedAt) { return $true }
    try {
        $age = (Get-Date) - [datetime]$info.startedAt
    } catch {
        return $true
    }
    if ($age.TotalMinutes -gt $lockStaleAfterMinutes) { return $true }
    return -not (Test-ProcessAlive -ProcessId $info.pid)
}

# Never bypassable by -Force -- -Force is only ever consulted later, as a node argument that
# affects the separate same-day idempotency check inside run.ts. This function runs first and
# unconditionally.
function Acquire-RunLock {
    param([string]$Path)
    if ((Test-Path $Path) -and -not (Test-LockStale -Path $Path)) {
        $info = Get-Content $Path -Raw | ConvertFrom-Json
        Write-Log "LOCK REJECTED: another instance is already running (pid $($info.pid), started $($info.startedAt))."
        exit 3
    }
    if (Test-Path $Path) {
        Write-Log "Recovering stale lock at $Path (dead pid or older than $lockStaleAfterMinutes minutes)."
        Remove-Item $Path -Force -ErrorAction SilentlyContinue
    }
    $payload = @{ pid = $PID; startedAt = (Get-Date).ToString("o") } | ConvertTo-Json -Compress
    try {
        # New-Item without -Force fails if the file already exists -- the same atomic
        # exclusive-create race protection run.ts's lock.ts gets from the wx flag.
        New-Item -ItemType File -Path $Path -ErrorAction Stop | Out-Null
        Set-Content -Path $Path -Value $payload -NoNewline
    } catch {
        Write-Log "LOCK REJECTED: lost a race acquiring the lock (concurrent run)."
        exit 3
    }
}

function Release-RunLock {
    param([string]$Path)
    if (Test-Path $Path) {
        try {
            $info = Get-Content $Path -Raw | ConvertFrom-Json
            if ($info.pid -eq $PID) {
                Remove-Item $Path -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
}

Write-Log "=== Daily Advisor run started (Source=$Source Force=$Force SkipClaude=$SkipClaude) ==="

# --- Phase 0: Preflight ---
if (-not (Test-Path $projectPath)) { Abort-Preflight "Project path not found: $projectPath" }
if (-not (Test-Path (Join-Path $projectPath ".git"))) { Abort-Preflight "$projectPath is not a git repository." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Abort-Preflight "'git' is not available on PATH." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Abort-Preflight "'node' is not available on PATH." }
$runScript = Join-Path $projectPath "scripts\daily-advisor\run.ts"
if (-not (Test-Path $runScript)) { Abort-Preflight "Missing scripts/daily-advisor/run.ts." }
if ($Source -eq "supabase" -and -not (Test-Path (Join-Path $projectPath ".env.advisor.local"))) {
    Abort-Preflight ".env.advisor.local not found -- required for --source supabase. Copy .env.advisor.local.example and fill in real credentials, or run with -Source sample."
}
Write-Log "Preflight passed."

New-Item -ItemType Directory -Force -Path (Join-Path $projectPath "daily-advisor") | Out-Null
Acquire-RunLock -Path $lockPath
Write-Log "Run lock acquired (pid $PID)."

try {
    # --- Phase 1: run the worker ---
    $nodeArgs = @($runScript, "--source", $Source)
    if ($Force) { $nodeArgs += "--force" }
    if ($SkipClaude) { $nodeArgs += "--skip-claude" }

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $env:ADVISOR_LOCK_OWNED_EXTERNALLY = "1"
    try {
        & node @nodeArgs 2>&1 | Tee-Object -FilePath $logFile -Append
    } finally {
        $ErrorActionPreference = $prevEAP
        Remove-Item Env:ADVISOR_LOCK_OWNED_EXTERNALLY -ErrorAction SilentlyContinue
    }
    $workerExitCode = $LASTEXITCODE

    if ($workerExitCode -eq 2) {
        Write-Log "Worker aborted at preflight (exit 2). Nothing to publish."
        exit 2
    }
    if ($workerExitCode -ne 0) {
        Write-Log "Worker failed (exit $workerExitCode). Not publishing -- see log above for the reason (Supabase failure, write failure, etc.)."
        exit 1
    }
    Write-Log "Worker completed (exit 0)."

    # --- Phase 2: publish daily-advisor/output/ to the dedicated artifact branch, never to main ---
    # Deliberately a plain branch (not orphan), created once from main's tip and only ever appended
    # to by this script -- "lightweight" here means no PR, no merge back into main, just a
    # fast-forward commit+push loop, since this branch's only purpose is to be a stable path n8n
    # can raw-read from.
    git fetch origin --quiet 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null

    git show-ref --verify --quiet "refs/heads/$artifactBranch"
    $localBranchExists = ($LASTEXITCODE -eq 0)
    git show-ref --verify --quiet "refs/remotes/origin/$artifactBranch"
    $remoteBranchExists = ($LASTEXITCODE -eq 0)

    if (-not (Test-Path $worktreePath)) {
        if ($localBranchExists) {
            git worktree add $worktreePath $artifactBranch 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
        } elseif ($remoteBranchExists) {
            git worktree add -b $artifactBranch $worktreePath "origin/$artifactBranch" 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
        } else {
            Write-Log "Creating $artifactBranch for the first time, branched from main."
            git worktree add -b $artifactBranch $worktreePath main 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
        }
        if ($LASTEXITCODE -ne 0) { Write-Log "git worktree add failed (exit $LASTEXITCODE)."; exit 1 }
    } else {
        # Steady state: keep the worktree in sync with origin before writing to it. Safe to reset
        # hard -- nothing but this script (serialized by the lock above) ever commits here.
        if ($remoteBranchExists) {
            git -C $worktreePath fetch origin --quiet 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
            git -C $worktreePath reset --hard "origin/$artifactBranch" --quiet 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
        }
    }

    $srcOutput = Join-Path $projectPath "daily-advisor\output"
    $destOutput = Join-Path $worktreePath "daily-advisor\output"
    New-Item -ItemType Directory -Force -Path $destOutput | Out-Null
    Copy-Item -Path (Join-Path $srcOutput "*") -Destination $destOutput -Recurse -Force

    # force-add: daily-advisor/output/ is gitignored on main (and this branch inherited that
    # .gitignore at creation time) since generated reports must never be committed to main -- this
    # is the one branch where these specific files ARE meant to be tracked.
    git -C $worktreePath add -f daily-advisor/output 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
    git -C $worktreePath diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Log "Nothing new to publish -- $artifactBranch already up to date."
        exit 0
    }

    git -C $worktreePath commit -m "briefing: update daily-advisor/output" 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Log "git commit failed on $artifactBranch."; exit 1 }

    # Retry with rebase, not reset -- resetting hard here would discard the commit just made above
    # if a push attempt failed after the commit already succeeded (same reasoning as
    # run-claude.ps1's Push-MainWithRetry, duplicated rather than shared since it's this file's
    # only push site).
    $pushed = $false
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        git -C $worktreePath push origin $artifactBranch 2>&1 | Tee-Object -FilePath $logFile -Append | Out-Null
        if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
        if ($attempt -eq 5) { break }
        git -C $worktreePath fetch origin --quiet 2>&1 | Out-Null
        $rebaseOutput = git -C $worktreePath rebase "origin/$artifactBranch" 2>&1
        if ($LASTEXITCODE -ne 0) {
            git -C $worktreePath rebase --abort 2>&1 | Out-Null
            Write-Log "git rebase onto origin/$artifactBranch conflicted -- leaving the worktree as-is for manual review.`n$rebaseOutput"
            exit 1
        }
        Start-Sleep -Milliseconds (300 * $attempt)
    }

    if (-not $pushed) {
        Write-Log "git push to $artifactBranch failed after 5 attempts."
        exit 1
    }

    Write-Log "Published to $artifactBranch."
    Write-Log "=== Daily Advisor run finished (exit 0) ==="
    exit 0
} finally {
    # Runs on every exit path out of the try block above, including `exit N` (PowerShell runs
    # pending finally blocks before an in-script exit terminates the process) and any uncaught
    # terminating error -- the lock is always released, or the next run recovers it as stale.
    Release-RunLock -Path $lockPath
    Write-Log "Run lock released."
}
