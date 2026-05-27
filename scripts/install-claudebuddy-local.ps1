[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ArtifactPath = "dist\claudebuddy-0.0.0.tgz",
  [string]$InstallDir = "",
  [string]$Config = "",
  [string]$ConfigTemplate = "examples\claudebuddy.http-ble.example.config.json",
  [string]$PidFile = "",
  [string]$TaskName = "ClaudeBuddyStandalone",
  [string]$ShortcutName = "ClaudeBuddy Tray",
  [string]$Node = "node",
  [string]$Npm = "npm",
  [string]$PowerShell = "",
  [int]$PollSeconds = 5,
  [switch]$StartMenu,
  [switch]$Startup,
  [switch]$AllShortcuts,
  [string]$StartMenuDir = "",
  [string]$StartupDir = "",
  [switch]$Autostart,
  [switch]$StartDaemon,
  [switch]$Force,
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
$artifact = Resolve-ClaudeBuddyPath -PathValue $ArtifactPath -BasePath $repoRoot
$artifactExists = Test-Path -LiteralPath $artifact
if (-not $artifactExists -and -not $WhatIfPreference) {
  throw "Artifact not found: $artifact"
}

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
$installedPackageJson = Join-Path $packageRoot "package.json"
$templatePath = if ([System.IO.Path]::IsPathRooted($ConfigTemplate)) {
  [System.IO.Path]::GetFullPath($ConfigTemplate)
} else {
  Join-Path $packageRoot $ConfigTemplate
}
$trayScript = Join-Path $packageRoot "scripts\claudebuddy-tray.ps1"
$shortcutInstaller = Join-Path $packageRoot "scripts\install-claudebuddy-tray-shortcuts.ps1"
$taskInstaller = Join-Path $packageRoot "scripts\install-claudebuddy-scheduled-task.ps1"
$daemonStarter = Join-Path $packageRoot "scripts\start-claudebuddy-daemon.ps1"
$installerPowerShell = $PowerShell
if ([string]::IsNullOrWhiteSpace($installerPowerShell)) {
  $installerPowerShell = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
  if ([string]::IsNullOrWhiteSpace($installerPowerShell) -or -not (Test-Path -LiteralPath $installerPowerShell)) {
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
      $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
      throw "Could not locate PowerShell for installed tray validation."
    }
    $installerPowerShell = $command.Source
  }
}

function Invoke-ClaudeBuddyLocalInstallCommand {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage,
    [string]$WorkingDirectory = ""
  )
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    Push-Location $WorkingDirectory
  }
  try {
    $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    if ($exitCode -ne 0) {
      throw "$FailureMessage exited with code $exitCode.`n$($output -join "`n")"
    }
    return $output
  } finally {
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
      Pop-Location
    }
  }
}

function Invoke-ClaudeBuddyLocalInstallScript {
  param(
    [string]$ScriptPath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )
  Invoke-ClaudeBuddyLocalInstallCommand -FilePath $installerPowerShell -Arguments (@(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $ScriptPath
  ) + $Arguments) -FailureMessage $FailureMessage
}

function ConvertFrom-ClaudeBuddyLocalInstallJson {
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
        # Keep scanning; PowerShell warnings can contain braces before or after JSON.
      }
    }
  }

  throw "Command did not emit a JSON object.`n$text"
}

$steps = [ordered]@{
  installDirectory = $false
  npmInstall = $false
  config = $false
  trayValidate = $false
  shortcuts = $false
  autostart = $false
  daemon = $false
}
$outputs = [ordered]@{
  trayValidation = $null
  shortcuts = $null
  autostart = $null
  daemon = @()
}

if ($PSCmdlet.ShouldProcess($installPath, "create ClaudeBuddy install directory")) {
  New-Item -ItemType Directory -Force -Path $installPath | Out-Null
  if (-not (Test-Path -LiteralPath $packageJson) -or $Force) {
    Set-Content -LiteralPath $packageJson -Value '{"private":true,"_claudebuddyGenerated":true}' -Encoding ascii
  }
  $steps.installDirectory = $true
}

if ($PSCmdlet.ShouldProcess($installPath, "install ClaudeBuddy artifact")) {
  [void](Invoke-ClaudeBuddyLocalInstallCommand -FilePath $Npm -Arguments @(
    "install",
    $artifact,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts"
  ) -FailureMessage "npm install ClaudeBuddy artifact" -WorkingDirectory $installPath)
  $steps.npmInstall = $true
}

if (-not $WhatIfPreference -and -not (Test-Path -LiteralPath $installedPackageJson)) {
  throw "ClaudeBuddy package did not install to expected path: $installedPackageJson"
}

if ($PSCmdlet.ShouldProcess($configPath, "write ClaudeBuddy config from template")) {
  if ((Test-Path -LiteralPath $configPath) -and -not $Force) {
    $steps.config = $true
  } else {
    if (-not (Test-Path -LiteralPath $templatePath)) {
      throw "Config template not found: $templatePath"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configPath) | Out-Null
    Copy-Item -LiteralPath $templatePath -Destination $configPath -Force
    $steps.config = $true
  }
}

if ($PSCmdlet.ShouldProcess($trayScript, "validate installed ClaudeBuddy tray")) {
  $trayOutput = Invoke-ClaudeBuddyLocalInstallScript -ScriptPath $trayScript -Arguments @(
    "-ValidateOnly",
    "-Json",
    "-Config",
    $configPath,
    "-PidFile",
    $pidFilePath,
    "-TaskName",
    $TaskName,
    "-Node",
    $Node
  ) -FailureMessage "installed tray validation"
  $outputs.trayValidation = ConvertFrom-ClaudeBuddyLocalInstallJson -Output $trayOutput
  if ($outputs.trayValidation.ok -ne $true) {
    throw "Installed tray validation returned ok=false."
  }
  $steps.trayValidate = $true
}

$installShortcuts = $StartMenu -or $Startup -or $AllShortcuts
if ($installShortcuts) {
  if ($PSCmdlet.ShouldProcess($ShortcutName, "install ClaudeBuddy tray shortcuts")) {
    $shortcutArgs = @(
      "-ShortcutName", $ShortcutName,
      "-Config", $configPath,
      "-PidFile", $pidFilePath,
      "-TaskName", $TaskName,
      "-Node", $Node,
      "-PollSeconds", ([string]([Math]::Max(1, $PollSeconds))),
      "-Json"
    )
    if (-not [string]::IsNullOrWhiteSpace($PowerShell)) { $shortcutArgs += @("-PowerShell", $PowerShell) }
    if ($StartMenu) { $shortcutArgs += "-StartMenu" }
    if ($Startup) { $shortcutArgs += "-Startup" }
    if ($AllShortcuts) { $shortcutArgs += "-All" }
    if (-not [string]::IsNullOrWhiteSpace($StartMenuDir)) { $shortcutArgs += @("-StartMenuDir", $StartMenuDir) }
    if (-not [string]::IsNullOrWhiteSpace($StartupDir)) { $shortcutArgs += @("-StartupDir", $StartupDir) }
    if ($WhatIfPreference) { $shortcutArgs += "-WhatIf" }
    $shortcutOutput = Invoke-ClaudeBuddyLocalInstallScript -ScriptPath $shortcutInstaller -Arguments $shortcutArgs -FailureMessage "install ClaudeBuddy tray shortcuts"
    $outputs.shortcuts = ConvertFrom-ClaudeBuddyLocalInstallJson -Output $shortcutOutput
    $steps.shortcuts = $true
  }
}

if ($Autostart) {
  if ($PSCmdlet.ShouldProcess($TaskName, "install ClaudeBuddy scheduled task")) {
    $taskArgs = @(
      "-TaskName", $TaskName,
      "-Config", $configPath,
      "-PidFile", $pidFilePath,
      "-Node", $Node,
      "-Json"
    )
    if ($Force) { $taskArgs += "-Force" }
    if ($WhatIfPreference) { $taskArgs += "-WhatIf" }
    $taskOutput = Invoke-ClaudeBuddyLocalInstallScript -ScriptPath $taskInstaller -Arguments $taskArgs -FailureMessage "install ClaudeBuddy scheduled task"
    $outputs.autostart = ConvertFrom-ClaudeBuddyLocalInstallJson -Output $taskOutput
    $steps.autostart = $true
  }
}

if ($StartDaemon) {
  if ($PSCmdlet.ShouldProcess($configPath, "start ClaudeBuddy daemon")) {
    $daemonOutput = Invoke-ClaudeBuddyLocalInstallScript -ScriptPath $daemonStarter -Arguments @(
      "-Config", $configPath,
      "-PidFile", $pidFilePath,
      "-Node", $Node
    ) -FailureMessage "start ClaudeBuddy daemon"
    $outputs.daemon = $daemonOutput
    $steps.daemon = $true
  }
}

$result = [ordered]@{
  ok = if ($WhatIfPreference) { $true } else { $steps.installDirectory -and $steps.npmInstall -and $steps.config -and $steps.trayValidate }
  artifact = $artifact
  artifactExists = $artifactExists
  installDir = $installPath
  packageRoot = $packageRoot
  config = $configPath
  pidFile = $pidFilePath
  taskName = $TaskName
  shortcutName = $ShortcutName
  steps = $steps
  outputs = $outputs
}

if ($Json) {
  $result | ConvertTo-Json -Depth 40
} else {
  Write-Host "ClaudeBuddy local install ok=$($result.ok)"
  Write-Host "Install dir: $installPath"
  Write-Host "Config: $configPath"
  Write-Host "PID file: $pidFilePath"
}
exit 0
