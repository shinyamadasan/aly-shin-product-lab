<#
.SYNOPSIS
  Remote-control dispatcher. Reads captures/commands/*.md (status: new), routes each to its phase
  runner, writes exactly one reply per command to captures/replies/.

.DESCRIPTION
  Recognizes: /status /next /go /run /build /review /merge /audit /stop /enable /disable /log
  /go is the everyday command: it does whatever /next recommends (run planning, build, or review),
  and falls back to /audit when there's genuinely nothing else to do (D-043).
  /run /build /review /audit still work directly as manual overrides, to force a specific phase out
  of order. /merge lands a held red-zone task in two steps. See captures/commands/README.md for the
  command-file contract and docs/09-automation.md for the full design.

  Lock-protected (automation.lock, gitignored) so this can never overlap itself, an interactively
  triggered phase runner, or the twice-daily run-claude.ps1 -- all three share the same lock file.
  A lock older than 2 hours (this repo's Task Scheduler execution-time limit) is treated as stale
  and cleared rather than blocking forever on a crashed run.

  Every command is idempotent: /build and /review check the current task status before acting;
  /enable, /disable, /stop just set a flag to a value; /status and /next are pure reads.

  Replies accumulate in captures/replies/OUTBOX.md (append-only, same idiom as DIGEST.md /
  CODEX_READY.md) rather than one file per command -- n8n's short-interval relay
  (n8n-telegram-replies.json) fetches it, sends it if it has real content, then clears it back to the
  placeholder via a GitHub PUT. This means a burst of several commands between poll cycles arrives as
  one combined Telegram message, not a flood of separate ones.

.EXAMPLE
  ./tools/Dispatch-Commands.ps1              # process all new commands for real
  ./tools/Dispatch-Commands.ps1 -DryRun      # show what each would do, mutate nothing
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root         = Split-Path $PSScriptRoot -Parent
$cmdDir       = Join-Path $root 'captures/commands'
$replyDir     = Join-Path $root 'captures/replies'
$outboxFile   = Join-Path $replyDir 'OUTBOX.md'
$handoffFile  = Join-Path $root 'HANDOFF.md'
$lockFile     = Join-Path $root 'automation.lock'
$tasksFile    = Join-Path $root 'TASKS.md'
$runClaude    = Join-Path $root 'run-claude.ps1'
$logFile      = Join-Path $root 'claude-session.log'
$utf8         = New-Object System.Text.UTF8Encoding($false)
$NO_REPLIES   = 'No pending replies.'

# KEEP-AWAKE (D-033). This task runs on a WakeToRun timer, so it can be the thing that woke a
# sleeping PC. A /build it then dispatches runs Codex for 10-15 minutes -- long enough for Windows'
# unattended-sleep timer to suspend the machine mid-build and leave a half-finished branch. Assert
# ES_SYSTEM_REQUIRED for the life of this process (ES_CONTINUOUS), which also covers the phase
# runners it invokes and waits on. Windows releases it automatically when this process exits, so the
# PC idles back to sleep on its own once the queue is drained.
# Platform. PowerShell 7 defines $IsWindows; Windows PowerShell 5.1 does NOT (it is $null, which is
# FALSY) -- check for null explicitly, or 5.1 takes the macOS branch and loses its keep-awake.
$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }
$caffeinate = $null

if ($OnWindows) {
    try {
        Add-Type -Namespace Win32Power -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@ -ErrorAction Stop
        # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
        [void][Win32Power.Native]::SetThreadExecutionState(0x80000001)
    } catch {
        # Non-fatal: worst case Windows may sleep mid-build; the lock + idempotent commands make a
        # retry safe on the next wake.
    }
} else {
    # macOS: `caffeinate -i -w <pid>` keeps the machine awake for exactly as long as the given PID
    # lives, then releases. Same contract as ES_CONTINUOUS -- tied to THIS process, so the Mac idles
    # back to sleep on its own once the queue is drained, with no cleanup to forget.
    # Without it, a 10-15 minute build gets suspended halfway and leaves a half-finished branch.
    try {
        $caffeinate = Start-Process -FilePath 'caffeinate' -ArgumentList @('-i', '-w', $PID) -PassThru -ErrorAction Stop
    } catch {
        # Non-fatal, same as above.
    }
}

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

function Write-Reply {
    param([string]$Id, [string]$Text)
    if ($DryRun) { Write-Host "[DRY RUN] would append to OUTBOX.md:`n$Text"; return }
    $existing = if (Test-Path $outboxFile) { (Get-Content $outboxFile -Raw -Encoding UTF8).Trim() } else { '' }
    $entry = "## $Id`n$(Get-Date -Format o)`n`n$Text"
    $newContent = if ($existing -eq '' -or $existing -eq $NO_REPLIES) { $entry } else { "$existing`n`n---`n`n$entry" }
    [System.IO.File]::WriteAllText($outboxFile, $newContent + "`n", $utf8)
}

# n8n's independent reply-clearing step (n8n-telegram-replies.json) polls OUTBOX.md and pushes its
# own commit to main on its own schedule -- uncoordinated with this script. A plain commit-then-push
# with no retry silently loses the race whenever the two land close together: our push gets rejected
# (non-fast-forward), and since the result was never checked, the commit just sits unpushed locally,
# later surfacing as a spurious rebase conflict on some unrelated branch (hit five times in one
# session before this fix -- see docs/AI_OS_NOTES.md). Both commit sites below only ever touch a file
# THIS SCRIPT owns (captures/commands/*.md's own status field, or OUTBOX.md's own content) and the
# commit was never seen by anyone else, so it is always safe to discard on rejection and reapply the
# same change on top of the fresh tip -- $Reapply re-derives the change from current values in scope
# (never from the stale pre-reset file), so a retry is never stale by construction.
function Invoke-CommitPushWithRetry {
    param([string]$Message, [scriptblock]$Reapply, [int]$MaxAttempts = 5)
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        Invoke-Git -C $root diff --cached --quiet
        if ($LASTEXITCODE -eq 0) { return $true }   # nothing staged -- already matches origin
        Invoke-Git -C $root commit -m $Message | Out-Null
        Invoke-Git -C $root push origin main | Out-Null
        if ($LASTEXITCODE -eq 0) { return $true }
        if ($attempt -lt $MaxAttempts) {
            Invoke-Git -C $root fetch origin | Out-Null
            Invoke-Git -C $root reset --hard origin/main | Out-Null
            & $Reapply
            Start-Sleep -Milliseconds (300 * $attempt)
        }
    }
    $false
}

function Get-Branch { (Invoke-Git -C $root branch --show-current) }
function Get-DirtyCount { @(Invoke-Git -C $root status --porcelain).Count }

# $AUTOMATION_ENABLED is the one master flag for everything that mutates the repo unattended OR
# on remote command -- /status, /next, /enable, /disable, and /stop always work regardless of it
# (you need to be able to inspect and flip the switch even while it's off), but /run, /build,
# /review, and /go all refuse to act while it's false, exactly like the scheduled run does. Without
# this check, /run would silently invoke run-claude.ps1, which would itself no-op on the flag with a
# less obvious message -- this makes the refusal explicit and immediate instead.
function Test-AutomationEnabled {
    $flagLine = Select-String -Path $runClaude -Pattern '\$AUTOMATION_ENABLED\s*=\s*\$(true|false)' | Select-Object -First 1
    [bool]($flagLine -and $flagLine.Matches[0].Groups[1].Value -eq 'true')
}

function Get-StatusReply {
    $enabled  = if (Test-AutomationEnabled) { 'enabled' } else { 'disabled' }
    $branch   = Get-Branch
    $dirty    = Get-DirtyCount
    $tree     = if ($dirty -eq 0) { 'clean' } else { "dirty ($dirty changes)" }
    $lastLine = Get-Content "$root\claude-session.log" -Tail 1 -ErrorAction SilentlyContinue
    $codexReady  = if (Test-Path $tasksFile) { @(Select-String -Path $tasksFile -Pattern '^status:\s*codex\s*$').Count } else { 0 }
    $reviewReady = if (Test-Path $tasksFile) { @(Select-String -Path $tasksFile -Pattern '^status:\s*review\s*$').Count } else { 0 }
    $lockState = if (Test-Path $lockFile) { 'BUSY (a run is in progress)' } else { 'idle' }
    @"
Automation: $enabled - Branch: $branch ($tree) - $lockState
Last log line: $lastLine
Codex-ready: $codexReady - Review-ready: $reviewReady
"@
}

# Single source of truth for both /next (report) and /go (report + act). Returns a structured
# recommendation: which task, whose turn, and which phase-runner action /go should take.
# 'blocked' and 'approved' map to action 'status' -- both need a human decision (unblock, or inspect
# older pre-auto-merge state), not something /go can safely do on its own.
function Get-NextAction {
    if (-not (Test-Path $tasksFile)) { return @{ Action = 'status'; Message = 'No TASKS.md found.' } }
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $body = ($text -split '<!-- TASK TEMPLATE')[0]
    $blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[·•]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')
    $priority = @(
        @{ s = 'blocked';     owner = 'you (Claude)'; action = 'status'; note = 'blocked -- needs your decision, see the blocker note in TASKS.md' }
        @{ s = 'review';      owner = 'Claude';        action = 'review' }
        @{ s = 'approved';    owner = 'you';           action = 'status'; note = 'approved -- inspect older pre-auto-merge state' }
        @{ s = 'codex';       owner = 'Codex';         action = 'build' }
        @{ s = 'in-progress'; owner = 'Codex';         action = 'build' }
        @{ s = 'todo';        owner = 'Claude';        action = 'run' }
    )
    foreach ($p in $priority) {
        foreach ($b in $blocks) {
            $m = [regex]::Match($b.Groups['rest'].Value, '(?m)^status:\s*(?<s>[\w-]+)')
            if ($m.Success -and $m.Groups['s'].Value -eq $p.s) {
                return @{ TaskId = $b.Groups['id'].Value; Title = $b.Groups['title'].Value.Trim(); Status = $p.s; Owner = $p.owner; Action = $p.action; Message = $p.note }
            }
        }
    }
    # Per-item check, not whole-file: BUILD_QUEUE.md routinely accumulates old deferred entries
    # alongside genuinely ready ones (confirmed live -- 4 unrelated "Deferred by Builder" notes
    # masked 6 real approved, non-deferred items including a P1 bug, making /go always conclude
    # "nothing approved waiting". A block only counts as deferred if ITS OWN note says so.
    $bqText = Get-Content (Join-Path $root 'planning/BUILD_QUEUE.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    $bqBlocks = if ($bqText) { [regex]::Matches($bqText, '(?ms)^###\s+BQ-\d+.*?(?=^###\s+BQ-\d+|\z)') } else { @() }
    if ($bqBlocks | Where-Object { $_.Value -notmatch '(?i)\*\*Deferred' } | Select-Object -First 1) {
        return @{ Action = 'run'; Owner = 'Claude'; Message = 'An approved BUILD_QUEUE item is waiting to be converted.' }
    }
    return @{ Action = 'status'; Owner = 'you'; Message = 'No active task, nothing approved waiting.' }
}

function Get-NextReply {
    $n = Get-NextAction
    if ($n.TaskId) {
        $line = "task: $($n.TaskId) - $($n.Title) [$($n.Status)]`nowner: $($n.Owner)`nrun: $($n.Action)"
        if ($n.Message) { $line += "`nnote: $($n.Message)" }
        return $line
    }
    return "owner: $($n.Owner)`nrun: $($n.Action)`nnote: $($n.Message)"
}

# Shared by /build and /go's autopilot. Returns BOTH the human result string and the runner's exit
# code -- the autopilot loop classifies on the exit code, standalone /build just uses .Result.
# ($a, not $args: $args is a PowerShell automatic variable and must not be shadowed.)
function Invoke-BuildPhase {
    # Hashtable splat, NOT array (D-041): PowerShell array splatting binds POSITIONALLY, not by
    # name, so an array holding just '-DryRun' happens to not crash here (no competing mandatory
    # positional parameter) but silently never actually activates -DryRun on the target script.
    $a = @{}; if ($DryRun) { $a['DryRun'] = $true }
    & (Join-Path $root 'tools\Run-Codex-Build.ps1') @a
    $code = $LASTEXITCODE
    $resultFile = Join-Path $root '.last-phase-result.txt'
    $res = if (Test-Path $resultFile) { $r = (Get-Content $resultFile -Raw).Trim(); Remove-Item $resultFile -Force; $r }
           else { "Build phase runner exited with code $code and left no result -- check claude-session.log." }
    [pscustomobject]@{ Result = $res; ExitCode = $code }
}

# Shared by /review and /go's autopilot.
function Invoke-ReviewPhase {
    # Hashtable splat, NOT array (D-041): see Invoke-BuildPhase's comment above.
    $a = @{}; if ($DryRun) { $a['DryRun'] = $true }
    & (Join-Path $root 'tools\Run-Claude-Review.ps1') @a
    $code = $LASTEXITCODE
    $resultFile = Join-Path $root '.last-phase-result.txt'
    $res = if (Test-Path $resultFile) { $r = (Get-Content $resultFile -Raw).Trim(); Remove-Item $resultFile -Force; $r }
           else { "Review phase runner exited with code $code and left no result -- check claude-session.log." }
    [pscustomobject]@{ Result = $res; ExitCode = $code }
}

# /merge -- land a HELD red-zone branch from the phone, in two steps.
#
# D-032 holds red-zone work (data/sync/storage, auth, security, the OS itself) because a human should
# see what it touches before something irreversible lands. Note what that gate actually wants: it
# wants you to have LOOKED. It never wanted you to be sitting at a desk -- that was incidental, and
# it just meant a held branch could sit for days while you were away.
#
# So: two steps, and the FIRST one cannot merge anything.
#   /merge TASK-014       -> replies with what the diff touches + the reviewer's own recorded reason
#                            for holding it. main is untouched.
#   /merge TASK-014 yes   -> runs the SAME gates as the auto-merge and fast-forwards main.
#
# The summary is the speed bump. It makes ignoring the diff a deliberate act instead of a reflex --
# which is the only honest thing a one-word text message can be asked to protect against.
function Invoke-MergePhase {
    param([string]$CommandBody)

    # The command file keeps the operator's full message in its body, so the args survive even though
    # the `command:` frontmatter field holds only the bare verb.
    $m = [regex]::Match($CommandBody, '(?im)^/merge\b\s*(?<rest>.*)$')
    $rest = if ($m.Success) { $m.Groups['rest'].Value.Trim() } else { '' }

    $idM = [regex]::Match($rest, '(?i)\b(?<id>TASK-\d+)\b')
    if (-not $idM.Success) {
        return "Usage: /merge TASK-014   (shows what it touches)`nThen:  /merge TASK-014 yes   (lands it)"
    }
    $taskId    = $idM.Groups['id'].Value.ToUpper()
    $confirmed = $rest -match '(?i)\b(yes|confirm)\b'

    # Hashtable splat, NOT array (D-041): PowerShell array splatting binds POSITIONALLY, so
    # '-TaskId' itself would bind to Run-Merge.ps1's mandatory $TaskId parameter, leaving the real
    # task id nowhere to go -- crashes the whole dispatcher on every /merge. Confirmed live.
    $a = @{ TaskId = $taskId }
    if ($confirmed) { $a['Confirm'] = $true }
    if ($DryRun)    { $a['DryRun'] = $true }

    & (Join-Path $root 'tools\Run-Merge.ps1') @a
    $code = $LASTEXITCODE
    $resultFile = Join-Path $root '.last-phase-result.txt'
    if (Test-Path $resultFile) { $r = (Get-Content $resultFile -Raw).Trim(); Remove-Item $resultFile -Force; return $r }
    return "Merge phase runner exited with code $code and left no result -- check claude-session.log."
}

function Invoke-AuditPhase {
    $a = @{}; if ($DryRun) { $a['DryRun'] = $true }
    & (Join-Path $root 'tools\Run-Audit.ps1') @a
    $code = $LASTEXITCODE
    $resultFile = Join-Path $root '.last-phase-result.txt'
    $res = if (Test-Path $resultFile) { $r = (Get-Content $resultFile -Raw).Trim(); Remove-Item $resultFile -Force; $r }
           else { "Audit phase runner exited with code $code and left no result -- check claude-session.log." }
    [pscustomobject]@{ Result = $res; ExitCode = $code }
}

# Shared by /run and /go's autopilot.
function Invoke-RunPhase {
    if ($DryRun) { return [pscustomobject]@{ Result = "[DRY RUN] would run planning ($runClaude, no -Scheduled)"; ExitCode = 0 } }
    & $runClaude
    $code = $LASTEXITCODE
    $res = switch ($code) {
        0 { "Planning run completed (exit 0). See claude-session.log for detail." }
        1 { "Planning run HALTED mid-run (exit 1) -- a safety guard caught something out of scope. See STATUS.md / claude-session.log." }
        2 { "Planning run ABORTED at Preflight (exit 2) -- an environment/repo-state problem. See claude-session.log." }
        default { "Planning run exited with unexpected code $code. See claude-session.log." }
    }
    [pscustomobject]@{ Result = $res; ExitCode = $code }
}

# ===================== AUTOPILOT (mission-based /go) ==========================================
# /go owns "missions", not phases. A mission = one approved item driven through review and auto-merge. The loop
# calls the same phase runners as /run /build /review -- it only SEQUENCES them, so every preflight,
# fail-fast halt, and commit-scope guard inside those runners is preserved untouched. Ownership flips
# (Claude plan -> Codex build -> Claude review) are internal and never a stop; only real external
# conditions end a run. See docs/DECISIONS.md D-026.

$AUTOPILOT_MAX_ACTIONS = 10           # Plan / Build / Review each count as one AI action
$AUTOPILOT_MAX_MINUTES  = 30          # wall-clock budget; whichever limit trips first ends the run
$AUTO_NOTE = 'auto:'                  # prefix marking blocker notes AUTOPILOT itself wrote (never touch human-set blocks)

# Parse every task block once: id, title, status, priority (P1<P2<P3, default P3), depends-on list,
# and its blocker note (first line). This is the single source the loop reasons over.
function Get-TaskTable {
    if (-not (Test-Path $tasksFile)) { return @() }
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $body = ($text -split '<!-- TASK TEMPLATE')[0]
    $blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[·•]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')
    $out = @()
    foreach ($b in $blocks) {
        $rest = $b.Groups['rest'].Value
        $status = ([regex]::Match($rest, '(?m)^status:\s*(?<s>[\w-]+)')).Groups['s'].Value
        $pm = [regex]::Match($rest, '(?m)^priority:\s*P(?<p>[0-9])')
        $priority = if ($pm.Success) { [int]$pm.Groups['p'].Value } else { 3 }
        $dm = [regex]::Match($rest, '(?m)^depends-on:\s*(?<d>.+)$')
        $deps = @()
        if ($dm.Success -and $dm.Groups['d'].Value.Trim() -notmatch '^(none|n/a|-)$') {
            $deps = @($dm.Groups['d'].Value -split '[,\s]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^TASK-\d+$' })
        }
        $bn = [regex]::Match($rest, '(?ms)^blocker:\s*\r?\n\s*-\s*(?<n>.+?)$')
        $note = if ($bn.Success) { $bn.Groups['n'].Value.Trim() } else { '' }
        $out += [pscustomobject]@{
            Id = $b.Groups['id'].Value; Title = $b.Groups['title'].Value.Trim()
            Status = $status; Priority = $priority; Deps = $deps; Note = $note
        }
    }
    $out
}

# A dependency is satisfied only if its task branch is already merged into main.
function Test-DepsSatisfied {
    param($Task, $MergedBranches)
    foreach ($d in $Task.Deps) {
        $depBranch = ($d -replace 'TASK-', 'task-').ToLower()
        if ($depBranch -notin $MergedBranches) { return $false }
    }
    $true
}

# Isolate ONE task's block from the whole file so per-task edits can never bleed into a neighbouring
# task (a `.*?` over the full file will happily cross `###` boundaries and grab another task's
# blocker line -- exactly the bug this guards against). Returns Pre/Block/Post substrings, or $null.
function Split-TaskBlock {
    param([string]$Text, [string]$TaskId)
    $m = [regex]::Match($Text, "(?ms)^###\s+$TaskId\b.*?(?=^###\s|^<!--|\z)")
    if (-not $m.Success) { return $null }
    @{ Pre = $Text.Substring(0, $m.Index); Block = $m.Value; Post = $Text.Substring($m.Index + $m.Length) }
}

# AUTOPILOT's own escalation: pull a task out of Codex's candidate set by setting it blocked with an
# `auto:` note. This is how skip-and-continue works despite Codex self-selecting the first status:codex
# task -- and the note doubles as persistent, human-visible state (strike count / merge-wait reason).
function Set-TaskBlockedAuto {
    param([string]$TaskId, [string]$Note)
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $s = Split-TaskBlock -Text $text -TaskId $TaskId
    if (-not $s) { return }
    $blk = [regex]::Replace($s.Block, '(?m)^status:[^\r\n]*', 'status: blocked')
    if ($blk -match '(?m)^blocker:\s*$') {
        # replace the first bullet under an existing blocker: header (bounded to this block)
        $blk = [regex]::Replace($blk, '(?ms)(^blocker:\s*\r?\n\s*-\s*).+?(\r?\n)', "`${1}$AUTO_NOTE $Note`$2")
    } else {
        # no blocker yet -> insert one immediately after the (now blocked) status line
        $blk = [regex]::Replace($blk, '(?m)^(status:\s*blocked[^\r\n]*\r?\n)', "`$1blocker:`n  - $AUTO_NOTE $Note`n", 1)
    }
    if (-not $DryRun) { [System.IO.File]::WriteAllText($tasksFile, ($s.Pre + $blk + $s.Post), $utf8) }
}

# Set a task's status field only (no blocker manipulation). Used as a defensive no-op after
# auto-merge -- the reviewed branch already carries `done` onto main, but this keeps older
# non-auto-merge outcomes from being re-picked by a later /go. See docs/DECISIONS.md D-026/D-027.
function Set-TaskStatus {
    param([string]$TaskId, [string]$NewStatus)
    $text = Get-Content $tasksFile -Raw -Encoding UTF8
    $s = Split-TaskBlock -Text $text -TaskId $TaskId
    if (-not $s) { return }
    $blk = [regex]::Replace($s.Block, '(?m)^status:[^\r\n]*', "status: $NewStatus")
    if (-not $DryRun) { [System.IO.File]::WriteAllText($tasksFile, ($s.Pre + $blk + $s.Post), $utf8) }
}

# Count of approved, non-deferred BUILD_QUEUE items not yet reflected as a task (i.e. still to plan).
function Get-UnconvertedBQCount {
    $bqText = Get-Content (Join-Path $root 'planning/BUILD_QUEUE.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $bqText) { return 0 }
    $tasksText = if (Test-Path $tasksFile) { Get-Content $tasksFile -Raw -Encoding UTF8 } else { '' }
    $n = 0
    foreach ($m in [regex]::Matches($bqText, '(?ms)^###\s+(?<id>BQ-\d+).*?(?=^###\s+BQ-\d+|\z)')) {
        if ($m.Value -match '(?i)\*\*Deferred') { continue }
        if ($tasksText -notmatch [regex]::Escape("source: $($m.Groups['id'].Value)")) { $n++ }
    }
    $n
}

function Get-UntriagedCaptureCount {
    $inbox = Join-Path $root 'captures/inbox'
    if (-not (Test-Path $inbox)) { return 0 }
    $n = 0
    foreach ($f in (Get-ChildItem -Path $inbox -Filter '*.md' -File)) {
        $raw = Get-Content $f.FullName -Raw -Encoding UTF8
        if ($raw -match '(?m)^status:\s*new\s*$') { $n++ }
    }
    $n
}

function Get-RecentCommitSummary {
    $lines = @(Invoke-Git -C $root log --oneline -5)
    if ($LASTEXITCODE -ne 0 -or -not $lines) { return '- none' }
    (($lines | ForEach-Object { "- $_" }) -join "`n")
}

function Get-ActiveTaskSummary {
    $active = Get-TaskTable |
        Where-Object { $_.Status -in @('blocked','approved','review','codex','in-progress','todo') } |
        Select-Object -First 1
    if (-not $active) { return '- none' }
    $line = "- $($active.Id): $($active.Title) [$($active.Status)]"
    if ($active.Note) { $line += "`n- note: $($active.Note)" }
    $line
}

function Get-NewThreadPrompt {
@"
Continue this app from this repo.
Read HANDOFF.md, AGENTS.md, CLAUDE.md, TASKS.md, and CODEMAP.md if present.
Use Next or /next to resume from the repo state; do not rely on previous chat context.
"@
}

function New-HandoffContent {
    param([string]$Reason, [string]$Reply)
    $generated = Get-Date -Format o
    $branch = Get-Branch
    $head = (Invoke-Git -C $root rev-parse --short HEAD | Select-Object -First 1)
    if (-not $head) { $head = 'unknown' }
    $dirty = Get-DirtyCount
    $tree = if ($dirty -eq 0) { 'clean' } else { "dirty ($dirty changes)" }
    $next = (Get-NextReply).Trim()
    $active = Get-ActiveTaskSummary
    $recent = Get-RecentCommitSummary
    $prompt = Get-NewThreadPrompt

@"
# HANDOFF

> Auto-generated by tools/Dispatch-Commands.ps1 at clean thread-reset checkpoints.

Generated: $generated
Reason: $Reason

## Current State
- Branch: $branch
- HEAD: $head
- Working tree: $tree

## Last Automation Reply
```text
$Reply
```

## Next Action
```text
$next
```

## Active Task
$active

## Recent Commits
$recent

## New Thread Prompt
```text
$prompt
```

## Reset Rule
Start a new AI thread after this checkpoint when you want a clean context. Do not reset in the
middle of a dirty branch, failing tests, unresolved rework, or a blocker without a clear note.
"@
}

function Publish-HandoffCheckpoint {
    param([string]$Reason, [string]$Reply)
    if ($DryRun) { return "[DRY RUN] would update HANDOFF.md ($Reason)" }

    $stagedBefore = @(Invoke-Git -C $root diff --cached --name-only)
    if ($stagedBefore.Count -gt 0) {
        return "skipped HANDOFF.md update because staged changes already exist."
    }

    $apply = {
        $content = New-HandoffContent -Reason $Reason -Reply $Reply
        [System.IO.File]::WriteAllText($handoffFile, $content + "`n", $utf8)
        Invoke-Git -C $root add HANDOFF.md | Out-Null
    }
    & $apply

    Invoke-Git -C $root diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { return "HANDOFF.md already current." }

    $ok = Invoke-CommitPushWithRetry -Message "automation: update thread handoff" -Reapply $apply
    if ($ok) { return "updated HANDOFF.md." }
    "could not push HANDOFF.md after retries; update it at the PC before starting a new thread."
}

function Add-ThreadResetCheckpoint {
    param([string]$Command, [string]$Reply)
    $reason = $null
    if ($Command -in @('go','build','review')) {
        if ($Reply -match '(?m)^APPROVED:' -or $Reply -match '(?is)\bAPPROVED\b.*\bauto-merged\b.*\bmain\b') {
            $reason = 'approved task merged to main'
        } elseif ($Reply -match '(?m)^Nothing to do -- no approved work is build-ready\.') {
            $reason = 'clean idle: no approved work is build-ready'
        }
    } elseif ($Command -eq 'merge' -and $Reply -match '(?m)^MERGED:') {
        $reason = 'held red-zone task merged to main'
    }
    if (-not $reason) { return $Reply }

    $handoff = Publish-HandoffCheckpoint -Reason $reason -Reply $Reply
    $prompt = Get-NewThreadPrompt
    "$Reply`n`nThread reset checkpoint: $handoff`nNew thread prompt:`n$prompt"
}

# Commit + push a TASKS.md status change autopilot just made (no-op in DryRun / when nothing staged).
function Publish-TasksChange {
    param([string]$Message)
    if ($DryRun) { return }
    Invoke-Git -C $root add TASKS.md | Out-Null
    Invoke-Git -C $root diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root commit -m $Message | Out-Null
        # Retry with rebase, not reset (D-047/D-048 addendum, TASK-031) -- found by auditing every
        # push-to-main call site after Run-Merge.ps1's own unretried push silently lost a completed
        # merge to a race with this SAME script's own OUTBOX-reply retry logic (D-047). This site is
        # the most exposed of all of them: it runs earlier in the very same Dispatch-Commands.ps1
        # invocation that later calls Invoke-CommitPushWithRetry for the reply, so an unretried
        # failure here sat one push-race away from being reset away by that later call, same as
        # Run-Merge.ps1's merge was. No result string to bubble up (this function has always been
        # fire-and-forget for its 5 callers in Invoke-Autopilot) -- log a warning instead of staying
        # silent, rather than widen this function's contract for every caller just for this.
        $pushed = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            Invoke-Git -C $root push origin main | Out-Null
            if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
            if ($attempt -eq 5) { break }
            Invoke-Git -C $root fetch origin | Out-Null
            $rebaseOutput = Invoke-Git -C $root rebase origin/main 2>&1
            if ($LASTEXITCODE -ne 0) {
                Invoke-Git -C $root rebase --abort | Out-Null
                Add-Content -Path $logFile -Value "[Dispatch-Commands] Publish-TasksChange: push kept losing a race and rebasing conflicted -- '$Message' is stuck on local main, unpushed. Resolve by hand.`n$rebaseOutput"
                return
            }
            Start-Sleep -Milliseconds (300 * $attempt)
        }
        if (-not $pushed) {
            Add-Content -Path $logFile -Value "[Dispatch-Commands] Publish-TasksChange: push failed after 5 attempt(s) -- '$Message' is stuck on local main, unpushed. Resolve by hand."
        }
    }
}

# ONE mission per /go: release retryable auto-blocks -> plan once if nothing is build-ready ->
# build exactly one dependency-satisfied task (auto-blocking any dep-blocked higher-priority ones
# ahead of it) -> auto-review -> auto-merge if approved -> report. The build runner auto-chains its
# own review internally; every preflight/guard inside it is untouched. See docs/DECISIONS.md D-026/D-027.
function Invoke-Autopilot {
    $start = Get-Date
    $actions = 0

    # --- Release AUTOPILOT's own past auto-blocks that are ready to retry. Rework strikes < 3 get
    #     another attempt; merge-waiters clear once their dependency branch is merged. Human-set
    #     blocks (no `auto:` prefix) are never touched. ---
    $merged = @(Invoke-Git -C $root branch --merged main | ForEach-Object { $_.TrimStart('*').Trim() } | Where-Object { $_ })
    $released = $false
    foreach ($t in (Get-TaskTable | Where-Object { $_.Status -eq 'blocked' -and $_.Note -like "$AUTO_NOTE*" })) {
        if ($t.Note -match 'waiting on merge of (?<dep>TASK-\d+)') {
            if ((($Matches['dep'] -replace 'TASK-', 'task-').ToLower()) -in $merged) { Set-TaskStatus -TaskId $t.Id -NewStatus 'codex'; $released = $true }
        } elseif ($t.Note -match 'strike (?<n>\d)/3' -and [int]$Matches['n'] -lt 3) {
            Set-TaskStatus -TaskId $t.Id -NewStatus 'codex'; $released = $true
        }
    }
    if ($released) { Publish-TasksChange 'autopilot: release auto-blocked task(s) for retry' }

    # --- Plan once if there is approved work or untriaged captures but nothing build-ready yet. ---
    $planned = 0
    $unconvertedBefore = Get-UnconvertedBQCount
    $untriagedBefore = Get-UntriagedCaptureCount
    $triageOnlyPlan = ($unconvertedBefore -eq 0 -and $untriagedBefore -gt 0)
    if (-not (Get-TaskTable | Where-Object { $_.Status -eq 'codex' }) -and ($unconvertedBefore -gt 0 -or $untriagedBefore -gt 0)) {
        if (-not (Test-AutomationEnabled)) { return "Autopilot: automation disabled -- nothing done." }
        $before = @(Get-TaskTable | Where-Object { $_.Status -eq 'codex' }).Count
        $rp = Invoke-RunPhase; $actions++
        if ($rp.ExitCode -ne 0) { return "Autopilot stopped in planning: $($rp.Result)" }
        $planned = @(Get-TaskTable | Where-Object { $_.Status -eq 'codex' }).Count - $before
    }

    # --- Idle fallback (D-043): genuinely nothing queued anywhere -- no codex-status task, nothing
    #     unconverted in BUILD_QUEUE. This is the ONLY point /audit ever runs automatically (never on
    #     a schedule); it's naturally rate-limited by there being nothing else to do, and Run-Audit.ps1
    #     itself is naturally rate-limited further by its own git-diff gate (D-043) -- an idle /go
    #     pressed many times with no app changes costs one cheap "nothing changed" check per press,
    #     not a real scan. If the audit auto-promotes something (Decision Approve + Risk Low), plan it
    #     into a real task immediately so the SAME /go press can still build it below -- "find AND
    #     build," not "find, then wait for another press." ---
    $audited = $false
    if (-not (Get-TaskTable | Where-Object { $_.Status -eq 'codex' }) -and (Get-UnconvertedBQCount) -eq 0) {
        if (Test-AutomationEnabled) {
            $ap = Invoke-AuditPhase; $actions++; $audited = $true
            if ($ap.ExitCode -eq 2) { return "Autopilot stopped -- audit: $($ap.Result)" }   # preflight/dirty
            if ($ap.ExitCode -eq 0 -and (Get-UnconvertedBQCount) -gt 0) {
                $before2 = @(Get-TaskTable | Where-Object { $_.Status -eq 'codex' }).Count
                $rp2 = Invoke-RunPhase; $actions++
                if ($rp2.ExitCode -ne 0) { return "Autopilot stopped in planning (post-audit): $($rp2.Result)" }
                $planned += @(Get-TaskTable | Where-Object { $_.Status -eq 'codex' }).Count - $before2
            }
        }
    }

    # --- Build exactly ONE dependency-satisfied task. Codex self-selects the first status:codex task
    #     (AGENTS.md), and planning keeps file order == priority order, so the first codex task is the
    #     highest-priority one. If its dependencies are not yet merged, auto-block it (so Codex skips
    #     to the next satisfied one) and try again -- but still build only ONE task total. ---
    $waiting = @()
    $built = $null
    while ($actions -lt $AUTOPILOT_MAX_ACTIONS -and ((Get-Date) - $start).TotalMinutes -lt $AUTOPILOT_MAX_MINUTES) {
        $next = Get-TaskTable | Where-Object { $_.Status -eq 'codex' } | Select-Object -First 1
        if (-not $next) { break }
        $mergedNow = @(Invoke-Git -C $root branch --merged main | ForEach-Object { $_.TrimStart('*').Trim() } | Where-Object { $_ })
        if (-not (Test-DepsSatisfied -Task $next -MergedBranches $mergedNow)) {
            $depList = ($next.Deps -join ', ')
            Set-TaskBlockedAuto -TaskId $next.Id -Note "waiting on merge of $depList"
            Publish-TasksChange "autopilot: $($next.Id) waiting on merge of $depList"
            $waiting += "$($next.Id) needs $depList merged"
            continue
        }
        if ($DryRun) { return "[DRY RUN] would build $($next.Id) ($($next.Title)) [P$($next.Priority)] next." }

        $r = Invoke-BuildPhase; $actions++
        if ($r.Result -match '-> auto-review:') { $actions++ }
        if ($r.ExitCode -eq 2) { return "Autopilot stopped -- systemic: $($r.Result)" }   # preflight/dirty/wrong-branch

        if ($r.Result -match '(?im)\bAPPROVED\b') {
            Set-TaskStatus -TaskId $next.Id -NewStatus 'done'
            Publish-TasksChange "autopilot: $($next.Id) approved and merged"
            $built = [pscustomobject]@{ Id = $next.Id; P = $next.Priority; Outcome = 'approved' }
        } elseif ($r.Result -match '(?im)REWORK') {
            $prev = if ($next.Note -match 'strike (?<n>\d)/3') { [int]$Matches['n'] } else { 0 }
            $strike = $prev + 1
            $why = if ($r.Result -match '(?ms)REWORK[^\r\n]*?[-:]\s*(?<w>[^\r\n]+)') { ($Matches['w'] -replace '^[-\s]+', '').Trim() } else { 'see REVIEW.md on the branch' }
            Set-TaskBlockedAuto -TaskId $next.Id -Note "review rework, strike $strike/3 -- $why"
            Publish-TasksChange "autopilot: $($next.Id) rework strike $strike/3"
            $built = [pscustomobject]@{ Id = $next.Id; P = $next.Priority; Outcome = "rework (strike $strike/3): $why" }
        } else {   # exit 1: blocked / test-fail / no-progress on this task
            Set-TaskBlockedAuto -TaskId $next.Id -Note "build stopped -- $(($r.Result -replace '\s+',' ').Trim())"
            Publish-TasksChange "autopilot: $($next.Id) build stopped"
            $built = [pscustomobject]@{ Id = $next.Id; P = $next.Priority; Outcome = "build stopped: $(($r.Result -replace '\s+',' ').Trim())" }
        }
        break   # ONE mission per /go
    }

    # --- Summary ---
    $remaining = @(Get-TaskTable | Where-Object { $_.Status -in @('codex','in-progress','todo') }).Count + (Get-UnconvertedBQCount)
    $out = @()
    if ($built) {
        if ($built.Outcome -eq 'approved') {
            $out += "APPROVED: $($built.Id) [P$($built.P)] built + reviewed + merged to main."
        } else {
            $out += "NEEDS YOU: $($built.Id) [P$($built.P)] -- $($built.Outcome)"
            $out += "Branch $(($built.Id -replace 'TASK-','task-').ToLower()) left for inspection."
        }
    } elseif ($waiting.Count -gt 0) {
        $out += "Nothing built -- top task(s) waiting on a merge."
    } elseif ($triageOnlyPlan) {
        $out += "TRIAGED $untriagedBefore new idea(s) into proposals. Reply Approve <n>, then /go."
    } elseif ($audited) {
        $out += $ap.Result   # the audit's own reply already says what it found (or "nothing changed")
    } else {
        $out += "Nothing to do -- no approved work is build-ready."
    }
    if ($planned -gt 0) { $out += "(planned $planned new task(s) this run.)" }
    if ($waiting.Count) { $out += "Waiting on merge: " + ($waiting -join '; ') }
    $out += "Remaining approved work: $remaining."
    $out += if ($built -and $built.Outcome -eq 'approved') { "Next: /go." } else { "Next: /go (after resolving the above)." }
    ($out -join "`n")
}

function Set-AutomationFlag {
    param([bool]$Enable)
    $newVal = if ($Enable) { '$true' } else { '$false' }
    if ($DryRun) { return "[DRY RUN] would set `$AUTOMATION_ENABLED = $newVal, commit, push" }
    $content = Get-Content $runClaude -Raw -Encoding UTF8
    $newContent = [regex]::Replace($content, '\$AUTOMATION_ENABLED\s*=\s*\$(true|false)\s*(#[^\r\n]*)?', "`$AUTOMATION_ENABLED = $newVal   # flip to `$true to re-enable overnight automation")
    [System.IO.File]::WriteAllText($runClaude, $newContent, $utf8)
    Invoke-Git -C $root add run-claude.ps1
    Invoke-Git -C $root diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        Invoke-Git -C $root commit -m "automation: $(if ($Enable) {'enable'} else {'disable'}) via Telegram" | Out-Null
        # Retry with rebase, not reset (D-047/D-048 addendum, TASK-031) -- same audit and same
        # reasoning as Publish-TasksChange above. Unlike that one, this function's return value IS
        # surfaced to the operator, so a push failure is reported honestly instead of the previous
        # behavior of always claiming success regardless of whether the push actually landed.
        $pushed = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            Invoke-Git -C $root push origin main | Out-Null
            if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
            if ($attempt -eq 5) { break }
            Invoke-Git -C $root fetch origin | Out-Null
            $rebaseOutput = Invoke-Git -C $root rebase origin/main 2>&1
            if ($LASTEXITCODE -ne 0) {
                Invoke-Git -C $root rebase --abort | Out-Null
                return "Automation $(if ($Enable) {'enabled'} else {'disabled'}) locally, but the push kept losing a race with something else advancing origin/main, and rebasing onto the new tip conflicted. Resolve by hand at the PC: git rebase origin/main (on main), then git push origin main.`n`n$rebaseOutput"
            }
            Start-Sleep -Milliseconds (300 * $attempt)
        }
        if (-not $pushed) {
            return "Automation $(if ($Enable) {'enabled'} else {'disabled'}) locally, but PUSH FAILED after 5 attempt(s) -- kept losing the race with something else advancing origin/main. Run 'git push origin main' at the PC as soon as possible."
        }
    }
    return "Automation $(if ($Enable) {'enabled'} else {'disabled'})."
}

# --- Lock: shared with run-claude.ps1 and the phase runners, so nothing here ever overlaps a
#     twice-daily scheduled run or another dispatcher invocation. ---
if (Test-Path $lockFile) {
    $age = (Get-Date) - (Get-Item $lockFile).LastWriteTime
    if ($age.TotalHours -ge 2) {
        Remove-Item $lockFile -Force
    } else {
        Write-Host "Busy: another automation run is in progress (lock is $([int]$age.TotalMinutes) min old). Exiting without processing commands."
        exit 0
    }
}
if (-not $DryRun) { "$PID`n$(Get-Date -Format o)" | Out-File -FilePath $lockFile -Encoding ascii }

try {
    # n8n pushes new command files straight to origin/main -- this local clone never sees them until
    # something pulls. Without this, the scheduled task ran successfully every 2 minutes but always
    # found "no new commands" because the file only existed on GitHub, not on disk here (confirmed
    # live: a real /go sat unprocessed for 10+ minutes until a human manually ran `git pull`).
    # --ff-only is deliberate: if local ever diverges from origin (shouldn't happen given every phase
    # runner pushes immediately after each commit), fail loud rather than silently merge-committing.
    $pullOutput = Invoke-Git -C $root pull origin main --ff-only
    if ($LASTEXITCODE -ne 0) {
        Write-Host "WARNING: git pull --ff-only failed (exit $LASTEXITCODE): $pullOutput -- proceeding with possibly-stale local state."
    }

    if (-not (Test-Path $cmdDir)) { Write-Host "No captures/commands/ folder found."; return }
    $files = Get-ChildItem -Path $cmdDir -Filter '*.md' -File | Where-Object { $_.Name -ne 'README.md' } | Sort-Object Name
    $new = @()
    foreach ($f in $files) {
        $raw = Get-Content $f.FullName -Raw -Encoding UTF8
        if ($raw -match '(?m)^status:\s*new\s*$') { $new += @{ File = $f; Raw = $raw } }
    }
    if (-not $new) { Write-Host "No new commands."; return }

    foreach ($entry in $new) {
        $f = $entry.File
        $raw = $entry.Raw
        $mId  = [regex]::Match($raw, '(?m)^id:\s*(?<v>\S+)')
        $mCmd = [regex]::Match($raw, '(?m)^command:\s*(?<v>\S+)')
        if (-not $mId.Success -or -not $mCmd.Success) {
            Write-Host "Skipping $($f.Name): missing id/command frontmatter."
            continue
        }
        $id  = $mId.Groups['v'].Value
        $cmd = $mCmd.Groups['v'].Value.ToLower()

        # Mark this command applied and commit it to main BEFORE dispatching to any phase runner.
        # This matters: run-claude.ps1 and Run-Codex-Build.ps1 both require a CLEAN main as their
        # first Preflight check. The incoming command file is itself an uncommitted change the moment
        # n8n writes it -- if we dispatched first and committed after (the original, buggy order),
        # every real /run or /build would abort at Preflight seeing its own not-yet-committed command
        # file as "dirty tree." Committing it first means Preflight sees a clean main, as intended.
        if (-not $DryRun) {
            $markApplied = {
                $newRaw = $raw -replace '(?m)^status:\s*new\s*$', "status: applied`napplied: $(Get-Date -Format o)"
                [System.IO.File]::WriteAllText($f.FullName, $newRaw, $utf8)
                Invoke-Git -C $root add "captures/commands/$($f.Name)"
            }
            & $markApplied
            $ok = Invoke-CommitPushWithRetry -Message "command: /$cmd ($id) received" -Reapply $markApplied
            if (-not $ok) { Write-Host "WARNING: could not push 'received' marker for $id after retries -- left as local uncommitted change." }
        }

        $reply = if ($cmd -in @('run', 'build', 'review', 'go', 'audit') -and -not (Test-AutomationEnabled)) {
            "Automation is disabled (`$AUTOMATION_ENABLED = `$false) -- /$cmd refused to act. Send /enable first if you want this to run."
        } else {
            switch ($cmd) {
                'status'  { Get-StatusReply }
                'next'    { Get-NextReply }
                'enable'  { Set-AutomationFlag -Enable $true }
                'disable' { Set-AutomationFlag -Enable $false }
                'stop' {
                    $msg = Set-AutomationFlag -Enable $false
                    if (Test-Path $lockFile) {
                        $lockPid = (Get-Content $lockFile -First 1)
                        if ($lockPid -and $lockPid -ne "$PID") {
                            try { Stop-Process -Id $lockPid -Force -ErrorAction Stop; $msg += " In-progress run (PID $lockPid) stopped." }
                            catch { $msg += " Could not stop PID $lockPid (may have already finished)." }
                        }
                    }
                    $msg
                }
                'run'    { (Invoke-RunPhase).Result }
                'build'  { (Invoke-BuildPhase).Result }
                'review' { (Invoke-ReviewPhase).Result }
                'go'     { Invoke-Autopilot }
                'merge'  { Invoke-MergePhase -CommandBody $raw }
                'audit'  { (Invoke-AuditPhase).Result }
                'log' {
                    $logTail = Get-Content "$root\claude-session.log" -Tail 40 -ErrorAction SilentlyContinue
                    if ($logTail) { "Last session log (40 lines):`n" + ($logTail -join "`n") } else { "No session log yet." }
                }
                default { "Unrecognized command: '$cmd'." }
            }
        }
        $reply = Add-ThreadResetCheckpoint -Command $cmd -Reply $reply

        Write-Reply -Id $id -Text $reply

        if (-not $DryRun) {
            # Defensive: Run-Codex-Build.ps1 / Run-Claude-Review.ps1 return to main themselves on every
            # clean exit path (see their own comments), but a violation-halt or a claude -p failure
            # deliberately leaves a dirty task branch checked out for human inspection -- in that one
            # case, skip committing the reply to main rather than force a branch switch over dirty
            # files. The reply text itself already explains what happened; it'll be picked up (and the
            # OUTBOX.md entry pushed) on the next tick once a human has resolved that branch by hand.
            $curBranch = Invoke-Git -C $root branch --show-current
            if ($curBranch -eq 'main') {
                # Write-Reply already wrote OUTBOX.md once, above -- the reapply block re-runs it only
                # on a retry (after a reset discards this attempt), never before the first attempt.
                $reapplyReply = { Write-Reply -Id $id -Text $reply; Invoke-Git -C $root add $outboxFile }
                Invoke-Git -C $root add $outboxFile
                $ok = Invoke-CommitPushWithRetry -Message "reply: /$cmd ($id)" -Reapply $reapplyReply
                if (-not $ok) { Write-Host "WARNING: could not push reply for /$cmd ($id) after retries -- left as local uncommitted change." }
            } else {
                Write-Host "Not on main (on '$curBranch') after /$cmd -- likely a halted build/review left for inspection. Reply written locally to OUTBOX.md but not committed/pushed this tick."
            }
        }
        Write-Host "Processed /$cmd ($id)."
    }
} finally {
    if (-not $DryRun) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
}
