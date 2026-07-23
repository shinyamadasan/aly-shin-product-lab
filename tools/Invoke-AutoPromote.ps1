<#
.SYNOPSIS
  Auto-promotes Decision:Approve + Risk:Low proposals straight into BUILD_QUEUE.md (D-042).

.DESCRIPTION
  Triage only ever recommends -- this is the mechanical act of moving a proposal into the build
  queue without waiting for a human reply, and it only ever fires when BOTH conditions hold:
    - the proposal's own recommended `Decision` is Approve
    - the proposal's own recommended `Risk` is Low (the same reversible-vs-red-zone criteria
      DECISIONS.md D-032 already uses at merge time, applied here at idea time instead)
  Anything else -- any other Decision, Risk: High, or a proposal with no Risk field at all (e.g. one
  written before this field existed) -- is left completely untouched and still waits for a human
  Approve/Park/Reject/Clarify reply via Apply-Decisions.ps1, exactly as before this existed.

  Deterministic, no LLM call -- same "code for deterministic transforms" principle as
  Apply-Decisions.ps1, which this mirrors: same BUILD_QUEUE.md block shape, same PROPOSALS.md status
  rewrite, so downstream stages (Plan Conversion, /suggest-equivalent reporting) can't tell an
  auto-promoted item from a human-approved one except by reading the status note.

  Does NOT commit or push -- called from run-claude.ps1 between Phase 2 (Claude's Triage session) and
  Phase 2b (the commit-scope guard), which already includes planning/PROPOSALS.md and
  planning/BUILD_QUEUE.md in its allow-list and commits whatever changed.

.EXAMPLE
  ./tools/Invoke-AutoPromote.ps1
  ./tools/Invoke-AutoPromote.ps1 -DryRun
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root      = Split-Path $PSScriptRoot -Parent
$proposals = Join-Path $root 'planning/PROPOSALS.md'
$buildq    = Join-Path $root 'planning/BUILD_QUEUE.md'
$today     = Get-Date -Format 'yyyy-MM-dd'
$utf8      = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $proposals)) { Write-Host 'No PROPOSALS.md found.'; return }

$propText = Get-Content $proposals -Raw -Encoding UTF8
$bqText   = if (Test-Path $buildq) { Get-Content $buildq -Raw -Encoding UTF8 } else { '' }
$nextBq   = 1 + (([regex]::Matches($bqText, 'BQ-(\d+)') | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Maximum).Maximum)
if (-not $nextBq) { $nextBq = 1 }

# Only the pending section (everything before the contract template), matching every other reader
# of this file (Apply-Decisions.ps1, Generate-Digest.ps1).
$pendingSection = ($propText -split '## Proposal contract')[0]
$blocks = [regex]::Matches($pendingSection, '(?ms)^###\s+(?<id>PROP-\d+)\s+\p{Pd}\s+(?<title>.+?)\r?\n(?<body>.*?)(?=^###\s|\z)')

$promoted = @()   # log lines
$bqAdds   = @()   # new BUILD_QUEUE blocks

foreach ($b in $blocks) {
    $body = $b.Groups['body'].Value

    $statusM = [regex]::Match($body, '\*\*status:\*\*\s*(?<s>\w+)')
    if ($statusM.Success -and $statusM.Groups['s'].Value -ne 'pending') { continue }   # already decided

    # Lenient on exact bold/punctuation styling -- only the verdict WORD matters, same tolerance
    # Generate-Digest.ps1 already applies to the Decision field.
    $decM  = [regex]::Match($body, '(?i)Decision:\s*(?<v>\w+)')
    $riskM = [regex]::Match($body, '(?i)Risk:\s*(?<v>Low|High)\b')

    if (-not $decM.Success -or $decM.Groups['v'].Value -notmatch '(?i)^Approve$') { continue }
    if (-not $riskM.Success -or $riskM.Groups['v'].Value -notmatch '(?i)^Low$') { continue }   # no Risk field, or High -> never auto-promote

    $propId = $b.Groups['id'].Value
    $title  = $b.Groups['title'].Value.Trim()

    # Replace this proposal's status line (scoped to its own block via the id anchor), same pattern
    # Apply-Decisions.ps1 uses for a human-approved reply.
    $propText = [regex]::Replace($propText,
        "(?ms)(^###\s+$propId\s+\p{Pd}.*?^- \*\*status:\*\*)[^\r\n]*",
        "`$1 approved $today (auto-promoted: Decision Approve + Risk Low, D-042)")
    $promoted += "  $propId -> approved (auto-promoted)  ($title)"

    $mPri = [regex]::Match($body, 'AI-recommended priority:\*\*\s*\**(?<p>P\d)')
    $pri  = if ($mPri.Success) { $mPri.Groups['p'].Value } else { 'P?' }
    # The REASON text after the bold closes (e.g. "Low effort, clearly wanted..."), not the verdict
    # word itself -- same pattern Apply-Decisions.ps1 already uses for the human-approved case.
    $mDec = [regex]::Match($body, '\*\*[^*\n]*?Decision:\s*.+?\*\*\s*(?<r>.+?)(\r?\n|$)')
    $what = if ($mDec.Success) { $mDec.Groups['r'].Value.Trim() } else { $title }
    $bqId = 'BQ-{0:000}' -f $nextBq; $nextBq++
    $bqAdds += @"
### $bqId $([char]0x2014) $title
- source: $propId $([char]0x00B7) priority: $pri $([char]0x00B7) approved: $today (auto-promoted, Risk: Low)
- build: $what
- detail: see $propId in planning/PROPOSALS.md (evidence, ambiguity, likely files)
"@
}

if ($promoted.Count -eq 0) { Write-Host 'No Decision:Approve + Risk:Low proposals to auto-promote.'; return }

if ($bqAdds.Count -gt 0) {
    $block = ($bqAdds -join "`n`n")
    $placeholder = '(?im)^[_*].*(empty|awaiting next sprint).*$'
    if ($bqText -match $placeholder) {
        $bqText = $bqText -replace $placeholder, $block
    } else {
        $bqText = $bqText.TrimEnd() + "`n`n" + $block + "`n"
    }
}

Write-Host "Auto-promoted ($today):"
$promoted | ForEach-Object { Write-Host $_ }
Write-Host "`nQueued to BUILD_QUEUE: $($bqAdds.Count) item(s)."

if ($DryRun) { Write-Host "`n[DryRun] No files written."; return }

[System.IO.File]::WriteAllText($proposals, $propText, $utf8)
[System.IO.File]::WriteAllText($buildq, $bqText.TrimEnd() + "`n", $utf8)
Write-Host "`nWrote PROPOSALS.md + BUILD_QUEUE.md."
