[CmdletBinding()]
param(
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$Node = "node",
  [int]$PollSeconds = 5,
  [int]$ReadyTimeoutSec = 15,
  [int]$TimeoutSec = 5,
  [int]$LogLines = 120,
  [switch]$AllowMultiple,
  [switch]$ValidateOnly,
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

if ($Json) {
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
  } catch {
  }
}

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$controlScript = Join-Path $PSScriptRoot "claudebuddy-control.ps1"
$script:QuickCommandTaskAffordanceMs = 30000

function Get-ClaudeBuddyTrayPowerShell {
  $powerShell = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
  if (-not [string]::IsNullOrWhiteSpace($powerShell) -and (Test-Path -LiteralPath $powerShell)) {
    return $powerShell
  }
  $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
  }
  if ($null -ne $command) {
    return $command.Source
  }
  return ""
}

function Test-ClaudeBuddyTrayForms {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Get-ClaudeBuddyTrayCommonArgs {
  return @(
    "-Config", $configPath,
    "-PidFile", $pidFilePath,
    "-TaskName", $TaskName,
    "-Node", $Node
  )
}

function ConvertFrom-ClaudeBuddyCodePoints {
  param([int[]]$CodePoints)
  return -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Get-ClaudeBuddyTrayQuickCommandPresets {
  return @(
    [ordered]@{ id = "continue"; label = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x7EE7, 0x7EED) },
    [ordered]@{ id = "correct"; label = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x4E0D, 0x662F, 0x8FD9, 0x6837, 0x7684) },
    [ordered]@{ id = "no_commit"; label = "$(ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x4E0D, 0x8981)) commit" },
    [ordered]@{ id = "no_source_edits"; label = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x4E0D, 0x8981, 0x6539, 0x6E90, 0x6587, 0x4EF6) },
    [ordered]@{ id = "show_diff"; label = "show diff" },
    [ordered]@{ id = "plain_language"; label = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x8BF4, 0x4EBA, 0x8BDD) },
    [ordered]@{ id = "plan_first"; label = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x5148, 0x5217, 0x8BA1, 0x5212) }
  )
}

function Test-ClaudeBuddyTrayQuickCommandPresets {
  $presets = @(Get-ClaudeBuddyTrayQuickCommandPresets)
  $ids = @($presets | ForEach-Object { [string]$_.id })
  $labels = @($presets | ForEach-Object { [string]$_.label })
  $stopLabel = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x505C)
  $uniqueIds = @($ids | Select-Object -Unique)
  if ($presets.Count -ne 7) {
    return $false
  }
  if ($uniqueIds.Count -ne $ids.Count) {
    return $false
  }
  if ($ids -contains "stop" -or $labels -contains $stopLabel) {
    return $false
  }
  foreach ($id in $ids) {
    if ([string]::IsNullOrWhiteSpace($id)) {
      return $false
    }
  }
  foreach ($label in $labels) {
    if ([string]::IsNullOrWhiteSpace($label)) {
      return $false
    }
  }
  return $true
}

function Get-ClaudeBuddyTrayQuickCommandPreset {
  param([string]$Id)
  foreach ($preset in Get-ClaudeBuddyTrayQuickCommandPresets) {
    if ($preset.id -eq $Id) {
      return $preset
    }
  }
  return $null
}

function New-ClaudeBuddyTrayQuickCommandRequest {
  param(
    [string]$Id,
    [string]$ClientRequestId = ""
  )
  $preset = Get-ClaudeBuddyTrayQuickCommandPreset -Id $Id
  if ($null -eq $preset) {
    throw "Unknown quick command preset: $Id"
  }
  $requestId = if ([string]::IsNullOrWhiteSpace($ClientRequestId)) {
    "tray-$([System.Guid]::NewGuid().ToString())"
  } else {
    $ClientRequestId
  }
  return [ordered]@{
    id = [string]$preset.id
    source = "tray"
    clientRequestId = $requestId
    target = [ordered]@{
      scope = "active_session"
      sessionId = $null
    }
  }
}

function Get-ClaudeBuddyTrayQuickCommandConfigState {
  $configObject = $null
  $configError = ""
  try {
    $configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
  } catch {
    $configError = $_.Exception.Message
  }
  return [ordered]@{
    ok = [string]::IsNullOrWhiteSpace($configError)
    error = $configError
    controlServerEnabled = if ($null -ne $configObject) {
      ConvertTo-ClaudeBuddyBoolean -Value (Get-ClaudeBuddyProperty -Object $configObject -Name "controlServer" -Fallback $false) -Fallback $false
    } else {
      $false
    }
    quickCommandsEnabled = if ($null -ne $configObject) {
      ConvertTo-ClaudeBuddyBoolean -Value (Get-ClaudeBuddyProperty -Object $configObject -Name "quickCommands" -Fallback $false) -Fallback $false
    } else {
      $false
    }
  }
}

function Get-ClaudeBuddyTrayQuickCommandValidation {
  $presets = @(Get-ClaudeBuddyTrayQuickCommandPresets)
  $stopLabel = ConvertFrom-ClaudeBuddyCodePoints -CodePoints @(0x505C)
  return [ordered]@{
    menuText = "Quick Commands"
    source = "tray"
    presets = $presets
    presetIdsValid = Test-ClaudeBuddyTrayQuickCommandPresets
    hasStop = @($presets | Where-Object { $_.id -eq "stop" -or $_.label -eq $stopLabel }).Count -gt 0
    requestPreviews = @($presets | ForEach-Object {
      New-ClaudeBuddyTrayQuickCommandRequest -Id $_.id -ClientRequestId "validate-only-$($_.id)"
    })
    taskStateAffordance = [ordered]@{
      endpoint = "/task-state"
      timeoutMs = $script:QuickCommandTaskAffordanceMs
      explicitSignal = $true
      inferFromSnapshot = $false
      autoSend = $false
    }
    config = Get-ClaudeBuddyTrayQuickCommandConfigState
  }
}

function ConvertFrom-ClaudeBuddyTrayJsonOutput {
  param([string]$Output)
  $start = $Output.IndexOf("{")
  $end = $Output.LastIndexOf("}")
  if ($start -lt 0 -or $end -le $start) {
    throw "Control script did not emit a JSON object."
  }
  return $Output.Substring($start, $end - $start + 1) | ConvertFrom-Json
}

function Get-ClaudeBuddyTrayTaskStatus {
  $cmdlet = Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue
  if ($null -eq $cmdlet) {
    return [ordered]@{
      available = $false
      installed = $false
      taskName = $TaskName
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
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -is [array]) {
      $taskError = "Multiple scheduled tasks named '$TaskName' were found; using the first match."
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
    taskName = $TaskName
    taskPath = if ($null -ne $task) { $task.TaskPath } else { "" }
    state = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    lastRunTime = if ($null -ne $taskInfo) { $taskInfo.LastRunTime } else { $null }
    nextRunTime = if ($null -ne $taskInfo) { $taskInfo.NextRunTime } else { $null }
    lastTaskResult = if ($null -ne $taskInfo) { $taskInfo.LastTaskResult } else { $null }
    error = $taskError
  }
}

function Get-ClaudeBuddyTrayStatus {
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
  $runtimeStatus = $null
  $controlError = ""

  if ($null -ne $process -and $null -ne $configObject -and -not [string]::IsNullOrWhiteSpace($controlBaseUri)) {
    try {
      $runtimeStatus = Invoke-ClaudeBuddyControl -Config $configObject -Path "/status" -TimeoutSec 1
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
      health = $null
      status = if ($null -ne $runtimeStatus) { $runtimeStatus.status } else { $null }
    }
    autostart = Get-ClaudeBuddyTrayTaskStatus
  }
}

function Invoke-ClaudeBuddyTrayControl {
  param(
    [string]$Action,
    [string[]]$ExtraArgs = @(),
    [switch]$AsJson
  )
  $powerShell = Get-ClaudeBuddyTrayPowerShell
  if ([string]::IsNullOrWhiteSpace($powerShell)) {
    throw "Could not locate a PowerShell executable."
  }

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $controlScript,
    "-Action",
    $Action
  ) + (Get-ClaudeBuddyTrayCommonArgs) + $ExtraArgs
  if ($AsJson) {
    $arguments += "-Json"
  }

  $tempBase = Join-Path ([System.IO.Path]::GetTempPath()) ("claudebuddy-tray-" + [System.Guid]::NewGuid().ToString("N"))
  $stdoutFile = "$tempBase.out"
  $stderrFile = "$tempBase.err"
  try {
    $process = Start-Process `
      -FilePath $powerShell `
      -ArgumentList (Join-ClaudeBuddyArguments -Arguments $arguments) `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutFile `
      -RedirectStandardError $stderrFile `
      -Wait `
      -PassThru
    $stdout = if (Test-Path -LiteralPath $stdoutFile) { Get-Content -LiteralPath $stdoutFile -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile -Raw } else { "" }
    $output = if ($AsJson) { $stdout.Trim() } else { (($stdout, $stderr) -join "`n").Trim() }
    return [pscustomobject]@{
      exitCode = $process.ExitCode
      output = $output
      json = if ($AsJson -and -not [string]::IsNullOrWhiteSpace($output)) {
        ConvertFrom-ClaudeBuddyTrayJsonOutput -Output $output
      } else {
        $null
      }
    }
  } finally {
    Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

function Start-ClaudeBuddyTrayControlWindow {
  param([string]$Action)
  $powerShell = Get-ClaudeBuddyTrayPowerShell
  if ([string]::IsNullOrWhiteSpace($powerShell)) {
    throw "Could not locate a PowerShell executable."
  }
  $arguments = Join-ClaudeBuddyArguments -Arguments (@(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    $controlScript,
    "-Action",
    $Action
  ) + (Get-ClaudeBuddyTrayCommonArgs) + @(
    "-LogLines",
    ([string]$LogLines)
  ))
  Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $repoRoot | Out-Null
}

function Format-ClaudeBuddyTrayStatus {
  param([object]$Status)
  if ($null -eq $Status) {
    return "Status unavailable"
  }
  $daemon = $Status.daemon
  if ($null -eq $daemon -or $daemon.running -ne $true) {
    return "Daemon stopped"
  }
  $transport = $daemon.status.transport
  if ($null -eq $transport) {
    return "Daemon running"
  }
  return "Daemon running; $($transport.backend) connected=$($transport.connected) secure=$($transport.secure)"
}

function Get-ClaudeBuddyTrayQuickCommandRuntimeState {
  param([object]$Status)
  $state = [ordered]@{
    available = $false
    enabled = $false
    reason = "Status unavailable"
    presets = @(Get-ClaudeBuddyTrayQuickCommandPresets)
    recentTask = $null
    taskStateError = ""
    taskAffordanceTimeoutMs = $script:QuickCommandTaskAffordanceMs
  }
  if ($null -eq $Status) {
    return $state
  }
  if ($Status.configOk -ne $true) {
    $state.reason = "Config error"
    return $state
  }
  if ($Status.daemon.running -ne $true) {
    $state.reason = "Daemon stopped"
    return $state
  }
  if ($Status.daemon.control.enabled -ne $true) {
    $state.reason = "Control server disabled"
    return $state
  }
  if ($Status.daemon.control.ok -ne $true) {
    $state.reason = if ([string]::IsNullOrWhiteSpace($Status.daemon.control.error)) {
      "Control server unavailable"
    } else {
      $Status.daemon.control.error
    }
    return $state
  }

  try {
    $configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
    $response = Invoke-ClaudeBuddyControl -Config $configObject -Path "/quick-commands/presets" -TimeoutSec 1
    if ($null -eq $response -or $response.ok -ne $true) {
      $state.reason = "Quick Commands unavailable"
      return $state
    }
    $state.available = $true
    $state.enabled = $response.enabled -eq $true
    $state.reason = if ($state.enabled) { "" } else { "Quick Commands disabled" }
    if ($null -ne $response.presets) {
      $state.presets = @($response.presets)
    }
    try {
      $taskResponse = Invoke-ClaudeBuddyControl `
        -Config $configObject `
        -Path ("/task-state?maxAgeMs={0}" -f $script:QuickCommandTaskAffordanceMs) `
        -TimeoutSec 1
      if ($null -ne $taskResponse -and $taskResponse.ok -eq $true -and $null -ne $taskResponse.taskState) {
        $state.recentTask = $taskResponse.taskState.latest
      }
    } catch {
      $state.taskStateError = $_.Exception.Message
    }
    return $state
  } catch {
    $state.reason = $_.Exception.Message
    return $state
  }
}

function Invoke-ClaudeBuddyTrayQuickCommand {
  param([string]$Id)
  $configObject = Read-ClaudeBuddyConfig -ConfigPath $configPath
  $baseUri = Get-ClaudeBuddyControlBaseUri -Config $configObject
  if ([string]::IsNullOrWhiteSpace($baseUri)) {
    throw "Control server is disabled."
  }
  $request = New-ClaudeBuddyTrayQuickCommandRequest -Id $Id
  $body = $request | ConvertTo-Json -Depth 10 -Compress
  return Invoke-RestMethod `
    -Method Post `
    -Uri "$baseUri/quick-commands" `
    -Headers (Get-ClaudeBuddyControlHeaders -Config $configObject) `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec $TimeoutSec
}

function Limit-ClaudeBuddyTrayText {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) {
    return "ClaudeBuddy"
  }
  if ($Text.Length -le 63) {
    return $Text
  }
  return $Text.Substring(0, 60) + "..."
}

function Get-ClaudeBuddyTrayValidation {
  $formsAvailable = Test-ClaudeBuddyTrayForms
  $status = $null
  $statusError = ""
  try {
    $status = Get-ClaudeBuddyTrayStatus
  } catch {
    $statusError = $_.Exception.Message
  }
  return [ordered]@{
    ok = $formsAvailable -and [string]::IsNullOrWhiteSpace($statusError)
    windowsFormsAvailable = $formsAvailable
    controlScript = $controlScript
    config = $configPath
    pidFile = $pidFilePath
    taskName = $TaskName
    controlError = $statusError
    controlStatus = $status
    quickCommands = Get-ClaudeBuddyTrayQuickCommandValidation
    quickCommandRuntime = Get-ClaudeBuddyTrayQuickCommandRuntimeState -Status $status
  }
}

if ($ValidateOnly) {
  $validation = Get-ClaudeBuddyTrayValidation
  if ($Json) {
    $validation | ConvertTo-Json -Depth 30
  } else {
    Write-Host "ClaudeBuddy tray validation"
    Write-Host "Windows Forms: $($validation.windowsFormsAvailable)"
    Write-Host "Control script: $($validation.controlScript)"
    Write-Host "Config: $($validation.config)"
    Write-Host "PID file: $($validation.pidFile)"
    if (-not [string]::IsNullOrWhiteSpace($validation.controlError)) {
      Write-Host "Control error: $($validation.controlError)"
    }
  }
  exit 0
}

if (-not (Test-ClaudeBuddyTrayForms)) {
  throw "ClaudeBuddy tray requires Windows Forms and System.Drawing."
}

$mutex = $null
$mutexOwned = $false
if (-not $AllowMultiple) {
  $mutex = [System.Threading.Mutex]::new($false, "Local\ClaudeBuddyStandaloneTray")
  try {
    $mutexOwned = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $mutexOwned = $true
  }
  if (-not $mutexOwned) {
    Write-Warning "ClaudeBuddy tray is already running."
    $mutex.Dispose()
    exit 0
  }
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = "ClaudeBuddy"
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = "Status: loading"
$statusItem.Enabled = $false
$refreshItem = New-Object System.Windows.Forms.ToolStripMenuItem("Refresh")
$quickCommandsItem = New-Object System.Windows.Forms.ToolStripMenuItem("Quick Commands")
$quickCommandStatusItem = New-Object System.Windows.Forms.ToolStripMenuItem("Quick Commands: loading")
$quickCommandStatusItem.Enabled = $false
$startItem = New-Object System.Windows.Forms.ToolStripMenuItem("Start daemon")
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem("Stop daemon")
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart daemon")
$installAutostartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Install autostart")
$removeAutostartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Remove autostart")
$tailLogItem = New-Object System.Windows.Forms.ToolStripMenuItem("Tail log in console")
$openLogItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open log")
$controlShellItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open control shell")
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Exit tray")

[void]$contextMenu.Items.Add($statusItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($refreshItem)
[void]$contextMenu.Items.Add($quickCommandsItem)
[void]$contextMenu.Items.Add($startItem)
[void]$contextMenu.Items.Add($stopItem)
[void]$contextMenu.Items.Add($restartItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($installAutostartItem)
[void]$contextMenu.Items.Add($removeAutostartItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($tailLogItem)
[void]$contextMenu.Items.Add($openLogItem)
[void]$contextMenu.Items.Add($controlShellItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($exitItem)
$notifyIcon.ContextMenuStrip = $contextMenu

$script:LastTrayStatus = $null
$script:QuickCommandMenuItems = @{}
$script:LastTaskStateSeq = 0

[void]$quickCommandsItem.DropDownItems.Add($quickCommandStatusItem)
[void]$quickCommandsItem.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
foreach ($preset in Get-ClaudeBuddyTrayQuickCommandPresets) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem([string]$preset.label)
  $item.Tag = [string]$preset.id
  $script:QuickCommandMenuItems[[string]$preset.id] = $item
  [void]$quickCommandsItem.DropDownItems.Add($item)
}

function Show-ClaudeBuddyTrayTip {
  param(
    [string]$Title,
    [string]$Message,
    [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )
  $notifyIcon.BalloonTipTitle = $Title
  $notifyIcon.BalloonTipText = if ([string]::IsNullOrWhiteSpace($Message)) { $Title } else { $Message }
  $notifyIcon.BalloonTipIcon = $Icon
  $notifyIcon.ShowBalloonTip(2500)
}

function Update-ClaudeBuddyTrayStatus {
  try {
    $script:LastTrayStatus = Get-ClaudeBuddyTrayStatus
    $label = Format-ClaudeBuddyTrayStatus -Status $script:LastTrayStatus
    $statusItem.Text = "Status: $label"
    $notifyIcon.Text = Limit-ClaudeBuddyTrayText -Text "ClaudeBuddy: $label"

    $running = $script:LastTrayStatus.daemon.running -eq $true
    $autostartInstalled = $script:LastTrayStatus.autostart.installed -eq $true
    $startItem.Enabled = -not $running
    $stopItem.Enabled = $running
    $restartItem.Enabled = $true
    $installAutostartItem.Enabled = -not $autostartInstalled
    $removeAutostartItem.Enabled = $autostartInstalled

    $quickState = Get-ClaudeBuddyTrayQuickCommandRuntimeState -Status $script:LastTrayStatus
    if ($quickState.enabled) {
      if ($null -ne $quickState.recentTask) {
        $taskTitle = if ([string]::IsNullOrWhiteSpace($quickState.recentTask.title)) {
          $quickState.recentTask.sessionId
        } else {
          $quickState.recentTask.title
        }
        $quickCommandStatusItem.Text = "Recent task: $(Limit-ClaudeBuddyTrayText -Text $taskTitle)"
      } else {
        $quickCommandStatusItem.Text = "Quick Commands: enabled"
      }
    } else {
      $quickCommandStatusItem.Text = "Quick Commands: $($quickState.reason)"
    }
    foreach ($item in $script:QuickCommandMenuItems.Values) {
      $item.Enabled = $quickState.enabled -eq $true
    }

    if ($running) {
      $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    } else {
      $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    }

    if ($quickState.enabled -eq $true -and $null -ne $quickState.recentTask) {
      $taskSeq = [int64]$quickState.recentTask.seq
      if ($taskSeq -gt $script:LastTaskStateSeq) {
        $script:LastTaskStateSeq = $taskSeq
        $taskTitle = if ([string]::IsNullOrWhiteSpace($quickState.recentTask.title)) {
          $quickState.recentTask.sessionId
        } else {
          $quickState.recentTask.title
        }
        Show-ClaudeBuddyTrayTip -Title "Task finished" -Message "$(Limit-ClaudeBuddyTrayText -Text $taskTitle). Quick Commands available."
      }
    }
  } catch {
    $statusItem.Text = "Status: unavailable"
    $quickCommandStatusItem.Text = "Quick Commands: status unavailable"
    foreach ($item in $script:QuickCommandMenuItems.Values) {
      $item.Enabled = $false
    }
    $notifyIcon.Text = "ClaudeBuddy: status unavailable"
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
  }
}

function Invoke-ClaudeBuddyTrayAction {
  param(
    [string]$Action,
    [string[]]$ExtraArgs = @(),
    [string]$SuccessMessage = "Action completed."
  )
  try {
    $result = Invoke-ClaudeBuddyTrayControl -Action $Action -ExtraArgs $ExtraArgs
    if ($result.exitCode -eq 0) {
      Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message $SuccessMessage
    } else {
      Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message $result.output -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
  } catch {
    Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message $_.Exception.Message -Icon ([System.Windows.Forms.ToolTipIcon]::Error)
  }
  Update-ClaudeBuddyTrayStatus
}

function Invoke-ClaudeBuddyTrayQuickCommandMenuClick {
  param([string]$Id)
  try {
    $preset = Get-ClaudeBuddyTrayQuickCommandPreset -Id $Id
    if ($null -eq $preset) {
      throw "Unknown quick command preset: $Id"
    }
    $result = Invoke-ClaudeBuddyTrayQuickCommand -Id $Id
    if ($result.ok -eq $true) {
      $duplicate = if ($result.duplicate -eq $true) { " (duplicate)" } else { "" }
      Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message "Sent: $($preset.label)$duplicate"
    } else {
      Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message "Quick Command was not accepted." -Icon ([System.Windows.Forms.ToolTipIcon]::Warning)
    }
  } catch {
    Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message $_.Exception.Message -Icon ([System.Windows.Forms.ToolTipIcon]::Error)
  }
  Update-ClaudeBuddyTrayStatus
}

$refreshItem.add_Click({ Update-ClaudeBuddyTrayStatus })
foreach ($item in $script:QuickCommandMenuItems.Values) {
  $item.add_Click({
    param($sender, $eventArgs)
    Invoke-ClaudeBuddyTrayQuickCommandMenuClick -Id ([string]$sender.Tag)
  })
}
$startItem.add_Click({ Invoke-ClaudeBuddyTrayAction -Action "start" -SuccessMessage "Daemon started." })
$stopItem.add_Click({ Invoke-ClaudeBuddyTrayAction -Action "stop" -SuccessMessage "Daemon stopped." })
$restartItem.add_Click({ Invoke-ClaudeBuddyTrayAction -Action "restart" -SuccessMessage "Daemon restarted." })
$installAutostartItem.add_Click({ Invoke-ClaudeBuddyTrayAction -Action "install-autostart" -SuccessMessage "Autostart installed." })
$removeAutostartItem.add_Click({ Invoke-ClaudeBuddyTrayAction -Action "remove-autostart" -ExtraArgs @("-KeepDaemon") -SuccessMessage "Autostart removed." })
$tailLogItem.add_Click({ Start-ClaudeBuddyTrayControlWindow -Action "tail-log" })
$openLogItem.add_Click({ Invoke-ClaudeBuddyTrayAction -Action "open-log" -SuccessMessage "Opened log file." })
$controlShellItem.add_Click({ Start-ClaudeBuddyTrayControlWindow -Action "menu" })
$exitItem.add_Click({
  $timer.Stop()
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::ExitThread()
})
$notifyIcon.add_DoubleClick({
  Update-ClaudeBuddyTrayStatus
  Show-ClaudeBuddyTrayTip -Title "ClaudeBuddy" -Message (Format-ClaudeBuddyTrayStatus -Status $script:LastTrayStatus)
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $PollSeconds) * 1000
$timer.add_Tick({ Update-ClaudeBuddyTrayStatus })

Update-ClaudeBuddyTrayStatus
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  if ($null -ne $timer) {
    $timer.Stop()
    $timer.Dispose()
  }
  if ($null -ne $notifyIcon) {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  }
  if ($null -ne $mutex) {
    if ($mutexOwned) {
      try {
        $mutex.ReleaseMutex()
      } catch {
      }
    }
    $mutex.Dispose()
  }
}
