[CmdletBinding()]
param(
  [string]$Config = "",
  [string]$PidFile = "",
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$configObject = $null
$configError = ""
$logFilePath = ""
try {
  $configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
  $logFilePath = Get-ClaudeBuddyConfigLogFile -Config $configObject -ConfigPath $configPath
} catch {
  $configError = $_.Exception.Message
}
$pidValue = Get-ClaudeBuddyPid -PidFile $pidFilePath
$process = Get-ClaudeBuddyProcess -PidValue $pidValue
$controlBaseUri = if ($null -ne $configObject) { Get-ClaudeBuddyControlBaseUri -Config $configObject } else { "" }
$health = $null
$runtimeStatus = $null
$controlError = ""

if ($null -ne $process -and $null -ne $configObject -and -not [string]::IsNullOrWhiteSpace($controlBaseUri)) {
  try {
    $health = Invoke-ClaudeBuddyControl -Config $configObject -Path "/health" -TimeoutSec 2
    $runtimeStatus = Invoke-ClaudeBuddyControl -Config $configObject -Path "/status" -TimeoutSec 2
  } catch {
    $controlError = $_.Exception.Message
  }
}

$result = [ordered]@{
  running = $null -ne $process
  pid = $pidValue
  processName = if ($null -ne $process) { $process.ProcessName } else { "" }
  config = $configPath
  configOk = [string]::IsNullOrWhiteSpace($configError)
  configError = $configError
  pidFile = $pidFilePath
  logFile = $logFilePath
  control = [ordered]@{
    enabled = -not [string]::IsNullOrWhiteSpace($controlBaseUri)
    uri = $controlBaseUri
    ok = $null -ne $runtimeStatus -and $runtimeStatus.ok -eq $true
    error = $controlError
  }
  health = $health
  status = if ($null -ne $runtimeStatus) { $runtimeStatus.status } else { $null }
}

if ($Json) {
  $result | ConvertTo-Json -Depth 20
} else {
  if ($result.running) {
    Write-Host "ClaudeBuddy daemon: running pid=$pidValue process=$($result.processName)"
  } else {
    Write-Host "ClaudeBuddy daemon: not running"
  }
  Write-Host "Config: $configPath"
  if (-not [string]::IsNullOrWhiteSpace($configError)) {
    Write-Host "Config error: $configError"
  }
  Write-Host "PID file: $pidFilePath"
  if (-not [string]::IsNullOrWhiteSpace($logFilePath)) {
    Write-Host "Log file: $logFilePath"
  }
  if (-not [string]::IsNullOrWhiteSpace($controlBaseUri)) {
    Write-Host "Control: $controlBaseUri ok=$($result.control.ok)"
    if (-not [string]::IsNullOrWhiteSpace($controlError)) {
      Write-Host "Control error: $controlError"
    }
  }
  if ($null -ne $runtimeStatus -and $null -ne $runtimeStatus.status) {
    $transport = $runtimeStatus.status.transport
    $sidecar = $runtimeStatus.status.sidecar
    Write-Host "Transport: connected=$($transport.connected) secure=$($transport.secure)"
    Write-Host "Sidecar: pid=$($sidecar.pid) started=$($sidecar.started)"
  }
}

if ($null -eq $process) {
  exit 1
}
if (-not [string]::IsNullOrWhiteSpace($configError)) {
  exit 2
}
if (-not [string]::IsNullOrWhiteSpace($controlBaseUri) -and ($null -eq $runtimeStatus -or $runtimeStatus.ok -ne $true)) {
  exit 2
}
exit 0
