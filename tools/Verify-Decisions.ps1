<#
.SYNOPSIS
  Runs every `Verify:` pointer in docs/DECISIONS.md against the current code, reporting any decision
  whose implementation no longer matches what it claims.

.DESCRIPTION
  A decision entry may carry one or more `Verify:` lines using a small, deliberately non-executable
  DSL:
    Verify: <file> contains "<literal text>"
    Verify: <file> does not contain "<literal text>"
  No shell commands, no regex, no eval -- a decision record is prose that other people (and models)
  read and trust; the check itself must stay as inspectable as the prose around it. This is the
  narrower, decision-specific sibling of Check-DocsConsistency.ps1 (D-045): that one catches "this
  identifier doesn't exist anywhere anymore" automatically with no authoring; this one is for a
  decision whose correctness depends on something more specific than existence (a guard clause still
  being in place, a write path still going through both stores) and needs a human to say what to
  check, once, when the decision is recorded.

.EXAMPLE
  ./tools/Verify-Decisions.ps1
#>
param()

$root = Split-Path $PSScriptRoot -Parent
$decisionsFile = Join-Path $root 'docs/DECISIONS.md'
$text = Get-Content $decisionsFile -Raw -Encoding UTF8

# Split into per-decision blocks so each Verify: line is attributed to the right D-NNN, and an
# addendum after D-044 (which shares its heading) doesn't get mis-attributed to the next decision.
$blocks = [regex]::Matches($text, '(?ms)^##\s+(?<id>D-\d+)[^\r\n]*\r?\n(?<body>.*?)(?=^##\s+D-\d+|\z)')

$failures = New-Object System.Collections.Generic.List[pscustomobject]
$checked = 0

foreach ($b in $blocks) {
    $id = $b.Groups['id'].Value
    $body = $b.Groups['body'].Value
    $verifyLines = [regex]::Matches($body, '(?m)^Verify:\s*(?<v>.+)$')

    foreach ($vl in $verifyLines) {
        $line = $vl.Groups['v'].Value.Trim()
        $m = [regex]::Match($line, '^(?<file>\S+)\s+(?<mode>contains|does not contain)\s+"(?<pattern>.*)"$')
        if (-not $m.Success) {
            $failures.Add([pscustomobject]@{ Id = $id; Line = $line
                Reason = 'unparseable Verify: line -- expected: <file> contains "..." | <file> does not contain "..."' })
            continue
        }

        $checked++
        $file = $m.Groups['file'].Value
        $mode = $m.Groups['mode'].Value
        $pattern = $m.Groups['pattern'].Value
        $filePath = Join-Path $root $file

        if (-not (Test-Path $filePath)) {
            $failures.Add([pscustomobject]@{ Id = $id; Line = $line; Reason = "file not found: $file" })
            continue
        }

        $content = Get-Content $filePath -Raw -Encoding UTF8
        $found = $content.Contains($pattern)
        $ok = if ($mode -eq 'contains') { $found } else { -not $found }
        if (-not $ok) {
            $reason = if ($mode -eq 'contains') { "'$pattern' NOT found in $file" } else { "'$pattern' unexpectedly FOUND in $file" }
            $failures.Add([pscustomobject]@{ Id = $id; Line = $line; Reason = $reason })
        }
    }
}

if ($checked -eq 0) {
    Write-Host "No Verify: pointers found in docs/DECISIONS.md."
    exit 0
}

if ($failures.Count -eq 0) {
    Write-Host "All $checked Verify: pointer(s) across docs/DECISIONS.md hold true."
    exit 0
}

Write-Host "$($failures.Count) of $checked Verify: pointer(s) failed:"
$failures | ForEach-Object { Write-Host "  [$($_.Id)] $($_.Line)`n      -- $($_.Reason)" }
exit 1
