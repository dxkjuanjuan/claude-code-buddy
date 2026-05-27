[CmdletBinding()]
param(
  [string]$TaskName = "ClaudeBuddyStandalone",
  [switch]$Json
)

$task = $null
$taskInfo = $null
$taskError = ""

try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    if ($task -is [array]) {
      $taskError = "Multiple scheduled tasks named '$TaskName' were found; using the first match."
      $task = $task | Select-Object -First 1
    }
    $taskInfo = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue
  }
} catch {
  $taskError = $_.Exception.Message
}

$result = [ordered]@{
  installed = $null -ne $task
  taskName = $TaskName
  taskPath = if ($null -ne $task) { $task.TaskPath } else { "" }
  state = if ($null -ne $task) { [string]$task.State } else { "Missing" }
  lastRunTime = if ($null -ne $taskInfo) { $taskInfo.LastRunTime } else { $null }
  nextRunTime = if ($null -ne $taskInfo) { $taskInfo.NextRunTime } else { $null }
  lastTaskResult = if ($null -ne $taskInfo) { $taskInfo.LastTaskResult } else { $null }
  error = $taskError
}

if ($Json) {
  $result | ConvertTo-Json -Depth 10
} else {
  if ($result.installed) {
    Write-Host "ClaudeBuddy scheduled task: installed task=$($task.TaskPath)$($task.TaskName) state=$($result.state)"
    Write-Host "Last run: $($result.lastRunTime)"
    Write-Host "Next run: $($result.nextRunTime)"
    Write-Host "Last result: $($result.lastTaskResult)"
  } else {
    Write-Host "ClaudeBuddy scheduled task: not installed task=$TaskName"
    if (-not [string]::IsNullOrWhiteSpace($taskError)) {
      Write-Host "Error: $taskError"
    }
  }
}

if (-not [string]::IsNullOrWhiteSpace($taskError)) {
  exit 2
}
if ($null -eq $task) {
  exit 1
}
exit 0
