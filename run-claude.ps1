# Overnight automation launcher.
# Triggered by Windows Task Scheduler or macOS launchd ("Aly & Shin Product Lab Claude Overnight", 9PM / 2AM).
# Gated behind $AUTOMATION_ENABLED below -- disabled by default.
#
# Claude's job here is PLANNING ONLY: Triage (captures/inbox -> PROPOSALS.md) and converting approved
# planning/BUILD_QUEUE.md items into PLAN.md + TASKS.md (status: codex). It NEVER touches the app's
# own source files ('src', 'supabase-schema.sql') and NEVER invokes Codex -- that split is enforced two ways:
#   1. The Claude session's --allowedTools has no git commit/push -- it literally cannot ship anything.
#   2. This script commits Claude's output itself, but only after checking every changed path against
#      an explicit allow-list (Phase 2b below). Anything outside that list halts uncommitted.
#
# FAIL-FAST: any phase failure (a preflight problem, a halt, a script error, a failed git operation)
# stops the ENTIRE run immediately -- no later phase (digest generation, Codex-ready notice, commits,
# pushes) executes once one has failed. Exit codes: 0 = disabled (expected steady state) or a clean
# completed/idle run, 1 = mid-run halt (something failed after work started), 2 = preflight abort
# (environment/state problem -- nothing was attempted). See docs/09-automation.md.
#
# -Scheduled: pass this switch ONLY from the Windows Scheduled Task action (see
# setup-task-scheduler.ps1). It is the sole signal used to enter the scheduled power-management path
# at the end of a run -- deliberately not inferred from the current time, so a manual/interactive test run
# (e.g. you running ".\run-claude.ps1" by hand to check something) can never power off your machine.
param(
    [switch]$Scheduled
)

# OFF by default, and the installer PRESERVES whatever an existing install already had.
# A fresh app must never start running unattended overnight builds on its install day: nobody has
# validated the pipeline yet, and an autonomous agent shipping to a repo you have not verified is
# not a feature. Flip to $true only after the doctor is green and you have watched one run.
$AUTOMATION_ENABLED = $false   # flip to $true once validated

$projectPath = "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab"
$logFile = "$projectPath\claude-session.log"

Set-Location $projectPath

function Halt-Automation {
    param([string]$Reason)
    Add-Content -Path $logFile -Value "ALERT: $Reason"
    $statusEntry = @"

## $(Get-Date -Format 'yyyy-MM-dd HH:mm') -- AUTOMATION HALTED: $Reason
Investigate before the next scheduled run. Nothing further was committed, pushed, or notified this run.
"@
    Add-Content -Path "$projectPath\STATUS.md" -Value $statusEntry
    Add-Content -Path $logFile -Value "=== Session ended: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (HALTED) ==="
    exit 1
}

# Retry with rebase, not reset (D-047/D-048 addendum, TASK-031) -- found by auditing every
# push-to-main call site after Run-Merge.ps1's own unretried push silently lost a completed merge to
# a race with Dispatch-Commands.ps1's OUTBOX-reply retry logic (D-047). This file's three push sites
# share one helper (unlike the other sites this audit fixed, each in a different file, where this
# repo's convention is to duplicate rather than share a lib) since all three live in one script.
function Push-MainWithRetry {
    param([string]$FailureContext)
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        git push origin main | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        if ($attempt -eq 5) { break }
        git fetch origin | Out-Null
        $rebaseOutput = git rebase origin/main 2>&1
        if ($LASTEXITCODE -ne 0) {
            git rebase --abort | Out-Null
            Halt-Automation "$FailureContext -- push kept losing a race with something else advancing origin/main, and rebasing onto the new tip conflicted.`n$rebaseOutput"
        }
        Start-Sleep -Milliseconds (300 * $attempt)
    }
    Halt-Automation "$FailureContext -- push failed after 5 attempt(s), kept losing the race with something else advancing origin/main."
}

function Get-RepoStateSummary {
    # Best-effort, defensive: this runs even when the failing check is "Repository exists" or "Git
    # available", so every step here has to tolerate git/the repo itself being unusable.
    $repoName = Split-Path $projectPath -Leaf
    $gitOk = [bool](Get-Command git -ErrorAction SilentlyContinue)
    if ($gitOk) {
        try {
            $remoteUrl = git -C $projectPath remote get-url origin 2>$null
            if ($LASTEXITCODE -eq 0 -and $remoteUrl) {
                $repoName = ($remoteUrl -replace '\.git$', '') -replace '.*[/:]', ''
            }
        } catch {}
    }

    $branch = "unknown (git unavailable)"
    $treeSummary = "unknown (git unavailable)"
    if ($gitOk -and (Test-Path (Join-Path $projectPath ".git"))) {
        $b = git -C $projectPath branch --show-current 2>$null
        $branch = if ($LASTEXITCODE -eq 0 -and $b) { $b } else { "unknown" }

        $statusLines = @(git -C $projectPath status --porcelain 2>$null)
        if ($LASTEXITCODE -eq 0) {
            if ($statusLines.Count -eq 0) {
                $treeSummary = "clean"
            } else {
                $untracked = @($statusLines | Where-Object { $_ -match '^\?\?' }).Count
                $modified = $statusLines.Count - $untracked
                $parts = @()
                if ($modified -gt 0) { $parts += "$modified modified" }
                if ($untracked -gt 0) { $parts += "$untracked untracked" }
                $treeSummary = "dirty (" + ($parts -join ", ") + ")"
            }
        } else {
            $treeSummary = "unknown (git status failed)"
        }
    }

    [pscustomobject]@{ Repository = $repoName; Branch = $branch; WorkingTree = $treeSummary }
}

function Abort-Preflight {
    param([string]$CheckName, [string]$Reason, [string[]]$Action, [string[]]$PassedChecks)
    $state = Get-RepoStateSummary
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("")
    $lines.Add("AUTOMATION ABORTED")
    $lines.Add("")
    $lines.Add("Repository:")
    $lines.Add($state.Repository)
    $lines.Add("")
    $lines.Add("Branch:")
    $lines.Add($state.Branch)
    $lines.Add("")
    $lines.Add("Working tree:")
    $lines.Add($state.WorkingTree)
    $lines.Add("")
    $lines.Add("Reason:")
    $lines.Add($Reason)
    $lines.Add("")
    $lines.Add("Required action:")
    foreach ($a in $Action) { $lines.Add($a) }
    $lines.Add("")
    $lines.Add("Phase 0 -- Preflight")
    foreach ($c in $PassedChecks) { $lines.Add("[x] $c") }
    $lines.Add("[ ] $CheckName  <-- failed here")
    Add-Content -Path $logFile -Value ($lines -join "`n")
    Add-Content -Path $logFile -Value "=== Session ended: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (ABORTED) ==="
    exit 2
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value ""
Add-Content -Path $logFile -Value "=== Session started: $timestamp ==="

# Checked first, ahead of the rest of Phase 0 -- this is the normal, expected steady state (disabled
# every night until deliberately enabled), so it exits calmly and quietly rather than running the
# other preflight checks and risking a noisy "ABORTED: working tree is dirty" every single night.
if (-not $AUTOMATION_ENABLED) {
    Add-Content -Path $logFile -Value "Automation disabled (`$AUTOMATION_ENABLED = `$false in run-claude.ps1) -- exiting without touching the repo."
    Add-Content -Path $logFile -Value "=== Session ended: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (disabled) ==="
    exit 0
}

# --- Phase 0: Preflight. All checks must pass before Phase 1 runs -- fail-fast, no partial credit. ---
$passed = @()

# Repository exists
if (-not (Test-Path $projectPath)) {
    Abort-Preflight "Repository exists" "Project path not found: $projectPath" "Verify `$projectPath in run-claude.ps1 points at the actual repository location." $passed
}
if (-not (Test-Path (Join-Path $projectPath ".git"))) {
    Abort-Preflight "Repository exists" "$projectPath is not a git repository (.git not found)." "Verify `$projectPath in run-claude.ps1 points at a valid git checkout." $passed
}
$passed += "Repository exists"

# Git available (checked here, ahead of the branch/tree checks below that need it, even though it's
# listed after them conceptually -- a scheduled task's PATH can be minimal, so this is a real check)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Abort-Preflight "Git available" "The 'git' command is not available on PATH." "Install Git or ensure it is on PATH for the account/session running this scheduled task." $passed
}
$passed += "Git available"

# Correct branch -- aborts rather than auto-checking-out main. Silently switching branches (or
# checking out over a dirty tree) is exactly the failure mode that let a prior run's commits land on
# the wrong branch; requiring a human to put the repo on main is safer than guessing.
$currentBranch = git branch --show-current 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($currentBranch)) {
    Abort-Preflight "Correct branch" "Could not determine the current git branch." @("git checkout main", "git status") $passed
}
if ($currentBranch -ne "main") {
    Abort-Preflight "Correct branch" "Automation only runs from a clean main branch -- repository is on '$currentBranch'." @("git checkout main", "git status") $passed
}
$passed += "Correct branch"

# Working tree clean
$dirty = git status --porcelain 2>$null
if ($LASTEXITCODE -ne 0) {
    Abort-Preflight "Working tree clean" "git status failed unexpectedly." @("Investigate the git repository state manually.") $passed
}
if ($dirty) {
    Abort-Preflight "Working tree clean" "Automation only runs from a clean main branch -- the working tree has uncommitted changes." @("git status", "Commit, stash, or clean the changes shown above before enabling automation.") $passed
}
$passed += "Working tree clean"

# Required scripts exist
foreach ($script in @("tools\Apply-Decisions.ps1", "tools\Generate-Digest.ps1", "tools\Generate-Codex-Notice.ps1")) {
    if (-not (Test-Path (Join-Path $projectPath $script))) {
        Abort-Preflight "Required scripts exist" "Missing required script: $script" "Restore $script from version control before enabling automation." $passed
    }
}
$passed += "Required scripts exist"

# Required environment variables exist -- this script's one true external dependency is the `claude`
# CLI itself being reachable; a Scheduled Task's environment can differ from an interactive shell's.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Abort-Preflight "Required environment variables exist" "The 'claude' CLI is not available on PATH for this session." "Ensure Claude Code is installed and on PATH for the account/session running this scheduled task." $passed
}
$passed += "Required environment variables exist"

Add-Content -Path $logFile -Value "Preflight passed: $($passed -join ', ')."

# Use Claude Pro subscription instead of API key (temporary -- only affects this session)
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$prompt = @'
You are running in autonomous mode. No human is available. Follow WORKFLOW.md for the Triage event.
This run is scoped to two bounded steps below -- you should not need a Checkpoint, but if you must
stop mid-step, write the precise resume point to STATUS.md first.

Read CLAUDE.md, STATUS.md, PLAN.md, and TASKS.md first.

YOUR ROLE THIS RUN IS PLANNING ONLY -- you are acting as Claude (PM / Tech Lead / Architect), never as
Codex (the Implementer). You must NEVER edit the app's own source files ('src', 'supabase-schema.sql') in this
session, and you must NEVER invoke Codex or any other build agent. Committing and pushing is handled by the calling
script, not by you -- do not attempt `git commit` or `git push` (that tool is not available to you this
run). Do not touch the ROADMAP "Do Not Work On" section. Do not delete files (archiving captures is a
git mv).

STEP A -- TRIAGE (route + enrich only; never build, schedule, or prioritize-for-build): for each
captures/inbox/*.md with `status: new` (SKIP any already `status: triaged`), process per WORKFLOW.md
"Triage": categorize, dedupe vs PROPOSALS/ROADMAP/DONE, then ENRICH into the proposal contract in
planning/PROPOSALS.md (status: pending) -- fill EVERY field. LEAD with **> Decision** (the recommended
next action: Approve | Park | Reject | Clarify + a one-line why) so it's actionable from a phone digest,
THEN **> Risk** (Low | High + a one-line why -- High means it touches data/sync/storage, auth,
security, or the AI Dev OS itself, the exact DECISIONS.md D-032 red-zone list applied here at idea
time instead of merge time; everything else is Low; say High whenever genuinely unsure).
Then: goal alignment vs the **Current Objective** in ROADMAP.md (supports/conflicts/mixed + which
North-star goal), expected user value, evidence (recurring friction, dup count, demand signal), effort
+ dependencies + confidence + ambiguity, why now vs later, and a **goal-adjusted** AI-recommended
priority (P0..P3 -- not raw priority; down-weight work that doesn't serve the Current Objective).
Archive each capture to captures/processed/YYYY/MM/<id>.md, mark the inbox file `status: triaged`, and
append a one-line triage summary to STATUS.md. Do NOT write to ROADMAP.md or BUILD_QUEUE.md.

STEP B -- PLAN CONVERSION (approved work only, into TASKS.md -- never build it): for each item in
planning/BUILD_QUEUE.md that does NOT yet have a corresponding `source: BQ-<id>` entry in TASKS.md,
convert it into one or more atomic, independently testable tasks exactly as the interactive "Plan"
command does (see CLAUDE.md's Tech Lead section and Definition of Ready): each new TASKS.md entry needs
objective, owner: codex, status: codex, a `priority: P<n>` field carried verbatim from the source
BUILD_QUEUE item's priority, `depends-on:` (list the TASK ids it needs, or `none`), files, acceptance
criteria, constraints, and verification/test steps -- Codex must never have to infer missing
requirements. PRIORITY ORDER MATTERS: Codex builds the FIRST `status: codex` task in file order, and
the /go autopilot relies on file order == priority order to build P1 before P2 before P3. So when you
add new tasks, place/keep the pending (`status: codex`) tasks in ascending priority order (P1 first,
then P2, then P3; preserve existing relative order within a priority). You may reorder ONLY pending
`status: codex` task blocks to achieve this; never reorder or restatus done/review/blocked/in-progress
tasks. Update PLAN.md's Goal/Approach/Scope/Source/Status to describe the current milestone if this
batch changes it. Skip any BUILD_QUEUE item already reflected in TASKS.md (do not create duplicates),
and skip any item whose build note says deferred (leave those for a human decision). Do not change the
`status` field of any EXISTING TASKS.md entry -- in this step you only ever add new entries (and may
reorder pending codex blocks for priority). If BUILD_QUEUE.md is empty or everything in it is already
reflected in TASKS.md, do nothing for this step.

Stop after STEP A and STEP B -- there is no STEP C. You are done for this run once both steps are
addressed (either acted on, or confirmed there was nothing to do).
'@

# --- Phase 1 (deterministic, pre-plan): apply approval replies into BUILD_QUEUE, if any ---
try { & "$projectPath\tools\Apply-Decisions.ps1" | Tee-Object -FilePath $logFile -Append }
catch { Halt-Automation "Apply-Decisions.ps1 threw an error: $_" }
git add planning/PROPOSALS.md planning/BUILD_QUEUE.md captures/decisions
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "decisions: apply approval replies -> BUILD_QUEUE" | Out-Null
    if ($LASTEXITCODE -ne 0) { Halt-Automation "git commit failed after Apply-Decisions.ps1" }
    Push-MainWithRetry "git push failed after Apply-Decisions.ps1 commit"
}

# --- Phase 2: Claude session -- TRIAGE + PLAN CONVERSION ONLY. No commit/push tool available to it. ---
# The prompt is piped via STDIN, not passed as `claude -p $prompt`: under Windows PowerShell 5.1
# (which the scheduled task runs) a long multi-line string passed as a native-command argument loses
# its tail -- confirmed live, Claude received only the head of this prompt and never saw STEP B, so it
# triaged but never converted BUILD_QUEUE items into tasks. Piping via stdin delivers it intact.
# EAP is lowered to 'Continue' for the call so claude's stderr can't be promoted to a terminating
# exception under $ErrorActionPreference = 'Stop'; $LASTEXITCODE is still checked below.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $prompt | claude -p `
        --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(git status)" "Bash(git diff *)" "Bash(git log *)" `
        2>$null | Tee-Object -FilePath $logFile -Append
} finally {
    $ErrorActionPreference = $prevEAP
}
if ($LASTEXITCODE -ne 0) { Halt-Automation "claude -p exited with code $LASTEXITCODE" }

# --- Phase 2a-bis (deterministic, D-042): auto-promote Decision:Approve + Risk:Low proposals
#     straight into BUILD_QUEUE.md, no human reply needed. Runs on EVERY pending proposal currently
#     in PROPOSALS.md, not just ones this session just triaged -- so an old proposal sitting from
#     before this existed also gets picked up once it has both fields. Anything else (any other
#     Decision, Risk: High, or no Risk field at all) is untouched and still needs a human reply via
#     Apply-Decisions.ps1, exactly as before. No LLM call -- see tools/Invoke-AutoPromote.ps1. ---
try { & "$projectPath\tools\Invoke-AutoPromote.ps1" | Tee-Object -FilePath $logFile -Append }
catch { Halt-Automation "Invoke-AutoPromote.ps1 threw an error: $_" }

# --- Phase 2b (deterministic): commit-scope guard. The Claude session above cannot commit or push
#     itself; this script is the only thing that ever commits its output, and only after checking
#     every changed path against the allow-list below. Anything outside it halts the ENTIRE run --
#     fail-fast: no digest, no Codex-ready notice, no further commits/pushes happen after a halt. ---
$allowedPatterns = @(
    '^PLAN\.md$', '^TASKS\.md$', '^STATUS\.md$',
    '^planning/BUILD_QUEUE\.md$', '^planning/PROPOSALS\.md$', '^planning/DIGEST\.md$', '^planning/CODEX_READY\.md$',
    '^captures/'
)
$changed = @(git status --porcelain | ForEach-Object { $_.Substring(3).Trim() } | Where-Object { $_ })
$violations = @($changed | Where-Object { $path = $_; -not ($allowedPatterns | Where-Object { $path -match $_ }) })

if ($violations.Count -gt 0) {
    Halt-Automation "Claude session touched file(s) outside the allowed planning surface: $($violations -join ', '). NOT committing or pushing -- working tree left as-is for human review."
} elseif ($changed.Count -gt 0) {
    git add -- $changed
    git commit -m "plan: triage + BUILD_QUEUE -> PLAN/TASKS (automated)" | Out-Null
    if ($LASTEXITCODE -ne 0) { Halt-Automation "git commit failed for plan-conversion changes" }
    Push-MainWithRetry "git push failed for plan-conversion changes"
} else {
    Add-Content -Path $logFile -Value "No planning changes this run."
}

# --- Phase 3 (deterministic, post-run): only reached if nothing above halted. Refreshes the
#     proposals digest + Codex-ready notice for n8n's next morning send. ---
try { & "$projectPath\tools\Generate-Digest.ps1" | Out-Null } catch { Halt-Automation "Generate-Digest.ps1 threw an error: $_" }
try { & "$projectPath\tools\Generate-Codex-Notice.ps1" | Out-Null } catch { Halt-Automation "Generate-Codex-Notice.ps1 threw an error: $_" }

# --- Phase 3b (deterministic, D-045): docs-vs-code drift check, run every automation cycle instead of
#     requiring someone to remember to run it by hand -- that gap is exactly how docs drift silently.
#     Non-fatal: drift is a hygiene finding, not a safety issue, so it never halts automation. Findings
#     are appended to DIGEST.md (already sent to Telegram every morning, unconditionally) so they
#     actually get seen instead of sitting unread in claude-session.log. ---
try {
    $docsDriftOutput = & "$projectPath\tools\Check-DocsConsistency.ps1" 2>&1
    $docsDriftExit = $LASTEXITCODE
    $docsDriftOutput | Tee-Object -FilePath $logFile -Append | Out-Null
    if ($docsDriftExit -ne 0) {
        Add-Content -Path "$projectPath\planning\DIGEST.md" -Value "`n—`n⚠️ Docs drift detected (Check-DocsConsistency.ps1) — see claude-session.log for details."
    }
} catch { Halt-Automation "Check-DocsConsistency.ps1 threw an error: $_" }

git add planning/DIGEST.md planning/CODEX_READY.md
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "digest: refresh proposals digest + codex-ready notice" | Out-Null
    if ($LASTEXITCODE -ne 0) { Halt-Automation "git commit failed for digest/codex-ready refresh" }
    Push-MainWithRetry "git push failed for digest/codex-ready refresh"
}

$endTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "=== Session ended: $endTime ==="

# Shutdown is gated on -Scheduled, not on the current time -- see the param() comment at the top of
# this file. Only shuts down after the 2AM run (not 9PM -- you may still be using the PC then), and
# only if there was actually planning work to commit (an idle run -- nothing in inbox, nothing new in
# BUILD_QUEUE -- leaves $changed empty, so there's no reason to force a shutdown). We can only reach
# this line if nothing halted or aborted the run above.
$hour = (Get-Date).Hour
if (-not $Scheduled) {
    Add-Content -Path $logFile -Value "Automation completed successfully. Shutdown skipped (interactive mode)."
} elseif ($hour -ge 6) {
    Add-Content -Path $logFile -Value "Automation completed successfully. Shutdown skipped (scheduled run outside the overnight window)."
} elseif ($changed.Count -eq 0) {
    Add-Content -Path $logFile -Value "Automation completed successfully (idle run, nothing to commit). Shutdown skipped."
} else {
    # SLEEP -- never `shutdown /s` (S5). A powered-OFF PC cannot be woken by a Task Scheduler wake
    # timer, which would strand every queued Telegram command until someone physically pressed the
    # power button. Sleep (S3) / hibernate (S4) are both wakeable, so the Command Dispatcher's
    # WakeToRun timer can wake the machine, drain the queue (build/review/merge), and let it idle
    # back to sleep. Same power saving, without cutting off remote work. See DECISIONS D-033.
    # Platform. PowerShell 7 defines $IsWindows; Windows PowerShell 5.1 does NOT (it is $null, which
    # is FALSY) -- so check for null explicitly, or 5.1 would take the macOS branch and never sleep.
    $onWin = if ($null -eq $IsWindows) { $true } else { $IsWindows }

    if ($onWin) {
        Add-Content -Path $logFile -Value "=== Sleeping PC (wakeable by the Command Dispatcher wake timer) ==="
        rundll32.exe powrprof.dll,SetSuspendState 0,1,0
    } else {
        # macOS DELIBERATELY DOES NOT SLEEP HERE, and this is a real design difference -- not an
        # oversight, and not a straight translation of the Windows behaviour.
        #
        # Windows can be woken by a Task Scheduler timer every 30 minutes (WakeToRun), so it sleeps
        # deeply and wakes to drain the queue. macOS has no equivalent: `pmset repeat wakeorpoweron`
        # supports exactly ONE repeating wake per day. A Mac that sleeps would therefore sit on a
        # queued /go until someone touched it -- the exact failure D-033 exists to prevent, and it
        # would be silent.
        #
        # So on macOS the machine stays awake and launchd's 30-minute interval fires reliably. On a
        # Mac mini -- a desktop that sits there anyway, idling around 7W -- that is the right trade:
        # a few watts for a remote loop that actually works. The display still sleeps.
        Add-Content -Path $logFile -Value "=== macOS: staying awake so the launchd dispatcher can fire (no WakeToRun equivalent -- see D-038) ==="
    }
}
