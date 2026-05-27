[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet("menu", "status", "start", "stop", "restart", "task-status", "install-autostart", "remove-autostart", "tail-log", "open-log")]
  [string]$Action = "menu",
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$Node = "node",
  [int]$ReadyTimeoutSec = 15,
  [int]$TimeoutSec = 5,
  [int]$LogLines = 80,
  [switch]$Json,
  [switch]$KeepDaemon,
  [switch]$Force
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$script:ClaudeBuddyControlExitCode = 0

function Invoke-ClaudeBuddyScript {
  param(
    [string]$ScriptName,
    [string[]]$ScriptArguments
  )
  $scriptPath = Join-Path $PSScriptRoot $ScriptName
  $powerShell = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
  if ([string]::IsNullOrWhiteSpace($powerShell) -or -not (Test-Path -LiteralPath $powerShell)) {
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
      $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
    }
    if ($null -ne $command) {
      $powerShell = $command.Source
    }
  }
  if ([string]::IsNullOrWhiteSpace($powerShell)) {
    throw "Could not locate a PowerShell executable for child script invocation."
  }
  & $powerShell -NoProfile -ExecutionPolicy Bypass -File $scriptPath @ScriptArguments
  $script:ClaudeBuddyControlExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
}

function Get-ClaudeBuddyTaskStatusForControl {
  param([string]$SelectedTaskName)
  $cmdlet = Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue
  if ($null -eq $cmdlet) {
    return [ordered]@{
      available = $false
      installed = $false
      taskName = $SelectedTaskName
      taskPath = ""
      state = "Unavailable"
      lastRunTime = $null
      nextRunTime = $null
      lastTaskResult = $null
      error = "ScheduledTasks cmdlets are unavailable"
    }
  }

  $task = $null
  $taskInfo = $null
  $taskError = ""
  try {
    $task = Get-ScheduledTask -TaskName $SelectedTaskName -ErrorAction SilentlyContinue
    if ($task -is [array]) {
      $taskError = "Multiple scheduled tasks named '$SelectedTaskName' were found; using the first match."
      $task = $task | Select-Object -First 1
    }
    if ($null -ne $task) {
      $taskInfo = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
    }
  } catch {
    $taskError = $_.Exception.Message
  }

  return [ordered]@{
    available = $true
    installed = $null -ne $task
    taskName = $SelectedTaskName
    taskPath = if ($null -ne $task) { $task.TaskPath } else { "" }
    state = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    lastRunTime = if ($null -ne $taskInfo) { $taskInfo.LastRunTime } else { $null }
    nextRunTime = if ($null -ne $taskInfo) { $taskInfo.NextRunTime } else { $null }
    lastTaskResult = if ($null -ne $taskInfo) { $taskInfo.LastTaskResult } else { $null }
    error = $taskError
  }
}

function Get-ClaudeBuddyControlStatus {
  $configObject = $null
  $configError = ""
  $logFilePath = ""
  $controlBaseUri = ""
  try {
    $configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
    $logFilePath = Get-ClaudeBuddyConfigLogFile -Config $configObject -ConfigPath $configPath
    $controlBaseUri = Get-ClaudeBuddyControlBaseUri -Config $configObject
  } catch {
    $configError = $_.Exception.Message
  }

  $pidValue = Get-ClaudeBuddyPid -PidFile $pidFilePath
  $process = Get-ClaudeBuddyProcess -PidValue $pidValue
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

  return [ordered]@{
    config = $configPath
    configOk = [string]::IsNullOrWhiteSpace($configError)
    configError = $configError
    pidFile = $pidFilePath
    logFile = $logFilePath
    daemon = [ordered]@{
      running = $null -ne $process
      pid = $pidValue
      processName = if ($null -ne $process) { $process.ProcessName } else { "" }
      control = [ordered]@{
        enabled = -not [string]::IsNullOrWhiteSpace($controlBaseUri)
        uri = $controlBaseUri
        ok = $null -ne $runtimeStatus -and $runtimeStatus.ok -eq $true
        error = $controlError
      }
      health = $health
      status = if ($null -ne $runtimeStatus) { $runtimeStatus.status } else { $null }
    }
    autostart = Get-ClaudeBuddyTaskStatusForControl -SelectedTaskName $TaskName
  }
}

function Write-ClaudeBuddyControlStatus {
  param([object]$Status)
  if ($Json) {
    $Status | ConvertTo-Json -Depth 30
    return
  }

  Write-Host "ClaudeBuddy control"
  Write-Host "Config: $($Status.config)"
  if (-not $Status.configOk) {
    Write-Host "Config error: $($Status.configError)"
  }
  Write-Host "PID file: $($Status.pidFile)"
  if (-not [string]::IsNullOrWhiteSpace($Status.logFile)) {
    Write-Host "Log file: $($Status.logFile)"
  }
  if ($Status.daemon.running) {
    Write-Host "Daemon: running pid=$($Status.daemon.pid) process=$($Status.daemon.processName)"
  } else {
    Write-Host "Daemon: stopped"
  }
  if ($Status.daemon.control.enabled) {
    Write-Host "Control: $($Status.daemon.control.uri) ok=$($Status.daemon.control.ok)"
    if (-not [string]::IsNullOrWhiteSpace($Status.daemon.control.error)) {
      Write-Host "Control error: $($Status.daemon.control.error)"
    }
  }
  if ($null -ne $Status.daemon.status -and $null -ne $Status.daemon.status.transport) {
    $transport = $Status.daemon.status.transport
    Write-Host "Transport: type=$($transport.type) backend=$($transport.backend) connected=$($transport.connected) secure=$($transport.secure)"
  }
  if ($Status.autostart.available) {
    Write-Host "Autostart: installed=$($Status.autostart.installed) task=$($Status.autostart.taskName) state=$($Status.autostart.state)"
  } else {
    Write-Host "Autostart: unavailable ($($Status.autostart.error))"
  }
}

function Invoke-ClaudeBuddyControlAction {
  param([string]$SelectedAction)

  switch ($SelectedAction) {
    "status" {
      Write-ClaudeBuddyControlStatus -Status (Get-ClaudeBuddyControlStatus)
      $script:ClaudeBuddyControlExitCode = 0
      return
    }
    "start" {
      Invoke-ClaudeBuddyScript -ScriptName "start-claudebuddy-daemon.ps1" -ScriptArguments @(
        "-Config", $configPath,
        "-PidFile", $pidFilePath,
        "-Node", $Node,
        "-ReadyTimeoutSec", ([string]$ReadyTimeoutSec)
      )
      return
    }
    "stop" {
      Invoke-ClaudeBuddyScript -ScriptName "stop-claudebuddy-daemon.ps1" -ScriptArguments @(
        "-Config", $configPath,
        "-PidFile", $pidFilePath,
        "-Node", $Node,
        "-TimeoutSec", ([string]$TimeoutSec)
      )
      return
    }
    "restart" {
      Invoke-ClaudeBuddyControlAction -SelectedAction "stop"
      $stopCode = $script:ClaudeBuddyControlExitCode
      if ($stopCode -ne 0) {
        $status = Get-ClaudeBuddyControlStatus
        if ($status.daemon.running) {
          Write-Warning "Stop exited with code $stopCode and the daemon is still running; refusing to start a second copy."
          $script:ClaudeBuddyControlExitCode = $stopCode
          return
        }
        Write-Warning "Stop exited with code $stopCode, but no daemon is running; attempting start."
      }
      Invoke-ClaudeBuddyControlAction -SelectedAction "start"
      return
    }
    "task-status" {
      $arguments = @(
        "-TaskName", $TaskName
      )
      if ($Json) {
        $arguments += "-Json"
      }
      Invoke-ClaudeBuddyScript -ScriptName "status-claudebuddy-scheduled-task.ps1" -ScriptArguments $arguments
      return
    }
    "install-autostart" {
      $arguments = @(
        "-TaskName", $TaskName,
        "-Config", $configPath,
        "-PidFile", $pidFilePath,
        "-Node", $Node
      )
      if ($Force) {
        $arguments += "-Force"
      }
      if ($WhatIfPreference) {
        $arguments += "-WhatIf"
      }
      if ($Json) {
        $arguments += "-Json"
      }
      Invoke-ClaudeBuddyScript -ScriptName "install-claudebuddy-scheduled-task.ps1" -ScriptArguments $arguments
      return
    }
    "remove-autostart" {
      $arguments = @(
        "-TaskName", $TaskName,
        "-Config", $configPath,
        "-PidFile", $pidFilePath,
        "-Node", $Node,
        "-TimeoutSec", ([string]$TimeoutSec)
      )
      if ($KeepDaemon) {
        $arguments += "-KeepDaemon"
      }
      if ($WhatIfPreference) {
        $arguments += "-WhatIf"
      }
      if ($Json) {
        $arguments += "-Json"
      }
      Invoke-ClaudeBuddyScript -ScriptName "uninstall-claudebuddy-scheduled-task.ps1" -ScriptArguments $arguments
      return
    }
    "tail-log" {
      $status = Get-ClaudeBuddyControlStatus
      if ([string]::IsNullOrWhiteSpace($status.logFile)) {
        Write-Host "No logFile is configured."
        $script:ClaudeBuddyControlExitCode = 1
        return
      }
      if (-not (Test-Path -LiteralPath $status.logFile)) {
        Write-Host "Log file not found: $($status.logFile)"
        $script:ClaudeBuddyControlExitCode = 1
        return
      }
      Get-Content -LiteralPath $status.logFile -Tail ([Math]::Max(1, $LogLines))
      $script:ClaudeBuddyControlExitCode = 0
      return
    }
    "open-log" {
      $status = Get-ClaudeBuddyControlStatus
      if ([string]::IsNullOrWhiteSpace($status.logFile)) {
        Write-Host "No logFile is configured."
        $script:ClaudeBuddyControlExitCode = 1
        return
      }
      if (-not (Test-Path -LiteralPath $status.logFile)) {
        Write-Host "Log file not found: $($status.logFile)"
        $script:ClaudeBuddyControlExitCode = 1
        return
      }
      Invoke-Item -LiteralPath $status.logFile
      $script:ClaudeBuddyControlExitCode = 0
      return
    }
    default {
      throw "Unsupported action: $SelectedAction"
    }
  }
}

function Show-ClaudeBuddyControlMenu {
  function Wait-ClaudeBuddyControlInput {
    Read-Host "Press Enter to continue" | Out-Null
  }

  while ($true) {
    Clear-Host
    Write-ClaudeBuddyControlStatus -Status (Get-ClaudeBuddyControlStatus)
    Write-Host ""
    Write-Host "1. Start daemon"
    Write-Host "2. Stop daemon"
    Write-Host "3. Restart daemon"
    Write-Host "4. Install autostart"
    Write-Host "5. Remove autostart"
    Write-Host "6. Tail log"
    Write-Host "7. Refresh"
    Write-Host "Q. Quit"
    $choice = Read-Host "Select"
    switch ($choice.ToUpperInvariant()) {
      "1" { Invoke-ClaudeBuddyControlAction -SelectedAction "start"; Wait-ClaudeBuddyControlInput }
      "2" { Invoke-ClaudeBuddyControlAction -SelectedAction "stop"; Wait-ClaudeBuddyControlInput }
      "3" { Invoke-ClaudeBuddyControlAction -SelectedAction "restart"; Wait-ClaudeBuddyControlInput }
      "4" { Invoke-ClaudeBuddyControlAction -SelectedAction "install-autostart"; Wait-ClaudeBuddyControlInput }
      "5" { Invoke-ClaudeBuddyControlAction -SelectedAction "remove-autostart"; Wait-ClaudeBuddyControlInput }
      "6" { Invoke-ClaudeBuddyControlAction -SelectedAction "tail-log"; Wait-ClaudeBuddyControlInput }
      "7" { }
      "Q" { $script:ClaudeBuddyControlExitCode = 0; return }
      default { Write-Host "Unknown selection: $choice"; Wait-ClaudeBuddyControlInput }
    }
  }
}

if ($Action -eq "menu") {
  Show-ClaudeBuddyControlMenu
  exit $script:ClaudeBuddyControlExitCode
}

Invoke-ClaudeBuddyControlAction -SelectedAction $Action
exit $script:ClaudeBuddyControlExitCode
