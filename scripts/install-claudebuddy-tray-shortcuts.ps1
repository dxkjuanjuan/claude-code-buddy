[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ShortcutName = "ClaudeBuddy Tray",
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$Node = "node",
  [int]$PollSeconds = 5,
  [string]$PowerShell = "",
  [switch]$StartMenu,
  [switch]$Startup,
  [switch]$All,
  [string]$StartMenuDir = "",
  [string]$StartupDir = "",
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$configPath = Get-ClaudeBuddyConfigPath -Config $Config -RepoRoot $repoRoot
$pidFilePath = Get-ClaudeBuddyPidFilePath -PidFile $PidFile -RepoRoot $repoRoot
$trayScript = Join-Path $PSScriptRoot "claudebuddy-tray.ps1"

function Get-ClaudeBuddyShortcutPowerShell {
  param([string]$SelectedPowerShell)
  if (-not [string]::IsNullOrWhiteSpace($SelectedPowerShell)) {
    $command = Get-Command $SelectedPowerShell -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      return $command.Source
    }
    return (Resolve-Path -LiteralPath $SelectedPowerShell -ErrorAction Stop).Path
  }

  $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  }
  if ($null -eq $command) {
    throw "Could not locate powershell.exe or pwsh.exe for the tray shortcut."
  }
  return $command.Source
}

function Resolve-ClaudeBuddyShortcutDirectory {
  param(
    [string]$Override,
    [string]$SpecialFolder
  )
  if (-not [string]::IsNullOrWhiteSpace($Override)) {
    return [System.IO.Path]::GetFullPath($Override)
  }
  $folder = [System.Environment]::GetFolderPath($SpecialFolder)
  if ([string]::IsNullOrWhiteSpace($folder)) {
    throw "Could not resolve Windows special folder: $SpecialFolder"
  }
  return $folder
}

function Get-ClaudeBuddyTrayShortcutArguments {
  return Join-ClaudeBuddyArguments -Arguments @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    $trayScript,
    "-Config",
    $configPath,
    "-PidFile",
    $pidFilePath,
    "-TaskName",
    $TaskName,
    "-Node",
    $Node,
    "-PollSeconds",
    ([string]([Math]::Max(1, $PollSeconds)))
  )
}

function Install-ClaudeBuddyTrayShortcut {
  param(
    [string]$Kind,
    [string]$Directory,
    [string]$PowerShellPath,
    [string]$ShortcutArguments
  )
  $path = Join-Path $Directory "$ShortcutName.lnk"
  $created = $false
  if ($PSCmdlet.ShouldProcess($path, "create ClaudeBuddy tray shortcut")) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $shell = $null
    $shortcut = $null
    try {
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($path)
      $shortcut.TargetPath = $PowerShellPath
      $shortcut.Arguments = $ShortcutArguments
      $shortcut.WorkingDirectory = $repoRoot
      $shortcut.Description = "Launch ClaudeBuddy tray."
      $shortcut.IconLocation = "$PowerShellPath,0"
      $shortcut.Save()
      $created = $true
    } finally {
      if ($null -ne $shortcut) {
        [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
      }
      if ($null -ne $shell) {
        [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
      }
    }
  }
  return [ordered]@{
    kind = $Kind
    path = $path
    created = $created
    targetPath = $PowerShellPath
    arguments = $ShortcutArguments
    workingDirectory = $repoRoot
  }
}

$installStartMenu = $StartMenu -or $All
$installStartup = $Startup -or $All
if (-not $installStartMenu -and -not $installStartup) {
  $installStartMenu = $true
}

$powerShellPath = Get-ClaudeBuddyShortcutPowerShell -SelectedPowerShell $PowerShell
$shortcutArguments = Get-ClaudeBuddyTrayShortcutArguments
$items = @()

if ($installStartMenu) {
  $items += Install-ClaudeBuddyTrayShortcut `
    -Kind "startMenu" `
    -Directory (Resolve-ClaudeBuddyShortcutDirectory -Override $StartMenuDir -SpecialFolder "Programs") `
    -PowerShellPath $powerShellPath `
    -ShortcutArguments $shortcutArguments
}

if ($installStartup) {
  $items += Install-ClaudeBuddyTrayShortcut `
    -Kind "startup" `
    -Directory (Resolve-ClaudeBuddyShortcutDirectory -Override $StartupDir -SpecialFolder "Startup") `
    -PowerShellPath $powerShellPath `
    -ShortcutArguments $shortcutArguments
}

$result = [ordered]@{
  ok = $true
  shortcutName = $ShortcutName
  config = $configPath
  pidFile = $pidFilePath
  trayScript = $trayScript
  items = $items
}

if ($Json) {
  $result | ConvertTo-Json -Depth 20
} else {
  foreach ($item in $items) {
    if ($item.created) {
      Write-Host "Installed $($item.kind) shortcut: $($item.path)"
    } else {
      Write-Host "Planned $($item.kind) shortcut: $($item.path)"
    }
  }
}
exit 0
