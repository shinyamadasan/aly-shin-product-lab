<#
.SYNOPSIS
  Docs-vs-code consistency checker. Flags identifiers the docs reference that the code no longer has.

.DESCRIPTION
  Scans docs/ARCHITECTURE.md, docs/DATA_MODEL.md, docs/DECISIONS.md, and CLAUDE.md for backtick-
  quoted spans that look like function calls, DOM ids, CSS classes/selectors, localStorage keys, or
  object/variable names, then checks whether each one still appears somewhere in the app's own source
  files. A doc referencing a renamed or removed identifier is exactly the kind of silent drift
  CLAUDE.md's own rule ("If docs disagree with code about behavior, fix the docs") depends on someone
  noticing -- this makes that check deterministic and free (CLAUDE.md: "if code can answer, code
  answers" -- no LLM call).

  Deliberately permissive rather than a full parser: wildcards (`render*()`), multi-word spans, and
  file-path references are skipped rather than mis-flagged. False negatives (missing real drift) are
  an acceptable trade for zero false positives on prose that merely looks code-shaped.

.EXAMPLE
  ./tools/Check-DocsConsistency.ps1
#>
param()

$root = Split-Path $PSScriptRoot -Parent
# The app's own source files -- rendered per-app at install time (Install-AiDevOs.ps1's 'index.html', 'style.css', 'app.js'
# token, from that app's config codeFiles key), since this is inherently different for every app.
$appFiles = @('index.html', 'style.css', 'app.js')
# docs/DECISIONS.md and CLAUDE.md document the AI Dev OS / automation layer as well as the app --
# checking their identifiers against app files ALONE floods findings with false positives (PowerShell
# API names, tool script variables, TASKS.md status vocabulary). Each doc gets the code scope that
# actually matches what it describes.
$automationFiles = @('run-claude.ps1', 'AGENTS.md') + (Get-ChildItem (Join-Path $root 'tools') -Filter '*.ps1' | ForEach-Object { "tools/$($_.Name)" })
$docScopes = [ordered]@{
    'docs/ARCHITECTURE.md' = $appFiles
    'docs/DATA_MODEL.md'   = $appFiles
    'docs/DECISIONS.md'    = $appFiles + $automationFiles
    'CLAUDE.md'            = $appFiles + $automationFiles
}

function Get-CodeContent([string[]]$Files) {
    ($Files | ForEach-Object {
        $p = Join-Path $root $_
        if (Test-Path $p) { Get-Content $p -Raw -Encoding UTF8 }
    }) -join "`n"
}

$findings = New-Object System.Collections.Generic.List[pscustomobject]

foreach ($docPath in $docScopes.Keys) {
    $fullPath = Join-Path $root $docPath
    if (-not (Test-Path $fullPath)) { continue }
    $codeContent = Get-CodeContent $docScopes[$docPath]
    $text = Get-Content $fullPath -Raw -Encoding UTF8

    # Skip fenced code blocks (```...```) -- they're illustrative shapes/snippets, not identifier
    # references, and would otherwise flood findings with things like property names and comments.
    $text = [regex]::Replace($text, '(?ms)^```.*?^```', '')

    $spans = [regex]::Matches($text, '`([^`\r\n]+)`') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique

    foreach ($span in $spans) {
        if ($span -match '\*') { continue }                          # wildcard pattern, e.g. render*()
        if ($span -match '\s') { continue }                           # multi-word prose, not an identifier
        if ($span -match '\.(md|js|html|css|json|ps1|txt)$') { continue }  # file reference
        if ($span -match '^[Dd]-\d+$') { continue }                   # decision-record cross-reference
        if ($span -match '^(TASK|BQ)-\d+$') { continue }               # task/queue cross-reference
        if ($span.Length -lt 3) { continue }

        # Extract the bare identifier: strip a leading #/. (id/class selector), trailing (...), and
        # any surrounding quotes, then require what's left to look like exactly one clean identifier.
        $bare = $span
        $bare = $bare -replace '^[#\.]', ''
        $bare = $bare -replace '\(.*\)$', ''
        $bare = $bare -replace "^['‘’]|['‘’]$", ''
        $bare = $bare -replace '^["“”]|["“”]$', ''
        if ($bare -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }

        if ($codeContent -notmatch [regex]::Escape($bare)) {
            $findings.Add([pscustomobject]@{ Doc = $docPath; Span = $span; Identifier = $bare })
        }
    }
}

$appFilesList = $appFiles -join '/'

if ($findings.Count -eq 0) {
    Write-Host "No drift found -- every checkable identifier in $($docScopes.Keys -join ', ') still exists in its code scope ($appFilesList, plus tools/*.ps1 for the automation-scoped docs)."
    exit 0
}

Write-Host "Found $($findings.Count) potential drift item(s):"
$findings | Sort-Object Doc, Identifier | ForEach-Object {
    Write-Host "  [$($_.Doc)] ``$($_.Span)`` -- '$($_.Identifier)' not found in its code scope"
}
exit 1
