[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [string]$ShortcutName = "ClaudeBuddy Tray",
  [switch]$StartMenu,
  [switch]$Startup,
  [switch]$All,
  [string]$StartMenuDir = "",
  [string]$StartupDir = "",
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

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

function Uninstall-ClaudeBuddyTrayShortcut {
  param(
    [string]$Kind,
    [string]$Directory
  )
  $path = Join-Path $Directory "$ShortcutName.lnk"
  $existed = Test-Path -LiteralPath $path
  $removed = $false
  if ($existed -and $PSCmdlet.ShouldProcess($path, "remove ClaudeBuddy tray shortcut")) {
    Remove-Item -LiteralPath $path -Force
    $removed = $true
  }
  return [ordered]@{
    kind = $Kind
    path = $path
    existed = $existed
    removed = $removed
  }
}

$removeStartMenu = $StartMenu -or $All
$removeStartup = $Startup -or $All
if (-not $removeStartMenu -and -not $removeStartup) {
  $removeStartMenu = $true
  $removeStartup = $true
}

$items = @()
if ($removeStartMenu) {
  $items += Uninstall-ClaudeBuddyTrayShortcut `
    -Kind "startMenu" `
    -Directory (Resolve-ClaudeBuddyShortcutDirectory -Override $StartMenuDir -SpecialFolder "Programs")
}
if ($removeStartup) {
  $items += Uninstall-ClaudeBuddyTrayShortcut `
    -Kind "startup" `
    -Directory (Resolve-ClaudeBuddyShortcutDirectory -Override $StartupDir -SpecialFolder "Startup")
}

$result = [ordered]@{
  ok = $true
  shortcutName = $ShortcutName
  items = $items
}

if ($Json) {
  $result | ConvertTo-Json -Depth 20
} else {
  foreach ($item in $items) {
    if ($item.removed) {
      Write-Host "Removed $($item.kind) shortcut: $($item.path)"
    } elseif ($item.existed) {
      Write-Host "Planned removal for $($item.kind) shortcut: $($item.path)"
    } else {
      Write-Host "Shortcut not found: $($item.path)"
    }
  }
}
exit 0
