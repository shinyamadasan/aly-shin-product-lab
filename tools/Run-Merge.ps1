<#
.SYNOPSIS
  /merge phase runner -- lands a HELD red-zone branch, from the phone, in two steps.

.DESCRIPTION
  A task at `status: approved` is approved but RED-ZONE (data/sync/storage, auth, security, the AI
  Dev OS itself). D-032 deliberately refuses to auto-merge those: a broken UI change is reverted in
  a minute, but lost user data cannot be reverted at all.

  The gate's real purpose is "a human LOOKED at what this touches" -- not "a human was sitting at a
  desk." Being at a keyboard was never the safety property, so this runner removes the desk and
  keeps the looking:

    /merge TASK-014        -> shows WHAT IT TOUCHES (diff stat + the reviewer's own recorded reason
                              for holding it) and merges NOTHING.
    /merge TASK-014 yes    -> re-verifies every gate, then fast-forwards main and pushes.

  The summary step is the whole point. It makes skipping the diff a deliberate act rather than a
  reflex. `/merge TASK-014` alone can never change main, so a fat-fingered command is harmless.

  Gates are IDENTICAL to Run-Claude-Review.ps1's auto-merge -- deliberately. A red-zone merge must
  never be held to a LOWER standard than a reversible one just because it arrived by text message:
    1. task exists and is `status: approved`  (never `codex`/`review`/`done`)
    2. main is clean
    3. branch exists and is clean
    4. npm test passes on the branch
    5. npm test left the tree clean
    6. main is an ancestor of the branch (a true fast-forward -- never a merge commit) -- if not,
       the branch is auto-rebased onto main and force-pushed (D-044); a real conflict still blocks
       and asks a human, this only closes the gap the dispatcher's own bookkeeping commit opens

  Writes its result to .last-phase-result.txt for Dispatch-Commands.ps1 to relay to Telegram.
#>
param(
    [Parameter(Mandatory = $true)] [string] $TaskId,
    [switch] $Confirm,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$root       = Split-Path $PSScriptRoot -Parent
$tasksFile  = Join-Path $root 'TASKS.md'
$reviewFile = Join-Path $root 'REVIEW.md'
$logFile    = Join-Path $root 'claude-session.log'
$resultFile = Join-Path $root '.last-phase-result.txt'
$utf8       = New-Object System.Text.UTF8Encoding $false

function Write-Result([string]$Text) {
    [System.IO.File]::WriteAllText($resultFile, $Text, $utf8)
    Write-Host $Text
}
# $ErrorActionPreference = 'Stop' (below) promotes ANY stderr text from a native command -- even
# routine progress output like git rebase's "Rebasing (1/1)" -- into a terminating exception, even
# when the command's own exit code is 0. Confirmed live: this crashed the whole script the first
# time the new auto-rebase step (below) ran `git rebase`, mid-merge, on a real branch. Lowering EAP
# for the duration of the call (matching Dispatch-Commands.ps1's own Invoke-Git) fixes it without
# swallowing stderr at the source, so callers that actually want it (e.g. the auto-rebase conflict
# message) can still capture it via their own `2>&1`.
function Invoke-Git {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @args }
    finally { $ErrorActionPreference = $prevEAP }
}

$TaskId = $TaskId.ToUpper()
if ($TaskId -notmatch '^TASK-\d+$') {
    Write-Result "Usage: /merge TASK-014   (then: /merge TASK-014 yes)"
    exit 2
}
$branchName = 'task-' + ($TaskId -replace '^TASK-', '')

# ---------------------------------------------------------------- 1. the task must be HELD
if (-not (Test-Path $tasksFile)) { Write-Result "No TASKS.md found."; exit 2 }
$tasksText = [System.IO.File]::ReadAllText($tasksFile, $utf8)

# Ignore the commented-out task template at the bottom, exactly as the dispatcher does -- otherwise
# the literal example task ("TASK-001 - <short title>") parses as a real, mergeable task.
$body = ($tasksText -split '<!-- TASK TEMPLATE')[0]

$blk = [regex]::Match($body, "(?ms)^###\s+$TaskId\b.*?(?=^###\s|\z)")
if (-not $blk.Success) { Write-Result "$TaskId is not in TASKS.md."; exit 2 }

$statusM = [regex]::Match($blk.Value, '(?m)^status:\s*(?<v>\S+)')
$status  = if ($statusM.Success) { $statusM.Groups['v'].Value } else { '?' }
# THIS FILE MUST STAY PURE ASCII. PowerShell 5.1 reads a BOM-less .ps1 using the system ANSI
# codepage, so a literal en/em dash here decodes into garbage -- an em-dash's UTF-8 bytes end in
# 0x94, which is a curly quote in CP1252, and that stray quote breaks the enclosing string and the
# whole file stops parsing. \p{Pd} is the Unicode "dash punctuation" property, written in ASCII,
# and matches -, en-dash and em-dash alike. (This bug has now bitten this codebase three times.)
$titleM  = [regex]::Match($blk.Value, "(?m)^###\s+$TaskId\s*(?<v>.+)$")
$title   = if ($titleM.Success) { ($titleM.Groups['v'].Value.Trim() -replace '^[\p{Pd}\u00B7\u2022]\s*', '') } else { '' }

if ($status -ne 'approved') {
    Write-Result @"
$TaskId is 'status: $status' -- /merge only lands HELD red-zone tasks ('status: approved').

  approved = approved but red-zone -> held for you (this is what /merge is for)
  done     = approved and reversible -> already auto-merged, nothing to do
  review   = still waiting on Claude's verdict -- send /review
  codex    = needs rework -- send /go
"@
    exit 2
}

# ---------------------------------------------------------------- 2. the branch must exist
Invoke-Git -C $root rev-parse --verify $branchName 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Result "$TaskId is approved, but branch '$branchName' does not exist. Nothing to merge."
    exit 2
}

# ================================================================ SUMMARY (no -Confirm): touch nothing
if (-not $Confirm) {
    # THREE dots, not two. `main..branch` shows the FULL DIVERGENCE between the two tips, so a branch
    # that forked a while ago reports every change main has made since as though the task were
    # responsible for it -- one real test produced "364 files changed, 24964 insertions(+)" for a
    # task that touched a single file. That number is not just useless, it is actively harmful: it
    # trains the operator to stop reading the summary. `main...branch` is the merge-base diff -- the
    # changes the BRANCH introduced -- which is also exactly what the GitHub compare link shows.
    $stat  = @(Invoke-Git -C $root diff --stat "main...$branchName")
    $files = @(Invoke-Git -C $root diff --name-only "main...$branchName")

    # The reviewer had to state WHY it chose the held gate (CLAUDE.md Risk-gated merge). That
    # sentence is the single most useful thing to show before merging, so surface it verbatim rather
    # than re-deriving a guess about what is risky here.
    #
    # Scope it to THIS task's entry by splitting on the headings. A lazy `^##\s+.*?$TaskId` with the
    # singleline flag will happily start at the FIRST heading in the file and run forward until it
    # finds the id, stitching fragments of unrelated reviews into one incoherent paragraph. (It did.)
    $why = ''
    if (Test-Path $reviewFile) {
        $rv = [System.IO.File]::ReadAllText($reviewFile, $utf8)
        # Drop the commented-out REVIEW TEMPLATE first, exactly as TASKS.md parsing does -- otherwise
        # the template's own scaffolding gets quoted back to the operator as if it were the reason a
        # real task was held. (It did.)
        $rv = ($rv -split '<!-- REVIEW TEMPLATE')[0]
        $blocks = [regex]::Split($rv, '(?m)^(?=##\s)')
        $entry = $blocks | Where-Object { ($_ -split "`r?`n")[0] -match [regex]::Escape($TaskId) } | Select-Object -Last 1
        if ($entry) {
            $lines = ($entry -split "`r?`n") | Where-Object {
                $_.Trim() -and $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*<!--' -and $_ -notmatch '^\s*-->'
            }
            $why = ($lines | Select-Object -Last 3) -join "`n"
        }
    }

    # An empty merge-base diff means the branch is already IN main. Say so plainly instead of
    # printing "Touches 0 file(s)" and a blank space, which reads like a broken command.
    if ($files.Count -eq 0) {
        Write-Result @"
$TaskId ($title) is already merged into main -- there is nothing to land.

TASKS.md still says 'status: approved', which is now stale. Set it to 'done'.
main was not changed.
"@
        exit 0
    }

    $msg = New-Object System.Collections.Generic.List[string]
    $msg.Add("HELD (red-zone): $TaskId - $title")
    $msg.Add("")
    $msg.Add("Touches $($files.Count) file(s):")
    foreach ($f in ($files | Select-Object -First 12)) { $msg.Add("  $f") }
    if ($files.Count -gt 12) { $msg.Add("  ... and $($files.Count - 12) more") }
    $msg.Add("")
    if ($stat.Count -gt 0) { $msg.Add(($stat | Select-Object -Last 1).Trim()) }
    if ($why) {
        $msg.Add("")
        $msg.Add("Why it was held:")
        $msg.Add($why.Trim())
    }
    $msg.Add("")
    $msg.Add("Read the diff before you answer:")
    $msg.Add("  https://github.com/shinyamadasan/aly-shin-product-lab/compare/main...$branchName")
    $msg.Add("")
    $msg.Add("To land it:  /merge $TaskId yes")
    $msg.Add("Nothing has been merged. main is untouched.")

    Write-Result ($msg -join "`n")
    exit 0
}

# ================================================================ CONFIRMED: same gates as auto-merge
if ($DryRun) { Write-Result "[DRY RUN] would run the auto-merge gates and fast-forward main to $branchName."; exit 0 }

Add-Content -Path $logFile -Value "[Run-Merge] $TaskId confirmed by operator -- running merge gates."

Invoke-Git -C $root checkout main | Out-Null
$mainDirty = @(Invoke-Git -C $root status --porcelain)
if ($mainDirty.Count -gt 0) {
    Write-Result "MERGE BLOCKED: main has $($mainDirty.Count) uncommitted change(s). main was not changed."
    exit 1
}

Invoke-Git -C $root checkout $branchName | Out-Null
$branchDirty = @(Invoke-Git -C $root status --porcelain)
if ($branchDirty.Count -gt 0) {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "MERGE BLOCKED: $branchName has $($branchDirty.Count) uncommitted change(s). main was not changed."
    exit 1
}

# Auto-rebase (D-044). Dispatch-Commands.ps1 commits an administrative "received" marker to
# main immediately before invoking this script -- its own Preflight requires that, since the
# freshly-arrived command file would otherwise be an uncommitted change. That means main has
# ALREADY moved on by exactly that commit every single time a /merge command reaches here, even
# when the branch was rebased moments earlier: the ancestor check further down would never pass
# through the normal dispatch path, and every merge would dead-end on "main is not an ancestor"
# regardless of how current the branch actually is (confirmed live -- this blocked two real tasks
# repeatedly). Auto-rebase closes that self-inflicted gap for the ordinary, conflict-free
# case; a genuine conflict still stops here and asks a human, same as before.
Invoke-Git -C $root merge-base --is-ancestor main $branchName | Out-Null
if ($LASTEXITCODE -ne 0) {
    $rebaseOutput = Invoke-Git -C $root rebase main 2>&1
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root rebase --abort | Out-Null
        Invoke-Git -C $root checkout main | Out-Null
        Write-Result "MERGE BLOCKED: $branchName conflicts with main and could not be auto-rebased. Rebase it by hand, then /merge again. main was not changed.`n`n$rebaseOutput"
        exit 1
    }
    Invoke-Git -C $root push --force-with-lease origin $branchName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root checkout main | Out-Null
        Write-Result "MERGE BLOCKED: $branchName auto-rebased cleanly, but the force-push failed (someone else pushed to it concurrently). Try /merge again. main was not changed."
        exit 1
    }
}

# npm test on the BRANCH, not on main -- we are about to make the branch become main.
# Platform. PowerShell 7 defines $IsWindows/$IsMacOS; Windows PowerShell 5.1 does NOT -- there the
# variable is $null, which is FALSY. A naive "if ($IsWindows)" would therefore take the macOS branch
# on 5.1 and break every existing Windows install. Hence the explicit null check.
$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }

$psi = New-Object System.Diagnostics.ProcessStartInfo
# cmd.exe does not exist on macOS; /bin/sh is the equivalent there.
if ($OnWindows) { $psi.FileName = 'cmd.exe'; $psi.Arguments = '/c npm test' }
else            { $psi.FileName = '/bin/sh'; $psi.Arguments = '-c "npm test"' }
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
if (-not $p.WaitForExit(10 * 60 * 1000)) {
    try { $p.Kill() } catch { }
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "MERGE BLOCKED: npm test timed out on $branchName. main was not changed."
    exit 1
}
if ($p.ExitCode -ne 0) {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "MERGE BLOCKED: npm test FAILED on $branchName (exit $($p.ExitCode)). main was not changed."
    exit 1
}

$postTestDirty = @(Invoke-Git -C $root status --porcelain)
if ($postTestDirty.Count -gt 0) {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "MERGE BLOCKED: npm test modified $($postTestDirty.Count) file(s) on $branchName. main was not changed."
    exit 1
}

# Fast-forward ONLY. If main is not an ancestor, the branch is stale and a merge would create a
# commit nobody reviewed -- refuse, and make a human rebase it.
Invoke-Git -C $root merge-base --is-ancestor main $branchName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "MERGE BLOCKED: main is not an ancestor of $branchName (it moved on). Rebase the branch, then /merge again. main was not changed."
    exit 1
}

Invoke-Git -C $root checkout main | Out-Null
Invoke-Git -C $root merge --ff-only $branchName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Result "MERGE BLOCKED: fast-forward of main to $branchName failed. main was not changed."
    exit 1
}

# Mark the task done BEFORE pushing, so main never carries the merged code while TASKS.md still
# claims the task is waiting for a human.
$newBody = [regex]::Replace($blk.Value, '(?m)^status:[^\r\n]*', 'status: done')
$updated = $tasksText.Replace($blk.Value, $newBody)
[System.IO.File]::WriteAllText($tasksFile, $updated, $utf8)
Invoke-Git -C $root add TASKS.md | Out-Null
Invoke-Git -C $root commit -m "$TaskId : merged (red-zone, confirmed by operator via /merge)" | Out-Null

# Retry the push (D-048 addendum). Found live: a plain unretried push here left the merge sitting on
# local main, unpushed, whenever something else (n8n's reply-clearing step, or the dispatcher's OWN
# later OUTBOX-reply commit) advanced origin/main in the brief window first -- and Dispatch-
# Commands.ps1's Invoke-CommitPushWithRetry (D-047), invoked right after this script returns to write
# that reply, does a `git reset --hard origin/main` on ITS OWN push rejection, which silently
# discarded this unpushed merge along with it, since D-047 assumed nothing else unpushed could be
# sitting underneath. Retrying HERE, before this script ever returns, closes that window: rebase (not
# reset -- these two commits are the actual merge/status-flip, not a regenerable message the way
# D-047's callers' commits are) onto the fresh tip and retry, same MaxAttempts=5 convention as D-047.
$pushed = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
    Invoke-Git -C $root push origin main | Out-Null
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    if ($attempt -eq 5) { break }
    Invoke-Git -C $root fetch origin | Out-Null
    $rebaseOutput = Invoke-Git -C $root rebase origin/main 2>&1
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root rebase --abort | Out-Null
        Write-Result "MERGED into local main, but the push kept losing a race with something else advancing origin/main, and rebasing onto the new tip conflicted. Resolve by hand at the PC: git rebase origin/main (on main), then git push origin main.`n`n$rebaseOutput"
        exit 1
    }
    Start-Sleep -Milliseconds (300 * $attempt)
}

if (-not $pushed) {
    Write-Result "MERGED into local main, but PUSH FAILED after 5 attempt(s) -- kept losing the race with something else advancing origin/main. Run 'git push origin main' at the PC as soon as possible."
    exit 1
}

Write-Result "MERGED: $TaskId ($title) -> main, pushed. Deploy follows. TASKS.md updated to 'done'."
exit 0
