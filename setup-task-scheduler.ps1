# Run this ONCE to register the overnight Claude session.
#
# Windows: run from an Administrator PowerShell; registers a Task Scheduler task.
# macOS  : run with `pwsh ./setup-task-scheduler.ps1`; registers a launchd agent.
# After running, the task fires automatically at 9PM and 2AM every night.
# To change the time: edit the -At parameter below and re-run this script

# Platform. PowerShell 7 defines $IsWindows; Windows PowerShell 5.1 does NOT (it is $null, which is
# FALSY) -- check for null explicitly, or 5.1 takes the macOS branch and registers nothing.
$OnWindows = if ($null -eq $IsWindows) { $true } else { $IsWindows }

$taskName = "Aly & Shin Product Lab Claude Overnight"

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

# ---------------------------------------------------------------- macOS: launchd
if (-not $OnWindows) {
    $runScript = "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab/run-claude.ps1"
    $label     = "com.aidevos.aly-shin-product-lab.overnight"
    $plistDir  = Join-Path $HOME 'Library/LaunchAgents'
    $plist     = Join-Path $plistDir "$label.plist"
    $pwshPath  = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
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

    # Two daily runs, same as Windows: 9 PM and 2 AM. StartCalendarInterval takes an ARRAY of dicts
    # for multiple times. Note: -Scheduled is NOT passed on macOS -- on Windows that flag tells the
    # run to sleep the machine afterwards, and a Mac must stay awake for launchd's 30-minute
    # dispatcher to keep firing (macOS has no WakeToRun equivalent).
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
    <string>$runScript</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>DOTNET_ROOT</key><string>$dotnetRoot</string></dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab/claude-session.log</string>
  <key>StandardErrorPath</key><string>C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab/claude-session.log</string>
</dict>
</plist>
"@ | Set-Content -Path $plist -Encoding UTF8

    & launchctl bootout "gui/$(id -u)/$label" 2>$null | Out-Null
    & launchctl bootstrap "gui/$(id -u)" $plist 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { & launchctl load -w $plist 2>$null | Out-Null }

    Write-Host ""
    Write-Host "launchd job loaded: $label" -ForegroundColor Green
    Write-Host "Runs run-claude.ps1 at 9:00 PM and 2:00 AM daily."
    Write-Host ""
    Write-Host "Verify with:  launchctl list | grep $label" -ForegroundColor Cyan
    exit 0
}

# ---------------------------------------------------------------- Windows: Task Scheduler
$scriptPath = "C:/Users/Admin/Desktop/Vibe code/Coffee and Bakery business/05_App_And_Tech/aly-shin-product-lab\run-claude.ps1"

# Remove existing task if it exists (so re-running this script is safe)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Scheduled"

# Two daily runs — 2pm and 6pm
# 2pm: Claude works through task queue, PC stays on
# 6pm: Claude continues where it left off, PC shuts down after
$trigger1 = New-ScheduledTaskTrigger -Daily -At "9:00PM"
$trigger2 = New-ScheduledTaskTrigger -Daily -At "2:00AM"
$trigger = @($trigger1, $trigger2)

$settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Runs Claude Code autonomously on the Aly & Shin Product Lab app. Reads ROADMAP.md and implements the current task." `
    -Force

Write-Host ""
Write-Host "Task registered: '$taskName'" -ForegroundColor Green
Write-Host "Runs at: 9:00 PM and 2:00 AM daily" -ForegroundColor Green
Write-Host "WakeToRun: ON (PC will wake from sleep to run)" -ForegroundColor Green
Write-Host ""
Write-Host "To verify: open Task Scheduler and look for '$taskName'"
Write-Host "To test now: Right-click the task > Run"
Write-Host "Output log: $((Split-Path $scriptPath))\claude-session.log"
