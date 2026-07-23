<#
.SYNOPSIS
  /audit phase runner: an on-demand deep look at the app that writes new, real findings straight
  into planning/PROPOSALS.md, using the same Proposal contract (Decision + Risk) a human capture
  would produce -- so Decision:Approve + Risk:Low findings auto-promote too (D-042), no separate
  approval step for the routine case.

.DESCRIPTION
  Combines PP1 (Internal Alpha Audit) + PP2 (UX Friction Audit) from PROMPTS.md with P9's Triage
  output contract. Cost-gated two ways (D-043):
    - Incremental by default: reads planning/AUDIT_SUMMARY.md for the commit it was last run
      against, diffs the app's own source files since then, and if NOTHING changed, replies and
      exits WITHOUT ever invoking Claude -- pure git, zero LLM tokens spent. Only a non-empty diff
      (or a stale/missing summary) triggers a real Claude session, and even then it's handed only
      the diff + the existing summary, not the whole app again.
    - Full re-scan at most every 30 days, regardless of how many incremental audits ran in between,
      so small inaccuracies in the incrementally-maintained summary can't compound indefinitely.
  Capped to 5 new findings per run so a single audit can't flood PROPOSALS.md.

  On-demand only -- never wired into a schedule or a polling loop. Triggered by a human sending
  /audit, or by Invoke-Autopilot when /go finds genuinely nothing else to do (D-043).

  Never edits the app's own source files -- read-only against the app, same as Triage is read-only
  against captures. A commit-scope guard (same fail-fast shape as run-claude.ps1's) allows only
  planning/PROPOSALS.md and planning/AUDIT_SUMMARY.md to change; anything else halts uncommitted.
  Self-contained like Run-Merge.ps1/Run-Codex-Build.ps1 -- commits and pushes its own result rather
  than relying on a caller.

.EXAMPLE
  ./tools/Run-Audit.ps1
  ./tools/Run-Audit.ps1 -DryRun
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root         = Split-Path $PSScriptRoot -Parent
$summaryPath  = Join-Path $root 'planning/AUDIT_SUMMARY.md'
$proposals    = Join-Path $root 'planning/PROPOSALS.md'
$logFile      = Join-Path $root 'claude-session.log'
$resultFile   = Join-Path $root '.last-phase-result.txt'
$utf8         = New-Object System.Text.UTF8Encoding($false)
$FULL_REFRESH_DAYS = 30   # D-043: one flat rule, not a count-or-time combo -- see DECISIONS.md
# The app's own source files -- rendered per-app at install time (Install-AiDevOs.ps1's 'index.html', 'style.css', 'app.js'
# token, from that app's config codeFiles key), since this is inherently different for every app.
$codeFiles = @('index.html', 'style.css', 'app.js')

function Write-Result([string]$Text) {
    [System.IO.File]::WriteAllText($resultFile, $Text, $utf8)
    Write-Host $Text
}
function Invoke-Git {
    # Same EAP-lowering wrapper as Dispatch-Commands.ps1 -- a benign stderr line (e.g. git's
    # LF-will-be-replaced-by-CRLF notice) would otherwise be promoted to a terminating exception
    # under $ErrorActionPreference = 'Stop', confirmed live earlier this session.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @args 2>$null } finally { $ErrorActionPreference = $prevEAP }
}

# ---------------------------------------------------------------- Preflight (same spirit as
# run-claude.ps1's: repo/git/branch/tree, each a hard abort, no auto-remediation) ----------------
if (-not (Test-Path $root) -or -not (Test-Path (Join-Path $root '.git'))) {
    Write-Result "ABORTED: $root is not a valid git repository."; exit 2
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Result "ABORTED: git is not available on PATH."; exit 2
}
$branch = Invoke-Git -C $root branch --show-current
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
    Write-Result "ABORTED: could not determine the current git branch."; exit 2
}
if ($branch -ne 'main') {
    Write-Result "ABORTED: /audit only runs from main (currently on '$branch')."; exit 2
}
$dirty = @(Invoke-Git -C $root status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Result "ABORTED: main has $($dirty.Count) uncommitted change(s). Commit/stash/clean before auditing."; exit 2
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Result "ABORTED: the 'claude' CLI is not available on PATH."; exit 2
}

# ---------------------------------------------------------------- Read state, decide mode -------
$summaryText = if (Test-Path $summaryPath) { Get-Content $summaryPath -Raw -Encoding UTF8 } else { '' }
$lastCommitM = [regex]::Match($summaryText, '(?m)^-\s*last-audited-commit:\s*(?<v>\S+)')
$lastCommit  = if ($lastCommitM.Success -and $lastCommitM.Groups['v'].Value -match '^[0-9a-f]{7,40}$') { $lastCommitM.Groups['v'].Value } else { $null }
$lastRefreshM = [regex]::Match($summaryText, '(?m)^-\s*last-full-refresh:\s*(?<v>\S+)')
$lastRefresh  = if ($lastRefreshM.Success -and $lastRefreshM.Groups['v'].Value -match '^\d{4}-\d{2}-\d{2}$') { [datetime]$lastRefreshM.Groups['v'].Value } else { $null }

$daysSinceRefresh = if ($lastRefresh) { ((Get-Date) - $lastRefresh).TotalDays } else { [double]::PositiveInfinity }
$needsFullRefresh = (-not $lastCommit) -or ($daysSinceRefresh -ge $FULL_REFRESH_DAYS)

$headSha = (Invoke-Git -C $root rev-parse HEAD).Trim()

$appDiff = ''
if (-not $needsFullRefresh) {
    $diffLines = @(Invoke-Git -C $root diff "$lastCommit..HEAD" -- @codeFiles)
    if ($diffLines.Count -eq 0) {
        Write-Result "No app changes since the last audit ($lastCommit) -- nothing new to look for."
        exit 0
    }
    $appDiff = $diffLines -join "`n"
}

# ---------------------------------------------------------------- Build the prompt --------------
if ($DryRun) {
    $mode = if ($needsFullRefresh) { "FULL RE-SCAN (first run, or >= $FULL_REFRESH_DAYS days since last refresh)" } else { "incremental (diff since $lastCommit)" }
    Write-Result "[DRY RUN] would run an audit in $mode mode; would not invoke claude for real."
    exit 0
}

$codeFilesList = $codeFiles -join ', '

$readInstruction = if ($needsFullRefresh) {
    "This is a FULL RE-SCAN (first run, or it has been $FULL_REFRESH_DAYS+ days since the last one). Read $codeFilesList in full."
} else {
    @"
This is an INCREMENTAL audit. Do NOT re-read the whole app. Only these two things changed since the
last audit (commit $lastCommit): the diff below, and planning/AUDIT_SUMMARY.md's own notes on
everything already known. Reason only about what's new in the diff, in light of that existing summary.

--- DIFF ($codeFilesList, since last audit) ---
$appDiff
--- END DIFF ---
"@
}

$prompt = @"
You are running an on-demand app audit -- NOT processing a human capture. No human is available.
Combine PP1 (Internal Alpha Audit) and PP2 (UX Friction Audit) from PROMPTS.md with P9's Triage
output contract: read docs/PROJECT.md (North-star goals, Core value loop), then look for real
friction or gaps tied to those goals -- not style nitpicks, not hypothetical features.

$readInstruction

Read planning/ROADMAP.md, planning/PROPOSALS.md, and planning/DONE.md and DEDUPE: never propose
something already there, already done, or already listed under 'Already-surfaced findings' in
planning/AUDIT_SUMMARY.md.

For each genuinely new finding (CAP: 5 per run, fewer is fine, zero is fine), append ONE new
### PROP-NNN block to planning/PROPOSALS.md (next number after the highest existing PROP-NNN),
using the exact Proposal contract there, filling EVERY field -- leading with **> Decision** and
**> Risk** exactly as a human capture would: Risk High means it touches data/sync/storage, auth,
security, or the AI Dev OS itself (say High whenever unsure); everything else is Low. Do NOT invent
a `source captures` id -- write `source: /audit (this run)` instead.

Then update planning/AUDIT_SUMMARY.md's 'App summary' and 'Already-surfaced findings' sections (prose)
to reflect what you now know, so a FUTURE audit doesn't need to re-derive it or re-propose the same
thing. Do NOT touch the '## State' section or its two lines (last-audited-commit/last-full-refresh)
-- a script updates those deterministically after this run, not you.

Do NOT edit $codeFilesList -- you are reading the app, never changing it. Do NOT write to
planning/ROADMAP.md, planning/BUILD_QUEUE.md, or TASKS.md. Do NOT commit or push (not available to
you this session).
"@

# ---------------------------------------------------------------- Invoke Claude (stdin, PS5.1-safe;
#     restricted tools -- read-only against the app, write-only to the two files above) ------------
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $prompt | claude -p `
        --allowedTools "Read" "Glob" "Grep" "Edit" "Write" `
        2>$null | Tee-Object -FilePath $logFile -Append
} finally {
    $ErrorActionPreference = $prevEAP
}
if ($LASTEXITCODE -ne 0) { Write-Result "ABORTED: claude -p exited with code $LASTEXITCODE. Nothing committed."; exit 2 }

# ---------------------------------------------------------------- Commit-scope guard (deterministic,
#     same fail-fast shape as run-claude.ps1's Phase 2b) --------------------------------------------
$allowedPatterns = @('^planning/PROPOSALS\.md$', '^planning/AUDIT_SUMMARY\.md$')
$changed = @(Invoke-Git -C $root status --porcelain | ForEach-Object { $_.Substring(3).Trim() } | Where-Object { $_ })
$violations = @($changed | Where-Object { $path = $_; -not ($allowedPatterns | Where-Object { $path -match $_ }) })
if ($violations.Count -gt 0) {
    Write-Result "HALTED: audit touched file(s) outside its allowed surface: $($violations -join ', '). NOT committed -- inspect and revert by hand."
    exit 1
}
if ($changed.Count -eq 0) {
    Write-Result "Audit ran but found nothing new to propose."
    exit 0
}

# ---------------------------------------------------------------- Auto-promote (D-042), reusing the
#     exact same trusted, deterministic script the human-capture path uses -- no duplicated logic.
#     Claude's own commit-scope guard just passed, so we know it only touched PROPOSALS.md/
#     AUDIT_SUMMARY.md; Invoke-AutoPromote.ps1 is not an LLM, so it doesn't need a second adversarial
#     check the way Claude's own output does -- it's reviewed, tested code, and only ever touches
#     PROPOSALS.md (status) + BUILD_QUEUE.md. This is what makes a same-press "find AND build" possible
#     when /go's idle fallback triggers this: whatever's Decision:Approve + Risk:Low from THIS audit
#     is immediately queue-ready, not just sitting in PROPOSALS.md waiting for a later run. ------------
try { & "$root\tools\Invoke-AutoPromote.ps1" | Tee-Object -FilePath $logFile -Append }
catch { Write-Result "HALTED: Invoke-AutoPromote.ps1 threw an error after a clean audit: $_"; exit 1 }

# ---------------------------------------------------------------- Deterministically stamp the state
#     lines (never let the LLM guess a commit SHA or today's date) ----------------------------------
$summaryText = Get-Content $summaryPath -Raw -Encoding UTF8
$summaryText = [regex]::Replace($summaryText, '(?m)^-\s*last-audited-commit:.*$', "- last-audited-commit: $headSha")
if ($needsFullRefresh) {
    $today = Get-Date -Format 'yyyy-MM-dd'
    $summaryText = [regex]::Replace($summaryText, '(?m)^-\s*last-full-refresh:.*$', "- last-full-refresh: $today")
}
[System.IO.File]::WriteAllText($summaryPath, $summaryText, $utf8)

$newPropCount = @([regex]::Matches((Get-Content $proposals -Raw -Encoding UTF8), '(?m)^-\s*source:\s*/audit \(this run\)')).Count
$autoPromotedCount = @([regex]::Matches((Get-Content $proposals -Raw -Encoding UTF8), '(?m)^-\s*\*\*status:\*\*\s*approved\s+\d{4}-\d{2}-\d{2}\s*\(auto-promoted')).Count

Invoke-Git -C $root add planning/PROPOSALS.md planning/AUDIT_SUMMARY.md planning/BUILD_QUEUE.md | Out-Null
Invoke-Git -C $root commit -m "audit: $newPropCount new proposal(s) from /audit" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Result "HALTED: git commit failed after a clean audit."; exit 1 }
# Retry with rebase, not reset (D-047/D-048 addendum, TASK-031) -- found by auditing every
# push-to-main call site after Run-Merge.ps1's own unretried push silently lost a completed merge to
# a race with Dispatch-Commands.ps1's OUTBOX-reply retry logic (D-047). This site had the same shape.
$pushed = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
    Invoke-Git -C $root push origin main | Out-Null
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    if ($attempt -eq 5) { break }
    Invoke-Git -C $root fetch origin | Out-Null
    $rebaseOutput = Invoke-Git -C $root rebase origin/main 2>&1
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root rebase --abort | Out-Null
        Write-Result "Audit committed locally, but the push kept losing a race with something else advancing origin/main, and rebasing onto the new tip conflicted. Resolve by hand at the PC: git rebase origin/main (on main), then git push origin main.`n`n$rebaseOutput"
        exit 1
    }
    Start-Sleep -Milliseconds (300 * $attempt)
}
if (-not $pushed) {
    Write-Result "Audit committed locally, but PUSH FAILED after 5 attempt(s) -- kept losing the race with something else advancing origin/main. Run 'git push origin main' at the PC as soon as possible."
    exit 1
}

$mode = if ($needsFullRefresh) { "full re-scan" } else { "incremental" }
$needsReply = $newPropCount - $autoPromotedCount
Write-Result "Audit ($mode) found $newPropCount new proposal(s): $autoPromotedCount auto-promoted straight to the build queue (Decision Approve + Risk Low), $needsReply still need your reply. See planning/PROPOSALS.md."
exit 0
