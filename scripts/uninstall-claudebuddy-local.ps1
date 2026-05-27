[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [string]$InstallDir = "",
  [string]$Config = "",
  [string]$PidFile = "",
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$ShortcutName = "ClaudeBuddy Tray",
  [string]$Node = "node",
  [string]$PowerShell = "",
  [int]$TimeoutSec = 5,
  [switch]$KeepDaemon,
  [switch]$KeepAutostart,
  [switch]$KeepShortcuts,
  [switch]$RemoveConfig,
  [switch]$RemoveLogs,
  [switch]$RemoveInstallDir,
  [string]$StartMenuDir = "",
  [string]$StartupDir = "",
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $localAppData = [System.Environment]::GetFolderPath("LocalApplicationData")
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = $repoRoot
  }
  $InstallDir = Join-Path $localAppData "ClaudeBuddy\Standalone"
}

$installPath = Resolve-ClaudeBuddyPath -PathValue $InstallDir -BasePath $repoRoot
$configPath = if ([string]::IsNullOrWhiteSpace($Config)) {
  Join-Path $installPath "claudebuddy.config.json"
} else {
  Resolve-ClaudeBuddyPath -PathValue $Config -BasePath $repoRoot
}
$pidFilePath = if ([string]::IsNullOrWhiteSpace($PidFile)) {
  Join-Path $installPath "logs\claudebuddy-daemon.pid"
} else {
  Resolve-ClaudeBuddyPath -PathValue $PidFile -BasePath $repoRoot
}

$packageRoot = Join-Path $installPath "node_modules\claudebuddy"
$packageJson = Join-Path $installPath "package.json"
$packageLock = Join-Path $installPath "package-lock.json"
$nodeModules = Join-Path $installPath "node_modules"
$logsDir = Join-Path $installPath "logs"
$uninstallerPowerShell = $PowerShell
if ([string]::IsNullOrWhiteSpace($uninstallerPowerShell)) {
  $uninstallerPowerShell = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
  if ([string]::IsNullOrWhiteSpace($uninstallerPowerShell) -or -not (Test-Path -LiteralPath $uninstallerPowerShell)) {
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
      $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
      throw "Could not locate PowerShell for local uninstall."
    }
    $uninstallerPowerShell = $command.Source
  }
}

function Resolve-ClaudeBuddyLocalUninstallScript {
  param([string]$Name)
  $packaged = Join-Path $packageRoot "scripts\$Name"
  if (Test-Path -LiteralPath $packaged) {
    return $packaged
  }
  return Join-Path $PSScriptRoot $Name
}

function Invoke-ClaudeBuddyLocalUninstallCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )
  $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ })
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  if ($exitCode -ne 0) {
    throw "$FailureMessage exited with code $exitCode.`n$($output -join "`n")"
  }
  return $output
}

function Invoke-ClaudeBuddyLocalUninstallScript {
  param(
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )
  Invoke-ClaudeBuddyLocalUninstallCommand -FilePath $uninstallerPowerShell -Arguments (@(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $ScriptPath
  ) + $Arguments) -FailureMessage $FailureMessage
}

function ConvertFrom-ClaudeBuddyLocalUninstallJson {
  param([string[]]$Output)
  $text = ($Output -join "`n").Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  $starts = @()
  $index = $text.IndexOf("{")
  while ($index -ge 0) {
    $starts += $index
    $index = $text.IndexOf("{", $index + 1)
  }

  $ends = @()
  $index = $text.IndexOf("}")
  while ($index -ge 0) {
    $ends += $index
    $index = $text.IndexOf("}", $index + 1)
  }
  [array]::Reverse($ends)

  foreach ($start in $starts) {
    foreach ($end in $ends) {
      if ($end -le $start) {
        continue
      }
      try {
        return $text.Substring($start, $end - $start + 1) | ConvertFrom-Json -ErrorAction Stop
      } catch {
        # Keep scanning; child scripts may emit warnings around JSON.
      }
    }
  }

  throw "Command did not emit a JSON object.`n$text"
}

function Test-ClaudeBuddyLocalSafeRemoveRoot {
  param([string]$PathValue)
  $fullPath = [System.IO.Path]::GetFullPath($PathValue)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($fullPath) -or $fullPath -ieq $root) {
    return $false
  }
  if ($fullPath -ieq [System.IO.Path]::GetFullPath($repoRoot)) {
    return $false
  }
  return $true
}

function Remove-ClaudeBuddyLocalPath {
  param(
    [string]$PathValue,
    [string]$Action,
    [bool]$Recursive = $false
  )
  $existed = Test-Path -LiteralPath $PathValue
  $removed = $false
  if ($existed -and $PSCmdlet.ShouldProcess($PathValue, $Action)) {
    if ($Recursive) {
      Remove-Item -LiteralPath $PathValue -Recurse -Force
    } else {
      Remove-Item -LiteralPath $PathValue -Force
    }
    $removed = $true
  }
  return [ordered]@{
    path = $PathValue
    existed = $existed
    removed = $removed
  }
}

function Test-ClaudeBuddyGeneratedPackageJson {
  param([string]$PathValue)
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return $false
  }
  try {
    $json = Get-Content -LiteralPath $PathValue -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $false
  }
  if ($json.private -ne $true) {
    return $false
  }

  $allowedTopLevel = @("private", "_claudebuddyGenerated", "dependencies")
  $unexpectedTopLevel = @($json.PSObject.Properties.Name | Where-Object { $allowedTopLevel -notcontains $_ })
  if ($unexpectedTopLevel.Count -gt 0) {
    return $false
  }

  $dependencyProperty = $json.PSObject.Properties["dependencies"]
  if ($null -ne $dependencyProperty -and $null -ne $dependencyProperty.Value) {
    $dependencyNames = @($dependencyProperty.Value.PSObject.Properties.Name)
    $unexpectedDependencies = @($dependencyNames | Where-Object { $_ -ne "claudebuddy" })
    if ($unexpectedDependencies.Count -gt 0) {
      return $false
    }
  }

  $marker = $json.PSObject.Properties["_claudebuddyGenerated"]
  if ($null -ne $marker) {
    return $marker.Value -eq $true
  }

  # Backward-compatible cleanup for package.json files generated before the marker existed.
  return $true
}

function Get-ClaudeBuddyJsonMapKeys {
  param([object]$Object)
  if ($null -eq $Object) {
    return @()
  }
  if ($Object -is [System.Collections.IDictionary]) {
    return @($Object.Keys)
  }
  return @($Object.PSObject.Properties.Name)
}

function Get-ClaudeBuddyJsonMapValue {
  param(
    [object]$Object,
    [string]$Name
  )
  if ($null -eq $Object) {
    return $null
  }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) {
      return $Object[$Name]
    }
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Test-ClaudeBuddyDependencyMapOnly {
  param([object]$Object)
  if ($null -eq $Object) {
    return $true
  }
  $names = Get-ClaudeBuddyJsonMapKeys -Object $Object
  $unexpected = @($names | Where-Object { $_ -ne "claudebuddy" })
  return $unexpected.Count -eq 0
}

function Test-ClaudeBuddyGeneratedPackageLock {
  param([string]$PathValue)
  if (-not (Test-Path -LiteralPath $PathValue)) {
    return $false
  }
  $rootPackageKey = ""
  try {
    $raw = Get-Content -LiteralPath $PathValue -Raw
    $convertFromJson = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($convertFromJson.Parameters.ContainsKey("AsHashTable")) {
      $json = $raw | ConvertFrom-Json -AsHashTable -ErrorAction Stop
    } else {
      $rootPackageKey = "__claudebuddyRootPackage"
      $json = ($raw -replace '"":', ('"' + $rootPackageKey + '":')) | ConvertFrom-Json -ErrorAction Stop
    }
  } catch {
    return $false
  }

  $packages = Get-ClaudeBuddyJsonMapValue -Object $json -Name "packages"
  if ($null -eq $packages) {
    return $false
  }

  $packageNames = Get-ClaudeBuddyJsonMapKeys -Object $packages
  $unexpectedPackages = @($packageNames | Where-Object { $_ -ne "" -and $_ -ne $rootPackageKey -and $_ -ne "node_modules/claudebuddy" })
  if ($unexpectedPackages.Count -gt 0) {
    return $false
  }

  $rootPackage = Get-ClaudeBuddyJsonMapValue -Object $packages -Name $rootPackageKey
  if ($null -ne $rootPackage) {
    foreach ($dependencyField in @("dependencies", "devDependencies", "optionalDependencies")) {
      if (-not (Test-ClaudeBuddyDependencyMapOnly -Object (Get-ClaudeBuddyJsonMapValue -Object $rootPackage -Name $dependencyField))) {
        return $false
      }
    }
  }

  if (-not (Test-ClaudeBuddyDependencyMapOnly -Object (Get-ClaudeBuddyJsonMapValue -Object $json -Name "dependencies"))) {
    return $false
  }

  return $packageNames.Count -gt 0
}

function Remove-ClaudeBuddyGeneratedPackageLock {
  param([string]$PathValue)
  $existed = Test-Path -LiteralPath $PathValue
  $removed = $false
  $reason = ""
  if ($existed) {
    if (Test-ClaudeBuddyGeneratedPackageLock -PathValue $PathValue) {
      if ($PSCmdlet.ShouldProcess($PathValue, "remove generated ClaudeBuddy package lock")) {
        Remove-Item -LiteralPath $PathValue -Force
        $removed = $true
      }
    } else {
      $reason = "Package lock does not look generated solely by the ClaudeBuddy wrapper."
    }
  }
  return [ordered]@{
    path = $PathValue
    existed = $existed
    removed = $removed
    reason = $reason
  }
}

$stopScript = Resolve-ClaudeBuddyLocalUninstallScript -Name "stop-claudebuddy-daemon.ps1"
$shortcutUninstaller = Resolve-ClaudeBuddyLocalUninstallScript -Name "uninstall-claudebuddy-tray-shortcuts.ps1"
$taskUninstaller = Resolve-ClaudeBuddyLocalUninstallScript -Name "uninstall-claudebuddy-scheduled-task.ps1"
$steps = [ordered]@{
  daemon = $false
  autostart = $false
  shortcuts = $false
  package = $false
  config = $false
  logs = $false
  installDir = $false
}
$outputs = [ordered]@{
  daemon = @()
  autostart = $null
  shortcuts = $null
  packageRoot = $null
  nodeModules = $null
  packageJson = $null
  packageLock = $null
  nodePackageLock = $null
  nodeBin = @()
  config = $null
  logs = $null
  installDir = $null
}

if (-not $KeepDaemon) {
  if ($PSCmdlet.ShouldProcess($pidFilePath, "stop ClaudeBuddy daemon")) {
    $outputs.daemon = Invoke-ClaudeBuddyLocalUninstallScript -ScriptPath $stopScript -Arguments @(
      "-Config", $configPath,
      "-PidFile", $pidFilePath,
      "-Node", $Node,
      "-TimeoutSec", ([string]([Math]::Max(0, $TimeoutSec)))
    ) -FailureMessage "stop ClaudeBuddy daemon"
    $steps.daemon = $true
  }
}

if (-not $KeepAutostart) {
  if ($PSCmdlet.ShouldProcess($TaskName, "remove ClaudeBuddy scheduled task")) {
    $taskArgs = @(
      "-TaskName", $TaskName,
      "-Config", $configPath,
      "-PidFile", $pidFilePath,
      "-Node", $Node,
      "-TimeoutSec", ([string]([Math]::Max(0, $TimeoutSec))),
      "-KeepDaemon",
      "-Json"
    )
    if ($WhatIfPreference) { $taskArgs += "-WhatIf" }
    $taskOutput = Invoke-ClaudeBuddyLocalUninstallScript -ScriptPath $taskUninstaller -Arguments $taskArgs -FailureMessage "remove ClaudeBuddy scheduled task"
    $outputs.autostart = ConvertFrom-ClaudeBuddyLocalUninstallJson -Output $taskOutput
    $steps.autostart = $true
  }
}

if (-not $KeepShortcuts) {
  if ($PSCmdlet.ShouldProcess($ShortcutName, "remove ClaudeBuddy tray shortcuts")) {
    $shortcutArgs = @(
      "-ShortcutName", $ShortcutName,
      "-All",
      "-Json"
    )
    if (-not [string]::IsNullOrWhiteSpace($StartMenuDir)) { $shortcutArgs += @("-StartMenuDir", $StartMenuDir) }
    if (-not [string]::IsNullOrWhiteSpace($StartupDir)) { $shortcutArgs += @("-StartupDir", $StartupDir) }
    if ($WhatIfPreference) { $shortcutArgs += "-WhatIf" }
    $shortcutOutput = Invoke-ClaudeBuddyLocalUninstallScript -ScriptPath $shortcutUninstaller -Arguments $shortcutArgs -FailureMessage "remove ClaudeBuddy tray shortcuts"
    $outputs.shortcuts = ConvertFrom-ClaudeBuddyLocalUninstallJson -Output $shortcutOutput
    $steps.shortcuts = $true
  }
}

if ($PSCmdlet.ShouldProcess($packageRoot, "remove ClaudeBuddy package payload")) {
  $outputs.packageRoot = Remove-ClaudeBuddyLocalPath -PathValue $packageRoot -Action "remove ClaudeBuddy package payload" -Recursive $true
  $steps.package = $true
}

if (Test-Path -LiteralPath $nodeModules) {
  $nodeBin = Join-Path $nodeModules ".bin"
  foreach ($shimName in @("claudebuddy", "claudebuddy.cmd", "claudebuddy.ps1")) {
    $shimPath = Join-Path $nodeBin $shimName
    $outputs.nodeBin += Remove-ClaudeBuddyLocalPath -PathValue $shimPath -Action "remove ClaudeBuddy npm bin shim" -Recursive $false
  }
  if (Test-Path -LiteralPath $nodeBin) {
    $remainingBinItems = @(Get-ChildItem -LiteralPath $nodeBin -Force -ErrorAction SilentlyContinue)
    if ($remainingBinItems.Count -eq 0) {
      [void](Remove-ClaudeBuddyLocalPath -PathValue $nodeBin -Action "remove empty npm bin directory" -Recursive $true)
    }
  }
  $outputs.nodePackageLock = Remove-ClaudeBuddyGeneratedPackageLock -PathValue (Join-Path $nodeModules ".package-lock.json")
}

if (Test-Path -LiteralPath $nodeModules) {
  $remainingNodeModulesItems = @(Get-ChildItem -LiteralPath $nodeModules -Force -ErrorAction SilentlyContinue)
  $onlyNpmMetadata = $remainingNodeModulesItems.Count -gt 0 -and (
    @($remainingNodeModulesItems | Where-Object { $_.Name -ne ".package-lock.json" }).Count -eq 0
  )
  if ($remainingNodeModulesItems.Count -eq 0 -or $onlyNpmMetadata) {
    $outputs.nodeModules = Remove-ClaudeBuddyLocalPath -PathValue $nodeModules -Action "remove empty node_modules directory" -Recursive $true
  }
}

$outputs.packageLock = Remove-ClaudeBuddyGeneratedPackageLock -PathValue $packageLock

if (Test-ClaudeBuddyGeneratedPackageJson -PathValue $packageJson) {
  $outputs.packageJson = Remove-ClaudeBuddyLocalPath -PathValue $packageJson -Action "remove generated ClaudeBuddy package.json" -Recursive $false
} elseif (Test-Path -LiteralPath $packageJson) {
  $outputs.packageJson = [ordered]@{
    path = $packageJson
    existed = $true
    removed = $false
    reason = "package.json does not look generated solely by the ClaudeBuddy wrapper."
  }
}

if ($RemoveConfig) {
  $outputs.config = Remove-ClaudeBuddyLocalPath -PathValue $configPath -Action "remove ClaudeBuddy config" -Recursive $false
  $steps.config = $true
}

if ($RemoveLogs) {
  $outputs.logs = Remove-ClaudeBuddyLocalPath -PathValue $logsDir -Action "remove ClaudeBuddy logs directory" -Recursive $true
  $steps.logs = $true
}

if ($RemoveInstallDir) {
  if (-not (Test-ClaudeBuddyLocalSafeRemoveRoot -PathValue $installPath)) {
    throw "Refusing to remove unsafe install directory: $installPath"
  }
  $installDirExisted = Test-Path -LiteralPath $installPath
  $installDirRemoved = $false
  $installDirReason = ""
  if ($installDirExisted) {
    $remainingInstallItems = @(Get-ChildItem -LiteralPath $installPath -Force -ErrorAction SilentlyContinue)
    if ($remainingInstallItems.Count -eq 0) {
      if ($PSCmdlet.ShouldProcess($installPath, "remove empty ClaudeBuddy install directory")) {
        Remove-Item -LiteralPath $installPath -Force
        $installDirRemoved = $true
      }
    } else {
      $installDirReason = "Install directory is not empty; leaving it in place."
    }
  }
  $outputs.installDir = [ordered]@{
    path = $installPath
    existed = $installDirExisted
    removed = $installDirRemoved
    reason = $installDirReason
  }
  $steps.installDir = $true
}

$result = [ordered]@{
  ok = $true
  installDir = $installPath
  packageRoot = $packageRoot
  config = $configPath
  pidFile = $pidFilePath
  taskName = $TaskName
  shortcutName = $ShortcutName
  keepDaemon = [bool]$KeepDaemon
  keepAutostart = [bool]$KeepAutostart
  keepShortcuts = [bool]$KeepShortcuts
  removeConfig = [bool]$RemoveConfig
  removeLogs = [bool]$RemoveLogs
  removeInstallDir = [bool]$RemoveInstallDir
  steps = $steps
  outputs = $outputs
}

if ($Json) {
  $result | ConvertTo-Json -Depth 40
} else {
  Write-Host "ClaudeBuddy local uninstall ok=$($result.ok)"
  Write-Host "Install dir: $installPath"
  Write-Host "Config: $configPath"
  Write-Host "PID file: $pidFilePath"
}
exit 0
