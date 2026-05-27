[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$Node = "node",
  [int]$TimeoutSec = 5,
  [switch]$KeepDaemon,
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$stopScript = Join-Path $PSScriptRoot "stop-claudebuddy-daemon.ps1"
$stopAttempted = $false
$stopExitCode = $null
$stopOutput = @()
$stopError = ""

if (-not $KeepDaemon) {
  if ($PSCmdlet.ShouldProcess("ClaudeBuddy daemon", "stop before unregistering scheduled task")) {
    try {
      $stopAttempted = $true
      if ($Json) {
        $stopOutput = @(& $stopScript -Config $configPath -PidFile $pidFilePath -Node $Node -TimeoutSec $TimeoutSec *>&1 | ForEach-Object { [string]$_ })
      } else {
        & $stopScript -Config $configPath -PidFile $pidFilePath -Node $Node -TimeoutSec $TimeoutSec
      }
      $stopExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
      if ($stopExitCode -ne 0) {
        $stopError = "Daemon stop script exited with code $stopExitCode; continuing with scheduled task removal."
        if (-not $Json) {
          Write-Warning $stopError
        }
      }
    } catch {
      $stopError = "Could not stop daemon before scheduled task removal: $($_.Exception.Message)"
      if (-not $Json) {
        Write-Warning $stopError
      }
    }
  }
}

$task = $null
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {
  throw "Failed to query scheduled task '$TaskName': $($_.Exception.Message)"
}

$taskFound = $null -ne $task
$taskPath = ""
$removed = $false
$taskWarning = ""
if ($task -is [array]) {
  $taskWarning = "Multiple scheduled tasks named '$TaskName' were found; removing the first match only."
  if (-not $Json) {
    Write-Warning $taskWarning
  }
  $task = $task | Select-Object -First 1
  $taskFound = $true
}

if ($null -ne $task) {
  $taskPath = "$($task.TaskPath)$($task.TaskName)"
}

if ($null -ne $task -and $PSCmdlet.ShouldProcess($taskPath, "unregister scheduled task")) {
  Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false
  $removed = $true
}

$result = [ordered]@{
  ok = $true
  taskName = $TaskName
  taskPath = $taskPath
  taskFound = $taskFound
  removed = $removed
  keepDaemon = [bool]$KeepDaemon
  config = $configPath
  pidFile = $pidFilePath
  node = $Node
  stopAttempted = $stopAttempted
  stopExitCode = $stopExitCode
  stopOutput = $stopOutput
  stopError = $stopError
  warning = $taskWarning
}

if ($Json) {
  $result | ConvertTo-Json -Depth 20
} else {
  if (-not $taskFound) {
    Write-Host "Scheduled task not found: $TaskName"
  } elseif ($removed) {
    Write-Host "Unregistered scheduled task: $taskPath"
  } else {
    Write-Host "Planned scheduled task removal: $taskPath"
  }
}
exit 0
