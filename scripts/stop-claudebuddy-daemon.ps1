[CmdletBinding()]
param(
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$Node = "node",
  [int]$TimeoutSec = 5
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$configObject = $null
try {
  $configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
} catch {
  Write-Warning "Could not read config; continuing with PID-file stop only: $($_.Exception.Message)"
}
$pidValue = Get-ClaudeBuddyPid -PidFile $pidFilePath
$process = Get-ClaudeBuddyProcess -PidValue $pidValue
$daemonProcessName = Get-ClaudeBuddyProcessNameFromCommand -Command $Node -Fallback "node"

if ($null -eq $process) {
  if ($null -ne $pidValue) {
    Write-Warning "Removing stale PID file for pid=$pidValue"
    Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
  } else {
    Write-Host "ClaudeBuddy daemon is not running."
  }
  exit 0
}

if (-not (Test-ClaudeBuddyProcessName -Process $process -Names @($daemonProcessName, "node"))) {
  Write-Warning "PID file points at pid=$pidValue process=$($process.ProcessName), not the ClaudeBuddy daemon; removing stale PID file."
  Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
  exit 0
}

$sidecarPid = $null
if ($null -ne $configObject) {
  try {
    $runtimeStatus = Invoke-ClaudeBuddyControl -Config $configObject -Path "/status" -TimeoutSec 2
    if ($null -ne $runtimeStatus -and $runtimeStatus.ok -eq $true -and $null -ne $runtimeStatus.status.sidecar.pid) {
      $sidecarPid = [int]$runtimeStatus.status.sidecar.pid
    }
  } catch {
    Write-Warning "Could not query sidecar pid before stopping: $($_.Exception.Message)"
  }
}

Write-Host "Stopping ClaudeBuddy daemon. pid=$pidValue"
Stop-Process -InputObject $process -ErrorAction SilentlyContinue

$deadline = (Get-Date).AddSeconds([Math]::Max(0, $TimeoutSec))
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $currentProcess = Get-ClaudeBuddyProcess -PidValue $pidValue
  if ($null -eq $currentProcess -or -not (Test-ClaudeBuddyProcessName -Process $currentProcess -Names @($daemonProcessName, "node"))) {
    break
  }
}

$currentProcess = Get-ClaudeBuddyProcess -PidValue $pidValue
if ($null -ne $currentProcess -and (Test-ClaudeBuddyProcessName -Process $currentProcess -Names @($daemonProcessName, "node"))) {
  Write-Warning "Daemon did not stop within $TimeoutSec second(s); forcing termination."
  Stop-Process -InputObject $currentProcess -Force -ErrorAction SilentlyContinue
} elseif ($null -ne $currentProcess) {
  Write-Warning "PID $pidValue is now process=$($currentProcess.ProcessName); skipping force-stop."
}

if ($null -ne $sidecarPid -and $sidecarPid -gt 0) {
  $sidecarDeadline = (Get-Date).AddMilliseconds([Math]::Max(1500, [Math]::Max(0, $TimeoutSec) * 1000))
  do {
    $sidecarProcess = Get-ClaudeBuddyProcess -PidValue $sidecarPid
    if ($null -eq $sidecarProcess) {
      break
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $sidecarDeadline)

  $sidecarProcess = Get-ClaudeBuddyProcess -PidValue $sidecarPid
  if ($null -ne $sidecarProcess) {
    if (Test-ClaudeBuddyProcessName -Process $sidecarProcess -Names @("python", "python3", "pythonw", "py")) {
      Write-Warning "Stopping orphaned sidecar process. pid=$sidecarPid"
      Stop-Process -InputObject $sidecarProcess -Force -ErrorAction SilentlyContinue
    } else {
      Write-Warning "Sidecar pid=$sidecarPid is now process=$($sidecarProcess.ProcessName); skipping force-stop."
    }
  }
}

Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
Write-Host "ClaudeBuddy daemon stopped."
exit 0
