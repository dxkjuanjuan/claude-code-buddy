[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$Node = "node",
  [switch]$Force,
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$startScript = Join-Path $PSScriptRoot "start-claudebuddy-daemon.ps1"

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Config file not found: $configPath"
}

$taskArguments = Join-ClaudeBuddyArguments -Arguments @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $startScript,
  "-Config",
  $configPath,
  "-PidFile",
  $pidFilePath,
  "-Node",
  $Node,
  "-NoWait"
)

$description = "Start ClaudeBuddy standalone Hardware Buddy daemon at logon."
$registered = $false

if ($PSCmdlet.ShouldProcess($TaskName, "register scheduled task")) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArguments -WorkingDirectory $repoRoot
  $triggerUser = if ([string]::IsNullOrWhiteSpace($env:USERDOMAIN)) { $env:USERNAME } else { "$env:USERDOMAIN\$env:USERNAME" }
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $triggerUser
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Description $description -Force:$Force | Out-Null
  $registered = $true
}

$result = [ordered]@{
  ok = $true
  taskName = $TaskName
  config = $configPath
  pidFile = $pidFilePath
  node = $Node
  startScript = $startScript
  taskArguments = $taskArguments
  force = [bool]$Force
  registered = $registered
}

if ($Json) {
  $result | ConvertTo-Json -Depth 20
} else {
  if ($registered) {
    Write-Host "Registered scheduled task: $TaskName"
  } else {
    Write-Host "Planned scheduled task: $TaskName"
  }
  Write-Host "Config: $configPath"
  Write-Host "PID file: $pidFilePath"
}
exit 0
