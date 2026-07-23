# Run this ONCE to register the Telegram-command dispatcher.
#
# Windows: run from an Administrator PowerShell; registers a Task Scheduler task.
# macOS  : run with `pwsh ./setup-command-dispatcher-scheduler.ps1`; registers a launchd agent.
#
# SLEEP-AND-WAKE MODEL (DECISIONS D-033):
#   This task DOES use -WakeToRun, and fires every 30 minutes -- not every 2.
#
#   The original design polled every 2 minutes with WakeToRun OFF, on the assumption that the PC was
#   always on. It isn't: the PC sleeps after 15 min idle. With WakeToRun off, a /go sent from the
#   phone would just sit in the repo until someone physically woke the machine -- remote development
#   was impossible. With WakeToRun ON, a 2-minute interval would wake the PC ~720x/day and defeat
#   sleeping entirely. 30 minutes is the balance: the PC sleeps, wakes on the half-hour to drain any
#   queued command (build -> review -> merge -> deploy), then idles back to sleep.
#
#   Nothing is lost while asleep: n8n writes commands into the repo via GitHub, and
#   -StartWhenAvailable drains the whole backlog on the next wake.
#
#   Dispatch-Commands.ps1 asserts ES_SYSTEM_REQUIRED for the life of its process, so a 10-15 minute
#   Codex build dispatched from a timer-wake cannot be suspended mid-flight by the unattended-sleep
#   timer.
#
#   Every app installed by the AI Dev OS uses this SAME 30-minute interval, deliberately -- never
#   staggered. Aligned triggers mean ONE wake of the PC serves EVERY app. Staggering them would wake
#   the machine once per app for no benefit. The apps cannot collide: each repo has its own
#   automation.lock.
#
# To change the cadence: edit -RepetitionInterval below and re-run this script.

# Platform. PowerShell 7 defines $IsWindows; Windows PowerShell 5.1 does NOT (it is $null, which is
# FALSY) -- so check for null explicitly, or 5.1 would take the macOS branch and register nothing.
$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }

$taskName   = "Aly & Shin Product Lab Command Dispatcher"

# Homebrew's pwsh is a thin apphost that locates the .NET runtime through DOTNET_ROOT or a small set
# of default paths -- none of which Homebrew installs into. An interactive shell usually gets away
# with it, but launchd does NOT read the shell profile, so the plist must carry DOTNET_ROOT itself or
# every scheduled run dies before PowerShell starts with "You must install .NET to run this
# application." Prefer the version-independent `opt` symlink over the Cellar path a `dotnet` lookup
# resolves to, so a `brew upgrade dotnet` doesn't silently break the plist.
function Resolve-DotnetRoot {
    @(
        $env:DOTNET_ROOT
        '/opt/homebrew/opt/dotnet/libexec'
        '/usr/local/share/dotnet'
        (Join-Path $HOME '.dotnet')
        (Get-Command dotnet -ErrorAction SilentlyContinue) | ForEach-Object {
            Join-Path (Split-Path (Split-Path (Get-Item $_.Source).ResolvedTarget -Parent) -Parent) 'libexec'
        }
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'shared/Microsoft.NETCore.App')) } | Select-Object -First 1
}

# =============================================================================================
# macOS -- launchd. Not a translation of the Windows path: a genuinely different power model.
#
# Windows sleeps deeply and is woken every 30 minutes by a WakeToRun timer. macOS HAS NO
# EQUIVALENT -- `pmset repeat wakeorpoweron` supports exactly ONE repeating wake per day. A
# sleeping Mac would therefore sit on a queued /go until somebody touched it, silently, which is
# the precise failure the sleep-and-wake model exists to prevent.
#
# So on macOS the machine STAYS AWAKE and launchd's 30-minute interval fires reliably. On a Mac
# mini -- a desktop that sits there anyway, idling around 7W -- that is the right trade: a few
# watts for a remote loop that actually works. The display still sleeps.
# =============================================================================================
if (-not $OnWindows) {
    $dispatchScript = "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab/tools/Dispatch-Commands.ps1"
    $label    = "com.aidevos.aly-shin-product-lab.dispatcher"
    $plistDir = Join-Path $HOME 'Library/LaunchAgents'
    $plist    = Join-Path $plistDir "$label.plist"
    $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $pwshPath) {
        Write-Host "FAILED: 'pwsh' is not on PATH. Install PowerShell 7:  brew install powershell" -ForegroundColor Red
        exit 1
    }
    $dotnetRoot = Resolve-DotnetRoot
    if (-not $dotnetRoot) {
        Write-Host "FAILED: pwsh is installed but no .NET runtime was found. Install it:  brew install dotnet" -ForegroundColor Red
        exit 1
    }

    New-Item -ItemType Directory -Path $plistDir -Force | Out-Null

    # StartInterval is seconds. RunAtLoad drains anything queued while the job was unloaded.
    @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$pwshPath</string>
    <string>-NoProfile</string>
    <string>-File</string>
    <string>$dispatchScript</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>DOTNET_ROOT</key><string>$dotnetRoot</string></dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab/claude-session.log</string>
  <key>StandardErrorPath</key><string>C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab/claude-session.log</string>
</dict>
</plist>
"@ | Set-Content -Path $plist -Encoding UTF8

    # bootout first so re-running this script is safe (the launchd equivalent of Unregister).
    & launchctl bootout "gui/$(id -u)/$label" 2>$null | Out-Null
    & launchctl bootstrap "gui/$(id -u)" $plist 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { & launchctl load -w $plist 2>$null | Out-Null }   # older macOS fallback

    Write-Host ""
    Write-Host "launchd job loaded: $label" -ForegroundColor Green
    Write-Host "Runs tools/Dispatch-Commands.ps1 every 30 minutes."
    Write-Host ""
    Write-Host "ONE MORE STEP -- keep the Mac awake, or none of this fires:" -ForegroundColor Yellow
    Write-Host "  sudo pmset -a sleep 0 displaysleep 10"
    Write-Host ""
    Write-Host "  macOS cannot be woken on a 30-minute timer the way Windows can, so a sleeping Mac"
    Write-Host "  would just sit on your queued /go until you touched it -- silently. Staying awake is"
    Write-Host "  what makes remote work actually work. The display still sleeps; a Mac mini idles at"
    Write-Host "  roughly 7W."
    Write-Host ""
    Write-Host "Verify with:" -ForegroundColor Cyan
    Write-Host "  launchctl list | grep $label        # a PID or 0 in the first column = loaded"
    Write-Host "  pmset -g | grep ' sleep'            # expect: sleep 0"
    exit 0
}

# =============================================================================================
# Windows -- Task Scheduler (below). Sleeps deeply, woken every 30 min by WakeToRun.
# =============================================================================================
$scriptPath = "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab\tools\Dispatch-Commands.ps1"

# Remove existing task if it exists (so re-running this script is safe)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""

# A single "Once" trigger with a repetition interval is Task Scheduler's standard way to express
# "run every N minutes, indefinitely" -- StartBoundary is "now" so it begins immediately.
# RepetitionDuration is deliberately NOT [TimeSpan]::MaxValue: that serializes to an ISO-8601
# duration (P99999999DT23H59M59S) that Task Scheduler's XML schema rejects as out of range --
# confirmed live, and Register-ScheduledTask throws but doesn't stop the script, so a prior run of
# this file printed a false "Task registered" success message while nothing was actually created.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# -WakeToRun: wake the sleeping PC to drain queued Telegram commands (D-033).
# -StartWhenAvailable: if a scheduled fire was missed (PC off), run as soon as it can.
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -WakeToRun `
    -MultipleInstances IgnoreNew

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Wakes the PC every 30 min to drain captures/commands/ (Telegram control commands: /status /next /go /run /build /review /stop /enable /disable) and dispatch them. Sleep-and-wake model: DECISIONS D-033." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Host ""
    Write-Host "FAILED to register '$taskName': $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Are you running this as Administrator? Set-ScheduledTask/Register-ScheduledTask require it." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Task registered: '$taskName'" -ForegroundColor Green
Write-Host "Wakes the PC every 30 minutes to drain queued Telegram commands (WakeToRun, D-033)." -ForegroundColor Green
Write-Host ""
Write-Host "Verify with:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Select-Object State, @{n='Wake';e={`$_.Settings.WakeToRun}}, @{n='Every';e={`$_.Triggers[0].Repetition.Interval}}"
Write-Host "Expect: Ready | True | PT30M"
Write-Host ""
Write-Host "To test now: Right-click the task in Task Scheduler > Run"
Write-Host "Output log: $((Split-Path (Split-Path $scriptPath)))\claude-session.log (shared with run-claude.ps1)"
