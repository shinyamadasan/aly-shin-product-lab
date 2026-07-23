<#
.SYNOPSIS
  Generate the "Codex-ready tasks" notice from TASKS.md (deterministic; no LLM).

.DESCRIPTION
  Parses TASKS.md for tasks with `status: codex` (ready for Codex to pick up, not yet started,
  not blocked, not in review) and writes a Telegram-ready notice to planning/CODEX_READY.md.

  STRUCTURED OUTPUT ONLY. This script does NOT message anyone — delivery is n8n's job: n8n reads
  planning/CODEX_READY.md from GitHub on the morning schedule (alongside DIGEST.md) and sends it to
  Telegram only when there is at least one Codex-ready task. (Separation of duties: Claude/PC produces
  structured output; n8n owns all messaging — mirrors Generate-Digest.ps1.)

  Source is pure ASCII; all emoji/symbols are built from code points so it runs the same under
  Windows PowerShell 5.1 (Task Scheduler) regardless of file encoding.
#>
param([string]$OutFile)

$ErrorActionPreference = 'Stop'
function U([int]$cp) { [char]::ConvertFromUtf32($cp) }
$g = @{ robot = U 0x1F916; dot = U 0x00B7; dash = U 0x2014; arrow = U 0x2192 }

$root  = Split-Path $PSScriptRoot -Parent
$tasks = Join-Path $root 'TASKS.md'
if (-not $OutFile) { $OutFile = Join-Path $root 'planning/CODEX_READY.md' }

# This exact string is the contract n8n's IF node checks for — keep them in sync.
$NONE_PLACEHOLDER = 'No Codex-ready tasks right now.'

$raw = Get-Content $tasks -Raw -Encoding UTF8
# Only the real task list (everything before the template comment block).
$body = ($raw -split '<!-- TASK TEMPLATE')[0]

# One match per task block. \p{Pd} matches any dash (the em-dash/middle-dot after the id).
$blocks = [regex]::Matches($body, '(?ms)^###\s+(?<id>TASK-\d+)\s*\p{Pd}?\s*[·•]?\s*(?<title>.+?)\r?\n(?<rest>.*?)(?=^###\s|\z)')

$items = foreach ($b in $blocks) {
    $rest = $b.Groups['rest'].Value
    $mStatus = [regex]::Match($rest, '(?m)^status:\s*(?<s>\w+)')
    if (-not $mStatus.Success -or $mStatus.Groups['s'].Value -ne 'codex') { continue }
    [pscustomobject]@{
        Id    = $b.Groups['id'].Value
        Title = $b.Groups['title'].Value.Trim()
    }
}

$items = @($items)

if ($items.Count -eq 0) {
    $notice = $NONE_PLACEHOLDER
} else {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("$($g.robot) *Codex-Ready Tasks ($($items.Count))*")
    $lines.Add('Run Codex locally and say "Continue" to pick these up.')
    $lines.Add('')
    foreach ($it in $items) {
        $lines.Add("*$($it.Id)* $($g.dot) $($it.Title)")
    }
    $notice = ($lines -join "`n")
}

# Structured output: write the file n8n will read + send. No messaging here.
[System.IO.File]::WriteAllText($OutFile, $notice + "`n", (New-Object System.Text.UTF8Encoding($false)))
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $notice
Write-Host "`n[wrote $OutFile - n8n sends it to Telegram if non-empty]"
