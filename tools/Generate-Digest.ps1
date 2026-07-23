<#
.SYNOPSIS
  Phase 2 - generate the morning Proposal Digest from planning/PROPOSALS.md (deterministic; no LLM).

.DESCRIPTION
  Parses each pending proposal's title + Decision line, groups by recommended action
  (Approve / Clarify / Park / Reject), preserves the in-file priority order within each group,
  and writes a Telegram-ready digest to planning/DIGEST.md (and stdout).

  STRUCTURED OUTPUT ONLY. This script does NOT message anyone — delivery is n8n's job: n8n reads
  planning/DIGEST.md from GitHub on a morning schedule and sends it to Telegram. (Separation of duties:
  Claude/PC produces structured output; n8n owns all messaging.)

  Source is pure ASCII; all emoji/symbols are built from code points so it runs the same under
  Windows PowerShell 5.1 (Task Scheduler) regardless of file encoding.
#>
param([string]$OutFile)

$ErrorActionPreference = 'Stop'
function U([int]$cp) { [char]::ConvertFromUtf32($cp) }
$g = @{
    sun = U 0x1F305; target = U 0x1F3AF; check = U 0x2705; q = U 0x2753
    zzz = U 0x1F4A4; bin = U 0x1F5D1; dot = U 0x00B7; dash = U 0x2014; arrow = U 0x2192
}

$root      = Split-Path $PSScriptRoot -Parent
$proposals = Join-Path $root 'planning/PROPOSALS.md'
$roadmap   = Join-Path $root 'planning/ROADMAP.md'
if (-not $OutFile) { $OutFile = Join-Path $root 'planning/DIGEST.md' }

$raw = Get-Content $proposals -Raw -Encoding UTF8
# Only the pending section (everything before the contract template).
$pending = ($raw -split '## Proposal contract')[0]

# Current Objective (the bold lead phrase under the heading).
$objective = 'unset'
$mObj = [regex]::Match((Get-Content $roadmap -Raw -Encoding UTF8), 'Current Objective\s*\r?\n\*\*(?<o>.+?)\*\*')
if ($mObj.Success) { $objective = $mObj.Groups['o'].Value.Trim() }

# One match per proposal block. \p{Pd} matches any dash (the em-dash after the id).
$blocks = [regex]::Matches($pending, '(?ms)^###\s+(?<id>PROP-\d+)\s+\p{Pd}\s+(?<title>.+?)\r?\n(?<body>.*?)(?=^###\s|\z)')

$items = foreach ($b in $blocks) {
    $body = $b.Groups['body'].Value
    # Only undecided proposals belong in the digest — skip anything already approved/parked/rejected.
    $mStatus = [regex]::Match($body, '\*\*status:\*\*\s*(?<s>\w+)')
    if ($mStatus.Success -and $mStatus.Groups['s'].Value -ne 'pending') { continue }
    if (-not [regex]::IsMatch($body, 'Decision:')) {
        Write-Warning "Proposal $($b.Groups['id'].Value) has no Decision line - omitted from digest."
        continue
    }
    $mDec = [regex]::Match($body, '\*\*[^*\n]*?Decision:\s*(?<full>.+?)\*\*\s*(?<reason>.+?)(\r?\n|$)')
    if (-not $mDec.Success) { continue }
    $full    = $mDec.Groups['full'].Value.Trim().TrimEnd('.')   # "Approve" or "Approve (Option A - descope)"
    $verdict = ([regex]::Match($full, '^\w+')).Value            # Approve | Park | Reject | Clarify
    [pscustomobject]@{
        Num     = ($b.Groups['id'].Value -replace 'PROP-0*', '')
        Title   = $b.Groups['title'].Value.Trim()
        Verdict = $verdict
        Full    = $full
        Reason  = $mDec.Groups['reason'].Value.Trim()
    }
}

$today = Get-Date -Format 'ddd dd MMM'
$total = @($items).Count

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("$($g.sun) *Aly & Shin Product Lab $($g.dash) Morning Digest*")
$lines.Add("$today $($g.dot) $total proposals waiting $($g.dot) $($g.target) Objective: *$objective*")
$lines.Add("")

$groups = [ordered]@{
    'Approve' = @{ icon = $g.check; label = 'RECOMMEND APPROVE' }
    'Clarify' = @{ icon = $g.q;     label = 'NEEDS A QUICK ANSWER (Clarify)' }
    'Park'    = @{ icon = $g.zzz;   label = 'RECOMMEND PARK' }
    'Reject'  = @{ icon = $g.bin;   label = 'RECOMMEND REJECT' }
}

foreach ($v in $groups.Keys) {
    $grp = @($items | Where-Object { $_.Verdict -eq $v })
    if ($grp.Count -eq 0) { continue }
    $lines.Add("$($groups[$v].icon) *$($groups[$v].label) ($($grp.Count))*")
    foreach ($it in $grp) {
        $tail = if ($it.Full -ne $it.Verdict) { " _($($it.Full))_" } else { "" }
        $lines.Add("*$($it.Num)* $($g.dot) $($it.Title)")
        $lines.Add("   $($g.arrow) $($it.Reason)$tail")
    }
    $lines.Add("")
}

$lines.Add($g.dash)
$lines.Add('*Reply:* `Accept` (take all my recs) ' + $g.dot + ' `Approve all` ' + $g.dot + ' `Approve 14-19` ' + $g.dot + ' `Park 7` ' + $g.dot + ' `Reject 12`')
$lines.Add('Approved ' + $g.arrow + ' built next run. Silence ' + $g.arrow + ' nothing happens.')

$digest = ($lines -join "`n")

# Structured output: write the file n8n will read + send. No messaging here.
[System.IO.File]::WriteAllText($OutFile, $digest + "`n", (New-Object System.Text.UTF8Encoding($false)))
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $digest
Write-Host "`n[wrote $OutFile - n8n sends it to Telegram]"
