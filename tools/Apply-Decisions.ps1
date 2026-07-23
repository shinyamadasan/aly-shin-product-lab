<#
.SYNOPSIS
  Phase 2 - apply approval replies (captures/decisions/) to PROPOSALS.md + BUILD_QUEUE.md.

.DESCRIPTION
  The "smart apply" half of the reply gate. Deterministic; no LLM (per the "code for deterministic
  transforms" rule). For each captures/decisions/*.md with status: new, it scans the raw reply for
  verbs (approve | park | reject | clarify) + proposal numbers, then:
    - marks each proposal's status in planning/PROPOSALS.md (approved/parked/rejected/clarify)
    - appends each APPROVED proposal as a BQ item in planning/BUILD_QUEUE.md (the Builder's only input)
    - marks the decision file status: applied (idempotent)

  n8n never runs this - it only drops the reply file. This runs on the PC (wired into run-claude.ps1).

.EXAMPLE
  ./tools/Apply-Decisions.ps1 -DryRun     # show what would change, write nothing
  ./tools/Apply-Decisions.ps1             # apply
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root      = Split-Path $PSScriptRoot -Parent
$decDir    = Join-Path $root 'captures/decisions'
$proposals = Join-Path $root 'planning/PROPOSALS.md'
$buildq    = Join-Path $root 'planning/BUILD_QUEUE.md'
$today     = Get-Date -Format 'yyyy-MM-dd'
$utf8      = New-Object System.Text.UTF8Encoding($false)

$statusWord = @{ approve = 'approved'; park = 'parked'; reject = 'rejected'; clarify = 'clarify' }

$files = Get-ChildItem -Path $decDir -Filter '*.md' -File | Where-Object { $_.Name -ne 'README.md' }
if (-not $files) { Write-Host 'No decision files to apply.'; return }

$propText = Get-Content $proposals -Raw -Encoding UTF8
$bqText   = Get-Content $buildq -Raw -Encoding UTF8
$nextBq   = 1 + (([regex]::Matches($bqText, 'BQ-(\d+)') | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Maximum).Maximum)
if (-not $nextBq) { $nextBq = 1 }

$applied = @()   # log lines
$bqAdds  = @()   # new BUILD_QUEUE blocks

foreach ($f in $files) {
    $raw = Get-Content $f.FullName -Raw -Encoding UTF8
    if ($raw -notmatch '(?m)^status:\s*new\s*$') { continue }   # only fresh decisions
    $body = ($raw -split '(?ms)^---\s*$', 3)[2]                  # frontmatter ... --- ... body

    # Convenience commands: expand "accept" / "<verb> all" into an explicit verb+numbers string the
    # clause parser already understands. "accept" applies each pending proposal's own recommended
    # verdict; "<verb> all" applies that verb to every pending proposal.
    if ($body -match '(?i)\baccept\b' -or $body -match '(?i)\b(approve|park|reject|clarify)\s+all\b') {
        $pend = @{}   # pending PROP number -> its recommended verdict (from the ▶ Decision line)
        foreach ($m in [regex]::Matches($propText, '(?ms)^###\s+PROP-0*(?<n>\d+)\s+\p{Pd}\s+.+?\r?\n(?<b>.*?)(?=^###\s|\z)')) {
            if ($m.Groups['b'].Value -notmatch '\*\*status:\*\*\s*pending') { continue }
            $rec = ([regex]::Match($m.Groups['b'].Value, 'Decision:\s*(?<v>\w+)')).Groups['v'].Value.ToLower()
            $pend[[int]$m.Groups['n'].Value] = $rec
        }
        $keys = $pend.Keys | Sort-Object
        if ($body -match '(?i)\baccept\b') {
            $expanded = foreach ($v in 'approve','park','reject','clarify') {
                $ns = @($keys | Where-Object { $pend[$_] -eq $v })
                if ($ns) { "$v " + ($ns -join ' ') }
            }
            $body = ($expanded -join ' ')
        } else {
            $verb = ([regex]::Match($body, '(?i)\b(approve|park|reject|clarify)\s+all\b')).Groups[1].Value.ToLower()
            $body = "$verb " + ($keys -join ' ')
        }
    }

    # Parse clauses: a verb followed immediately by numbers, ranges, spaces or commas.
    # Supports "approve 2 3", "approve 1-10", "approve 2,3 5-7". Prose like "tell me more
    # about 5" has no verb before the number, so it is ignored.
    $clauses = [regex]::Matches($body, '(?im)\b(approve|park|reject|clarify)\b[ \t]*(?<nums>[\d ,\-]+)')
    foreach ($cl in $clauses) {
      $current = $cl.Groups[1].Value.ToLower()
      $numList = New-Object System.Collections.Generic.List[int]
      $numsRaw = $cl.Groups['nums'].Value
      foreach ($rng in [regex]::Matches($numsRaw, '(\d+)\s*-\s*(\d+)')) {        # ranges: 1-10
        $a = [int]$rng.Groups[1].Value; $b = [int]$rng.Groups[2].Value
        if ($a -le $b -and ($b - $a) -le 999) { $a..$b | ForEach-Object { $numList.Add($_) } }
      }
      $singles = [regex]::Replace($numsRaw, '\d+\s*-\s*\d+', ' ')                # loners (ranges stripped)
      foreach ($s in [regex]::Matches($singles, '\d+')) { $numList.Add([int]$s.Value) }
      foreach ($num in ($numList | Sort-Object -Unique)) {
        $propId = 'PROP-{0:000}' -f $num
        $mBlock = [regex]::Match($propText, "(?ms)^###\s+$propId\s+\p{Pd}\s+(?<title>.+?)\r?\n(?<body>.*?)(?=^###\s|\z)")
        if (-not $mBlock.Success) { $applied += "  ! $propId not found (from '$current $num') - skipped"; continue }

        $title = $mBlock.Groups['title'].Value.Trim()
        $newStatus = $statusWord[$current]
        # Idempotency: if it's already in the target status (re-applied reply, or decided a prior run),
        # skip — don't re-stamp or re-queue. Prevents rebuilding already-built work.
        $cur = [regex]::Match($mBlock.Groups['body'].Value, '\*\*status:\*\*\s*(?<s>\w+)')
        if ($cur.Success -and $cur.Groups['s'].Value -eq $newStatus) {
            $applied += "  = $propId already $newStatus - skipped"; continue
        }
        # Replace this proposal's status line (scoped to its block via the id anchor).
        $propText = [regex]::Replace($propText,
            "(?ms)(^###\s+$propId\s+\p{Pd}.*?^- \*\*status:\*\*)[^\r\n]*",
            "`$1 $newStatus $today (via digest reply)")
        $applied += "  $propId -> $newStatus  ($title)"

        if ($current -eq 'approve') {
            $mPri = [regex]::Match($mBlock.Groups['body'].Value, 'AI-recommended priority:\*\*\s*\**(?<p>P\d)')
            $pri  = if ($mPri.Success) { $mPri.Groups['p'].Value } else { 'P?' }
            $mDec = [regex]::Match($mBlock.Groups['body'].Value, '\*\*[^*\n]*?Decision:\s*.+?\*\*\s*(?<r>.+?)(\r?\n|$)')
            $what = if ($mDec.Success) { $mDec.Groups['r'].Value.Trim() } else { $title }
            $bqId = 'BQ-{0:000}' -f $nextBq; $nextBq++
            $bqAdds += @"
### $bqId $([char]0x2014) $title
- source: $propId $([char]0x00B7) priority: $pri $([char]0x00B7) approved: $today (digest reply)
- build: $what
- detail: see $propId in planning/PROPOSALS.md (evidence, ambiguity, likely files)
"@
        }
      }
    }

    # Mark the decision file applied (idempotency).
    $newRaw = $raw -replace '(?m)^status:\s*new\s*$', "status: applied`napplied: $today"
    if (-not $DryRun) { [System.IO.File]::WriteAllText($f.FullName, $newRaw, $utf8) }
}

if ($applied.Count -eq 0) { Write-Host 'No new decisions found.'; return }

# Splice BQ items in under "## Approved sprint", dropping the empty placeholder.
if ($bqAdds.Count -gt 0) {
    $block = ($bqAdds -join "`n`n")
    # Drop whatever "empty" placeholder is there (original `*(empty…)*` or the builder's `_…empty…Awaiting…_`).
    $placeholder = '(?im)^[_*].*(empty|awaiting next sprint).*$'
    if ($bqText -match $placeholder) {
        $bqText = $bqText -replace $placeholder, $block
    } else {
        $bqText = $bqText.TrimEnd() + "`n`n" + $block + "`n"
    }
}

Write-Host "Decisions applied ($today):"
$applied | ForEach-Object { Write-Host $_ }
if ($bqAdds.Count) { Write-Host "`nQueued to BUILD_QUEUE: $($bqAdds.Count) item(s)." }

if ($DryRun) { Write-Host "`n[DryRun] No files written."; return }

[System.IO.File]::WriteAllText($proposals, $propText, $utf8)
[System.IO.File]::WriteAllText($buildq, $bqText.TrimEnd() + "`n", $utf8)
Write-Host "`nWrote PROPOSALS.md + BUILD_QUEUE.md."
