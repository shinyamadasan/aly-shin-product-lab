<#
.SYNOPSIS
  /review phase runner: runs Claude's review against the first `status: review` task's branch,
  falling back to Codex if Claude appears to be out of tokens/quota or unavailable (D-048).

.DESCRIPTION
  Checks out task-<id>, invokes Claude non-interactively to do exactly what the interactive "Review"
  command already documents in CLAUDE.md (read the branch diff, CHANGELOG.md, TEST_REPORT.md,
  acceptance criteria; write REVIEW.md; set TASKS.md status to done or back to codex/rework) --
  never touching app code. A commit-scope guard (same fail-fast mechanism as run-claude.ps1's)
  allows only REVIEW.md and TASKS.md; anything else halts with no commit/push. If Claude approves,
  this runner verifies the reviewed branch with npm test, fast-forwards main, and pushes main.

  D-048: if Claude is missing from PATH, or the review call fails in a way that looks like a
  quota/rate-limit/capacity problem (not a real review outcome -- "reviewed and found problems" is
  never a failure, only "could not run" is), this runner retries the SAME branch with Codex as
  reviewer instead, using tools/CODEX_REVIEW_INSTRUCTIONS.md (Codex has no Task tool, so it cannot
  run the Guardian Gauntlet -- that file tells it to say so explicitly and never choose `done`,
  reusing the exact "guardian didn't run -> approved at most" degradation clause the Claude prompt
  already has, rather than inventing new verdict logic). Whichever engine actually produces the
  verdict, this runner checks -- via `git log` on the branch for the builder-identity convention
  Run-Codex-Build.ps1 commits ("built via codex" / "built via claude (fallback...)") -- whether the
  SAME engine both built and reviewed the task, and if so appends a plain self-review disclosure to
  the result. This is never a block: self-review is an already-accepted trade-off (Claude-only
  installs have always done both roles in one session) -- it must be disclosed, not prevented.

  Writes its final human-readable result to .last-phase-result.txt (gitignored) for
  Dispatch-Commands.ps1 to relay.

.EXAMPLE
  ./tools/Run-Claude-Review.ps1
  ./tools/Run-Claude-Review.ps1 -DryRun
  ./tools/Run-Claude-Review.ps1 -NoAutoMerge
#>
param([switch]$DryRun, [switch]$NoAutoMerge, [switch]$NoPush)


# Platform. PowerShell 7 defines $IsWindows/$IsMacOS; Windows PowerShell 5.1 does NOT (the variable
# is $null, which is FALSY -- so a naive "if ($IsWindows)" would silently take the macOS branch on
# 5.1 and break every existing Windows install). Hence the explicit null check.
$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }

# WHICH ENGINE REVIEWS, BY DEFAULT. D-048 makes this a preference, not a hard requirement -- see the
# fallback logic below. Claude is the stronger default here for the opposite reason codex is the
# default builder: Claude's review gets the Guardian Gauntlet (two read-only subagent specialists via
# the Task tool); Codex has no equivalent, so a Codex review is always a strictly weaker fallback,
# never a peer option to pick from freely.
$PREFERRED_REVIEWER = 'claude'
if ($PREFERRED_REVIEWER -notin @('claude', 'codex')) { $PREFERRED_REVIEWER = 'claude' }

$ErrorActionPreference = 'Stop'
$root       = Split-Path $PSScriptRoot -Parent
$logFile    = Join-Path $root 'claude-session.log'
$resultFile = Join-Path $root '.last-phase-result.txt'
$tasksFile  = Join-Path $root 'TASKS.md'
$utf8       = New-Object System.Text.UTF8Encoding($false)
$AUTO_MERGE_AFTER_REVIEW = -not $NoAutoMerge
$AUTO_PUSH_AFTER_MERGE   = -not $NoPush
$AUTO_MERGE_TEST_TIMEOUT_MINUTES = 10

# Under $ErrorActionPreference = 'Stop', ANY stderr text from a native command -- even a benign
# warning like git's LF-will-be-replaced-by-CRLF notice, on a call that otherwise succeeds -- gets
# promoted to a terminating exception, regardless of whether stderr is redirected to $null. This
# showed up twice in live testing on different git calls (rev-parse --verify, then add), so every
# git invocation is routed through here rather than patched one call site at a time: EAP is lowered
# to 'Continue' only for the duration of the native call, which stops the promotion, while
# $LASTEXITCODE still reflects git's real exit code exactly as before.
function Invoke-Git {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @args 2>$null }
    finally { $ErrorActionPreference = $prevEAP }
}

# D-048: same heuristic as Run-Codex-Build.ps1 -- distinguishes "the engine couldn't even run" (safe
# to retry with the other engine) from "the engine ran and produced a real verdict" (REWORK is a
# normal, expected outcome of a real review -- never treated as a failure here). Duplicated rather
# than shared, matching this repo's convention of self-contained phase-runner scripts with no common
# lib file.
function Test-QuotaExhaustionSignal {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    $Text -match '(?i)(rate.?limit(?:ed)?|quota|usage limit|\b429\b|insufficient.?(?:quota|credits?|balance)|too many requests|resource.?exhausted)'
}

# D-048 self-review disclosure: which engine's commit message built this branch, per the convention
# Run-Codex-Build.ps1 writes ("<id>: built via codex" / "built via claude (fallback after ...)").
# Returns $null if no such commit is found (e.g. a task built before D-048 shipped, or by a human) --
# absence is not an error, just means no disclosure is possible.
function Get-BuilderEngineForBranch {
    param([string]$BranchName)
    $subjects = @(Invoke-Git -C $root log $BranchName --format=%s)
    foreach ($s in $subjects) {
        if ($s -match '(?i)built via (codex|claude)') { return $Matches[1].ToLower() }
    }
    $null
}

function Write-Result {
    param([string]$Text)
    if (-not $DryRun) { [System.IO.File]::WriteAllText($resultFile, $Text, $utf8) }
    Add-Content -Path $logFile -Value "[Run-Claude-Review] $Text"
    Write-Host $Text
}

function Get-TaskStatus {
    param([string]$TaskId)
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $m = [regex]::Match($text, "(?ms)^###\s+$TaskId\b.*?^status:\s*(?<s>[\w-]+)")
    if ($m.Success) { $m.Groups['s'].Value } else { $null }
}

function Invoke-NpmTest {
    Add-Content -Path $logFile -Value "[Run-Claude-Review] running npm test before auto-merge (timeout: $AUTO_MERGE_TEST_TIMEOUT_MINUTES minute(s))."

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    # cmd.exe does not exist on macOS. /bin/sh is the equivalent shim resolver there.
    if ($OnWindows) { $psi.FileName = 'cmd.exe';  $psi.Arguments = '/c npm test' }
    else            { $psi.FileName = '/bin/sh';  $psi.Arguments = '-c "npm test"' }
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $exited = $proc.WaitForExit($AUTO_MERGE_TEST_TIMEOUT_MINUTES * 60 * 1000)
    if (-not $exited) {
        # taskkill is Windows-only. Stop-Process works on both, but on Windows it does NOT kill the
        # process TREE -- npm spawns node, and killing only the npm shim leaves the real test process
        # alive, still holding the lock. taskkill /T is what actually reaps the tree there.
        if ($OnWindows) { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null }
        else            { & pkill -TERM -P $proc.Id 2>$null | Out-Null }
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        $proc.WaitForExit()
        Add-Content -Path $logFile -Value "[Run-Claude-Review] npm test TIMED OUT after $AUTO_MERGE_TEST_TIMEOUT_MINUTES minute(s)."
        return 124
    }

    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    if ($stdout) { Add-Content -Path $logFile -Value "[Run-Claude-Review] --- npm test stdout ---`n$stdout" }
    if ($stderr) { Add-Content -Path $logFile -Value "[Run-Claude-Review] --- npm test stderr ---`n$stderr" }
    $proc.ExitCode
}

function Invoke-AutoMerge {
    param([string]$TaskId, [string]$BranchName)

    if (-not $AUTO_MERGE_AFTER_REVIEW) {
        Invoke-Git -C $root checkout main | Out-Null
        return "$TaskId APPROVED. Auto-merge disabled; merge $BranchName into main when you're ready."
    }

    $branchDirty = @(Invoke-Git -C $root status --porcelain)
    if ($branchDirty.Count -gt 0) {
        return "Review passed, but auto-merge BLOCKED: $BranchName has $($branchDirty.Count) uncommitted change(s) after review. Main was not changed."
    }

    $testExit = Invoke-NpmTest
    if ($testExit -ne 0) {
        Invoke-Git -C $root checkout main | Out-Null
        return "Review passed, but auto-merge BLOCKED: npm test failed on $BranchName (exit $testExit). Main was not changed."
    }

    $postTestDirty = @(Invoke-Git -C $root status --porcelain)
    if ($postTestDirty.Count -gt 0) {
        return "Review passed, but auto-merge BLOCKED: npm test changed $($postTestDirty.Count) tracked/visible file(s) on $BranchName. Main was not changed."
    }

    Invoke-Git -C $root merge-base --is-ancestor main $BranchName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root checkout main | Out-Null
        return "Review passed, but auto-merge BLOCKED: main is not an ancestor of $BranchName. Rebase or merge by hand."
    }

    Invoke-Git -C $root checkout main | Out-Null
    $mainDirty = @(Invoke-Git -C $root status --porcelain)
    if ($mainDirty.Count -gt 0) {
        return "Review passed, but auto-merge BLOCKED: main has $($mainDirty.Count) uncommitted change(s)."
    }

    Invoke-Git -C $root merge --ff-only $BranchName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        return "Review passed, but auto-merge BLOCKED: git merge --ff-only $BranchName failed."
    }

    if ($AUTO_PUSH_AFTER_MERGE) {
        # Retry with rebase, not reset (D-047/D-048 addendum, TASK-031). This is the highest-traffic
        # push-to-main site in the whole system -- every reversible task lands through here. Found by
        # auditing every push-to-main call site after Run-Merge.ps1's own unretried push silently lost
        # a completed merge to a race with Dispatch-Commands.ps1's OUTBOX-reply retry logic (D-047):
        # this site had the exact same shape and was equally exposed, just not yet caught live.
        $pushed = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            Invoke-Git -C $root push origin main | Out-Null
            if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
            if ($attempt -eq 5) { break }
            Invoke-Git -C $root fetch origin | Out-Null
            $rebaseOutput = Invoke-Git -C $root rebase origin/main 2>&1
            if ($LASTEXITCODE -ne 0) {
                Invoke-Git -C $root rebase --abort | Out-Null
                return "$TaskId APPROVED and auto-merged $BranchName into local main, but the push kept losing a race with something else advancing origin/main, and rebasing onto the new tip conflicted. Resolve by hand at the PC: git rebase origin/main (on main), then git push origin main.`n`n$rebaseOutput"
            }
            Start-Sleep -Milliseconds (300 * $attempt)
        }
        if (-not $pushed) {
            return "$TaskId APPROVED and auto-merged $BranchName into local main, but PUSH FAILED after 5 attempt(s) -- kept losing the race with something else advancing origin/main. Run 'git push origin main' at the PC as soon as possible."
        }
        return "$TaskId APPROVED and auto-merged $BranchName into main, then pushed origin/main."
    }

    "$TaskId APPROVED and auto-merged $BranchName into local main. Push origin/main when you're ready."
}

# --- Find the first status: review task ---
$text = Get-Content $tasksFile -Raw -Encoding UTF8
$body = ($text -split '<!-- TASK TEMPLATE')[0]
$blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[·•]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')
$target = $null
foreach ($b in $blocks) {
    $m = [regex]::Match($b.Groups['rest'].Value, '(?m)^status:\s*(?<s>[\w-]+)')
    if ($m.Success -and $m.Groups['s'].Value -eq 'review') { $target = $b; break }
}
if (-not $target) {
    Write-Result "Nothing to review -- no TASKS.md entry has status: review right now."
    exit 0
}
$taskId = $target.Groups['id'].Value
$title  = $target.Groups['title'].Value.Trim()
$branchName = ($taskId -replace 'TASK-', 'task-').ToLower()

$codexAvailable  = [bool](Get-Command codex  -ErrorAction SilentlyContinue)
$claudeAvailable = [bool](Get-Command claude -ErrorAction SilentlyContinue)

if ($DryRun) {
    $mergeMode = if ($AUTO_MERGE_AFTER_REVIEW) { 'enabled' } else { 'disabled' }
    $pushMode = if ($AUTO_PUSH_AFTER_MERGE) { 'enabled' } else { 'disabled' }
    $firstChoice = if ($PREFERRED_REVIEWER -eq 'claude' -and $claudeAvailable) { 'claude' } elseif ($PREFERRED_REVIEWER -eq 'codex' -and $codexAvailable) { 'codex' } elseif ($claudeAvailable) { 'claude' } elseif ($codexAvailable) { 'codex' } else { 'neither available' }
    Write-Result "[DRY RUN] would checkout $branchName and review $taskId ($title) via $firstChoice, falling back to the other engine on a detected quota/capacity signal. Auto-merge after approval: $mergeMode. Push after merge: $pushMode."
    exit 0
}

if (-not $codexAvailable -and -not $claudeAvailable) {
    Write-Result "ABORTED: neither 'claude' nor 'codex' is on PATH for this session. Install/authenticate at least one, or check the account running this scheduled task has it on PATH."
    exit 2
}

# --- Preflight: the task branch must exist and be clean before it's reviewed. ---
Invoke-Git -C $root rev-parse --verify $branchName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Result "ABORTED: branch '$branchName' for $taskId does not exist. Nothing to review."
    exit 2
}
Invoke-Git -C $root checkout $branchName | Out-Null
$dirty = @(Invoke-Git -C $root status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Result "ABORTED: $branchName has $($dirty.Count) uncommitted change(s). Commit/stash/clean before reviewing."
    exit 2
}

# ---------------------------------------------------------------------------------------------
# THE REVIEWER IS PLUGGABLE (D-048), mirroring Run-Codex-Build.ps1's $BUILDER pattern. Everything
# outside this function -- preflight, the commit-scope guard, the verdict-status dispatch, the
# auto-merge gates -- is engine-agnostic and unchanged. Only the process invoked here differs.
# ---------------------------------------------------------------------------------------------
function Invoke-ReviewerEngine {
    param([string]$Engine, [string]$TaskId, [string]$Title, [string]$BranchName)

    # Prefer the logged-in subscription over API-key billing for either engine, same as elsewhere.
    Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

    if ($Engine -eq 'codex') {
        # Short, single-line argument -- deliberately not a large inline prompt. `codex exec`'s only
        # verified invocation contract in this repo (D-025) is a short literal instruction that tells
        # Codex which committed file to go read and follow; passing a multi-paragraph prompt as a raw
        # CLI argument would repeat the exact tail-truncation risk that forced claude's prompt through
        # stdin instead. tools/CODEX_REVIEW_INSTRUCTIONS.md carries the actual reviewer contract.
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'codex'
        $psi.Arguments = "exec -C `"$root`" --sandbox workspace-write `"Review $TaskId`""
        $psi.WorkingDirectory = $root
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $proc.Start() | Out-Null
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        $proc.WaitForExit()
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        Add-Content -Path $logFile -Value "[Run-Claude-Review] codex review for $TaskId -- exit $($proc.ExitCode)"
        Add-Content -Path $logFile -Value "[Run-Claude-Review] --- stdout ---`n$stdout"
        if ($stderr) { Add-Content -Path $logFile -Value "[Run-Claude-Review] --- stderr ---`n$stderr" }
        return [pscustomobject]@{ Engine = 'codex'; ExitCode = $proc.ExitCode; Stdout = $stdout; Stderr = $stderr }
    }

    # --- claude path: unchanged from the pre-D-048 behavior ---
    $prompt = @"
You are running in autonomous mode. No human is available. Follow CLAUDE.md's Reviewer role exactly
as the interactive "Review" command already documents.

Review task $TaskId ($Title) on the current branch ($BranchName). Read the branch diff against main,
CHANGELOG.md, TEST_REPORT.md, and $TaskId's acceptance criteria in TASKS.md.

You may ONLY write to REVIEW.md and TASKS.md (only $TaskId's status field) -- do not touch any
application source file, test, or config. Do not attempt git commit or git push (not available to
you this run).

GUARDIAN GAUNTLET -- run this BEFORE you decide anything. It is not optional.

Using the Task tool, run these two specialists against the branch diff:

  1. security-guardian -- audit the diff for vulnerabilities, secret leakage, and unsafe handling
     of user data.
  2. quality-guardian  -- verify the diff ACTUALLY satisfies $TaskId's acceptance criteria in
     TASKS.md. Not "looks plausible" -- traced, criterion by criterion.

Both run as READ-ONLY ADVISORS. Tell each one explicitly, in the prompt you give it, that it must
report findings back to you and must NOT edit, write, or fix any file. This run has a commit-scope
guard that ABORTS the whole review if anything other than REVIEW.md or TASKS.md changes on disk, so
a guardian that "helpfully" applies a fix will fail the review outright.

Fold their findings into REVIEW.md under a "## Guardian Gauntlet" heading -- both the findings and
the fact that each guardian ran.

If a guardian CANNOT run (tool unavailable, agent not found, error), say so explicitly in REVIEW.md
and treat the gauntlet as NOT PASSED. Never record a guardian as clean when it did not run. An
unrun gate that reports "pass" is worse than no gate: it launders unaudited code as audited.

Then write the REVIEW.md entry: verdict (APPROVED or REWORK), must-fix items if any, nits if any.
Set $TaskId's status in TASKS.md. Never rubber-stamp.

VERDICT RULES -- the gauntlet outranks your own impression of the diff:
  - Any CONFIRMED security finding                       => REWORK. Never approve over it.
  - quality-guardian finds an unmet acceptance criterion => REWORK.
  - A guardian did not run                               => do NOT choose 'done'. Use 'approved'
                                                            at most, and say why in REVIEW.md.

RISK-GATED MERGE (see DECISIONS D-032). Choose the status by what the task TOUCHES:
  - codex    = REWORK needed (must-fix items exist, or the gauntlet failed).
  - approved = APPROVED, but the task touches a RED-ZONE surface. The red zone is defined in
               CLAUDE.md's "Risk-gated merge" section -- generally: the data / sync / storage
               layer, auth, security, or the AI Dev OS / automation itself. This HOLDS the branch:
               main is NOT merged, and the human merges after a glance. Lost user data cannot be
               reverted, so these never auto-ship.
  - done     = APPROVED and the change is reversible (UI, CSS, copy, additive non-data features).
               This AUTO-MERGES into main and deploys.
If you are torn between done and approved, choose approved.
State which gate you picked, and why, at the end of the REVIEW.md entry.
"@

    # Pipe the PROMPT itself via stdin (not `claude -p $prompt`): under Windows PowerShell 5.1 a long
    # multi-line prompt passed as a native-command argument loses its tail -- confirmed live in the
    # planner, where Claude only received the head of the prompt. Piping via stdin delivers it intact
    # AND gives claude an immediate EOF (no ~3s stall).
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($OnWindows) { $psi.FileName = 'cmd.exe'; $psi.Arguments = '/c claude -p --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Task" "Bash(git status)" "Bash(git diff *)" "Bash(git log *)"' }
    else            { $psi.FileName = '/bin/sh'; $psi.Arguments = '-c ''claude -p --allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Task" "Bash(git status)" "Bash(git diff *)" "Bash(git log *)"''' }
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $proc.StandardInput.Write($prompt)
    $proc.StandardInput.Close()
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $proc.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    Add-Content -Path $logFile -Value "[Run-Claude-Review] claude review for $TaskId -- exit $($proc.ExitCode)"
    Add-Content -Path $logFile -Value $stdout
    if ($stderr) { Add-Content -Path $logFile -Value "[Run-Claude-Review] --- stderr ---`n$stderr" }
    [pscustomobject]@{ Engine = 'claude'; ExitCode = $proc.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

$firstEngine = if ($PREFERRED_REVIEWER -eq 'claude' -and $claudeAvailable) { 'claude' }
               elseif ($PREFERRED_REVIEWER -eq 'codex' -and $codexAvailable) { 'codex' }
               elseif ($claudeAvailable) { 'claude' }
               else { 'codex' }

$attempt = Invoke-ReviewerEngine -Engine $firstEngine -TaskId $taskId -Title $title -BranchName $branchName
$fallbackAttempted = $false
$fallbackReason = $null

# --- D-048: on a quota/capacity signal (never on "reviewed and found problems" -- that's exit 0 with
#     a REWORK verdict, a normal outcome, not a failure), retry with the other engine. Discard
#     whatever the failed engine left behind first so the retry starts from a clean branch tip rather
#     than a possibly-partial REVIEW.md draft. ---
if ($attempt.ExitCode -ne 0) {
    $otherEngine = if ($attempt.Engine -eq 'claude') { 'codex' } else { 'claude' }
    $otherAvailable = if ($otherEngine -eq 'codex') { $codexAvailable } else { $claudeAvailable }
    $looksLikeQuota = (Test-QuotaExhaustionSignal $attempt.Stdout) -or (Test-QuotaExhaustionSignal $attempt.Stderr)
    $missingEntirely = if ($attempt.Engine -eq 'codex') { -not $codexAvailable } else { -not $claudeAvailable }

    if ($otherAvailable -and ($looksLikeQuota -or $missingEntirely)) {
        $fallbackReason = if ($looksLikeQuota) { "a quota/capacity signal in $($attempt.Engine)'s output" } else { "$($attempt.Engine) was unexpectedly unavailable" }
        Add-Content -Path $logFile -Value "[Run-Claude-Review] ${taskId}: falling back from $($attempt.Engine) to $otherEngine -- detected $fallbackReason."
        Invoke-Git -C $root reset --hard HEAD | Out-Null
        Invoke-Git -C $root clean -fd | Out-Null
        $fallbackAttempted = $true
        $attempt = Invoke-ReviewerEngine -Engine $otherEngine -TaskId $taskId -Title $title -BranchName $branchName
    }
}

$engineUsed = $attempt.Engine

if ($attempt.ExitCode -ne 0) {
    # Deliberately do NOT checkout main -- the session may have left partial, uncommitted edits;
    # leave $branchName exactly as it is for inspection rather than risk carrying stray changes onto
    # main. Unlike Run-Codex-Build.ps1, a bare review-process failure does NOT mark the task blocked:
    # it stays `status: review`, which is already a valid "try me again" state -- the next /review or
    # /go invocation picks the same task up automatically once whichever engine(s) failed recover, with
    # no separate auto:/strike-count machinery needed on this side.
    $failNote = if ($fallbackAttempted) { "$engineUsed review (fallback after $fallbackReason) ALSO exited $($attempt.ExitCode)" } else { "$engineUsed review exited $($attempt.ExitCode)" }
    Write-Result "$taskId review FAILED: $failNote. Left at status: review for automatic retry on the next /review or /go. See claude-session.log."
    exit 1
}

# --- Commit-scope guard: ONLY REVIEW.md and TASKS.md allowed, regardless of which engine reviewed ---
$allowedPatterns = @('^REVIEW\.md$', '^TASKS\.md$')
$changed = @(Invoke-Git -C $root status --porcelain | ForEach-Object { $_.Substring(3).Trim() } | Where-Object { $_ })
$violations = @($changed | Where-Object { $path = $_; -not ($allowedPatterns | Where-Object { $path -match $_ }) })

if ($violations.Count -gt 0) {
    # Same reasoning as above -- leave the dirty tree on $branchName for a human, never auto-switch.
    Write-Result "$taskId review HALTED: touched file(s) outside the review surface: $($violations -join ', '). NOT committed/pushed -- inspect $branchName by hand."
    exit 1
}
if ($changed.Count -eq 0) {
    # Nothing changed at all -- tree is clean, safe to return to main.
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId review produced no changes -- investigate; a real review should at least update REVIEW.md."
    exit 1
}

Invoke-Git -C $root add -- $changed
Invoke-Git -C $root commit -m "${taskId}: $engineUsed review" | Out-Null
Invoke-Git -C $root push origin $branchName | Out-Null

# D-048 self-review disclosure: check who built this branch BEFORE switching away from it -- git log
# still needs the branch checked out (or at least resolvable) to read its history either way, but
# doing this alongside the other pre-switch reads keeps everything in one place.
$builderEngine = Get-BuilderEngineForBranch -BranchName $branchName
$selfReviewNote = if ($builderEngine -and $builderEngine -eq $engineUsed) {
    " Note: builder and reviewer were both $engineUsed for this task -- self-review, reduced blind-spot protection. Same trade-off already accepted for Claude-only installs; disclosed here per D-048, not blocked."
} else { "" }
$fallbackNote = if ($fallbackAttempted) { " (reviewed via $engineUsed -- fallback after $fallbackReason)" } else { "" }

# Read the final status BEFORE switching back to main -- checking out main first would make this
# read main's untouched TASKS.md (the task was never merged there), always reporting the task's
# pre-review status regardless of what the reviewer actually decided. Confirmed live: a real APPROVED
# review with status correctly set to `done` on $branchName was misreported as "needs REWORK"
# because $tasksFile was read after the branch switch.
$newStatus = Get-TaskStatus -TaskId $taskId
if ($newStatus -eq 'done') {
    Write-Result ((Invoke-AutoMerge -TaskId $taskId -BranchName $branchName) + $fallbackNote + $selfReviewNote)
} elseif ($newStatus -eq 'codex') {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId needs REWORK$fallbackNote -- see REVIEW.md on $branchName for must-fix items.$selfReviewNote"
} elseif ($newStatus -eq 'approved') {
    # Risk gate (D-032): approved-but-red-zone. Reviewed OK, but it touches data/sync/auth/OS, so it
    # is deliberately NOT auto-merged -- a human eyeballs and merges. main is untouched.
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId APPROVED but HELD for your merge$fallbackNote -- red-zone surface (data/sync/auth/OS). main NOT changed. Review the diff on $branchName, then: git checkout main; git merge --ff-only $branchName; git push origin main.$selfReviewNote"
} else {
    Invoke-Git -C $root checkout main | Out-Null
    Write-Result "$taskId reviewed (status now '$newStatus')$fallbackNote -- pushed to $branchName. Check REVIEW.md for detail.$selfReviewNote"
}
exit 0
