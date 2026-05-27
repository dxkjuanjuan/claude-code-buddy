[CmdletBinding()]
param(
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$Node = "node",
  [int]$ReadyTimeoutSec = 15,
  [switch]$NoWait
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
$logFilePath = Get-ClaudeBuddyConfigLogFile -Config $configObject -ConfigPath $configPath
$daemonProcessName = Get-ClaudeBuddyProcessNameFromCommand -Command $Node -Fallback "node"

$startMutex = [System.Threading.Mutex]::new($false, "Local\ClaudeBuddyStandaloneDaemonStart")
$startMutexOwned = $false
try {
  $startMutexOwned = $startMutex.WaitOne(10000)
} catch [System.Threading.AbandonedMutexException] {
  $startMutexOwned = $true
}
if (-not $startMutexOwned) {
  $startMutex.Dispose()
  throw "Timed out waiting for another ClaudeBuddy daemon start attempt to finish."
}

try {
$existingPid = Get-ClaudeBuddyPid -PidFile $pidFilePath
$existingProcess = Get-ClaudeBuddyProcess -PidValue $existingPid
if ($null -ne $existingProcess) {
  if (Test-ClaudeBuddyProcessName -Process $existingProcess -Names @($daemonProcessName, "node")) {
    Write-Host "ClaudeBuddy daemon already running. pid=$existingPid"
    Write-Host "PID file: $pidFilePath"
    exit 0
  }
  Write-Warning "PID file points at pid=$existingPid process=$($existingProcess.ProcessName), not the ClaudeBuddy daemon; removing stale PID file."
  Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
}

if ($null -ne $existingPid -and $null -eq $existingProcess) {
  Write-Warning "Removing stale PID file for pid=$existingPid"
  Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFilePath) | Out-Null
if (-not [string]::IsNullOrWhiteSpace($logFilePath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logFilePath) | Out-Null
}

try {
  Set-Content -LiteralPath $pidFilePath -Value "" -NoNewline -Encoding ascii -ErrorAction Stop
  Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
} catch {
  throw "PID file is not writable: $pidFilePath ($($_.Exception.Message))"
}

$arguments = Join-ClaudeBuddyArguments -Arguments @("bin\claudebuddy.js", "--config", $configPath)
$process = Start-Process -FilePath $Node -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
try {
  Set-Content -LiteralPath $pidFilePath -Value ([string]$process.Id) -Encoding ascii -ErrorAction Stop
} catch {
  Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue
  throw "Failed to write PID file after starting daemon: $pidFilePath ($($_.Exception.Message))"
}

Start-Sleep -Milliseconds 500
$process.Refresh()
if ($process.HasExited) {
  Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
  throw "ClaudeBuddy daemon exited immediately with code $($process.ExitCode). Check log: $logFilePath"
}

Write-Host "Started ClaudeBuddy daemon. pid=$($process.Id)"
Write-Host "Config: $configPath"
Write-Host "PID file: $pidFilePath"
if (-not [string]::IsNullOrWhiteSpace($logFilePath)) {
  Write-Host "Log file: $logFilePath"
}

if ($NoWait) {
  exit 0
}

$baseUri = Get-ClaudeBuddyControlBaseUri -Config $configObject
if ([string]::IsNullOrWhiteSpace($baseUri)) {
  exit 0
}

$deadline = (Get-Date).AddSeconds([Math]::Max(0, $ReadyTimeoutSec))
$status = $null
while ((Get-Date) -lt $deadline) {
  try {
    $status = Invoke-ClaudeBuddyControl -Config $configObject -Path "/status" -TimeoutSec 2
    if ($null -ne $status -and $status.ok -eq $true) {
      break
    }
  } catch {
    $status = $null
  }
  $process.Refresh()
  if ($process.HasExited) {
    Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
    throw "ClaudeBuddy daemon exited before the control server became ready. Check log: $logFilePath"
  }
  Start-Sleep -Milliseconds 500
}

if ($null -eq $status -or $status.ok -ne $true) {
  Write-Warning "Daemon did not expose $baseUri/status within $ReadyTimeoutSec second(s); stopping it."
  Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue
  Remove-ClaudeBuddyPidFile -PidFile $pidFilePath
  exit 2
}

$connected = $status.status.transport.connected -eq $true
$secure = $status.status.transport.secure -eq $true
Write-Host "Control: $baseUri"
Write-Host "Transport: connected=$connected secure=$secure"
exit 0
} finally {
  if ($startMutexOwned) {
    try {
      $startMutex.ReleaseMutex()
    } catch {
    }
  }
  $startMutex.Dispose()
}
