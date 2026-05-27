[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ArtifactPath = "dist\claudebuddy-0.0.0.tgz",
  [string]$WorkDir = "",
  [string]$Npm = "npm",
  [string]$Node = "node",
  [switch]$KeepWorkDir,
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$artifact = Resolve-ClaudeBuddyPath -PathValue $ArtifactPath -BasePath $repoRoot
$artifactExists = Test-Path -LiteralPath $artifact
if (-not $artifactExists -and -not $WhatIfPreference) {
  throw "Artifact not found: $artifact"
}

$generatedWorkDir = $false
if ([string]::IsNullOrWhiteSpace($WorkDir)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) "claudebuddy-artifact-smoke-$stamp"
  $generatedWorkDir = $true
}
$workPath = Resolve-ClaudeBuddyPath -PathValue $WorkDir -BasePath $repoRoot
$markerPath = Join-Path $workPath ".claudebuddy-artifact-smoke"
$packageRoot = Join-Path $workPath "node_modules\claudebuddy"
$cliPath = Join-Path $packageRoot "bin\claudebuddy.js"
$quickCommandConsumerPath = Join-Path $packageRoot "bin\claudebuddy-quick-command-consumer.js"
$trayScript = Join-Path $packageRoot "scripts\claudebuddy-tray.ps1"
$fakeConfig = Join-Path $packageRoot "examples\claudebuddy.fake.config.json"
$quickCommandsConfig = Join-Path $packageRoot "examples\claudebuddy.quick-commands.config.json"
$pidFile = Join-Path $workPath "daemon.pid"

function Invoke-ClaudeBuddyArtifactSmokeCommand {
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

function Remove-ClaudeBuddyArtifactSmokeWorkDir {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    return $false
  }
  $marker = Join-Path $Path ".claudebuddy-artifact-smoke"
  if (-not (Test-Path -LiteralPath $marker)) {
    throw "Refusing to remove artifact smoke directory without marker: $Path"
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
  return $true
}

$steps = [ordered]@{
  install = $false
  help = $false
  quickCommandConsumerHelp = $false
  exports = $false
  fakeOnce = $false
  trayValidate = $false
}
$files = [ordered]@{
  packageRoot = $false
  cli = $false
  quickCommandConsumerCli = $false
  trayScript = $false
  fakeConfig = $false
  quickCommandsConfig = $false
  quickCommandAdapter = $false
  quickCommandHttpConsumer = $false
  taskStateRuntime = $false
  sidecar = $false
  bleakBackend = $false
}
$cleanup = [ordered]@{
  attempted = $false
  removed = $false
}

try {
  if ($PSCmdlet.ShouldProcess($workPath, "create artifact smoke work directory")) {
    New-Item -ItemType Directory -Force -Path $workPath | Out-Null
    Set-Content -LiteralPath $markerPath -Value "claudebuddy artifact smoke" -Encoding ascii
    Set-Content -LiteralPath (Join-Path $workPath "package.json") -Value '{"private":true}' -Encoding ascii
  }

  if ($PSCmdlet.ShouldProcess($workPath, "install local artifact")) {
    [void](Invoke-ClaudeBuddyArtifactSmokeCommand -FilePath $Npm -Arguments @(
      "install",
      $artifact,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts"
    ) -FailureMessage "npm install local artifact" -WorkingDirectory $workPath)
    $steps.install = $true
  }

  $files.packageRoot = Test-Path -LiteralPath $packageRoot
  $files.cli = Test-Path -LiteralPath $cliPath
  $files.quickCommandConsumerCli = Test-Path -LiteralPath $quickCommandConsumerPath
  $files.trayScript = Test-Path -LiteralPath $trayScript
  $files.fakeConfig = Test-Path -LiteralPath $fakeConfig
  $files.quickCommandsConfig = Test-Path -LiteralPath $quickCommandsConfig
  $files.quickCommandAdapter = Test-Path -LiteralPath (Join-Path $packageRoot "src\adapters\quick-command-actions.js")
  $files.quickCommandHttpConsumer = Test-Path -LiteralPath (Join-Path $packageRoot "src\adapters\quick-command-http-jsonl-consumer.js")
  $files.taskStateRuntime = Test-Path -LiteralPath (Join-Path $packageRoot "src\runtime\task-state.js")
  $files.sidecar = Test-Path -LiteralPath (Join-Path $packageRoot "tools\hardware_buddy_bridge.py")
  $files.bleakBackend = Test-Path -LiteralPath (Join-Path $packageRoot "tools\backends\bleak_backend.py")
  if (-not $WhatIfPreference -and ($files.Values -contains $false)) {
    throw "Packaged install is missing one or more expected files."
  }

  if ($PSCmdlet.ShouldProcess($cliPath, "run packaged CLI help")) {
    $helpOutput = Invoke-ClaudeBuddyArtifactSmokeCommand -FilePath $Node -Arguments @($cliPath, "--help") -FailureMessage "packaged CLI help"
    if (($helpOutput -join "`n") -notmatch "Usage: claudebuddy") {
      throw "Packaged CLI help did not contain expected usage text."
    }
    $steps.help = $true
  }

  if ($PSCmdlet.ShouldProcess($quickCommandConsumerPath, "run packaged quick command consumer help")) {
    $consumerHelpOutput = Invoke-ClaudeBuddyArtifactSmokeCommand -FilePath $Node -Arguments @($quickCommandConsumerPath, "--help") -FailureMessage "packaged quick command consumer help"
    if (($consumerHelpOutput -join "`n") -notmatch "Usage: claudebuddy-quick-command-consumer") {
      throw "Packaged quick command consumer help did not contain expected usage text."
    }
    $steps.quickCommandConsumerHelp = $true
  }

  if ($PSCmdlet.ShouldProcess($packageRoot, "require packaged exports")) {
    $requireScript = "const api=require('claudebuddy'); if (typeof api.HeadlessHardwareBuddyRuntime !== 'function') process.exit(11); if (typeof api.mapQuickCommandToAdapterAction !== 'function') process.exit(12); if (typeof api.consumeQuickCommandsOnce !== 'function') process.exit(13); if (typeof api.normalizeTaskStateInput !== 'function') process.exit(14); if (api.findSidecarContention !== undefined) process.exit(15);"
    [void](Invoke-ClaudeBuddyArtifactSmokeCommand -FilePath $Node -Arguments @("-e", $requireScript) -FailureMessage "packaged exports" -WorkingDirectory $workPath)
    $steps.exports = $true
  }

  if ($PSCmdlet.ShouldProcess($cliPath, "run packaged fake once smoke")) {
    [void](Invoke-ClaudeBuddyArtifactSmokeCommand -FilePath $Node -Arguments @(
      $cliPath,
      "--transport",
      "fake",
      "--title",
      "Artifact Smoke",
      "--once",
      "--once-ms",
      "0",
      "--keepalive-ms",
      "0",
      "--log-level",
      "warn"
    ) -FailureMessage "packaged fake once smoke")
    $steps.fakeOnce = $true
  }

  if ($PSCmdlet.ShouldProcess($trayScript, "validate packaged tray wrapper")) {
    $powerShell = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
    if ([string]::IsNullOrWhiteSpace($powerShell) -or -not (Test-Path -LiteralPath $powerShell)) {
      $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
      if ($null -eq $command) {
        $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
      }
      if ($null -eq $command) {
        throw "Could not locate PowerShell for packaged tray validation."
      }
      $powerShell = $command.Source
    }
    $trayOutput = Invoke-ClaudeBuddyArtifactSmokeCommand -FilePath $powerShell -Arguments @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $trayScript,
      "-ValidateOnly",
      "-Json",
      "-Config",
      $fakeConfig,
      "-PidFile",
      $pidFile,
      "-TaskName",
      "ClaudeBuddyArtifactSmoke",
      "-Node",
      $Node
    ) -FailureMessage "packaged tray validation"
    $trayJson = ($trayOutput -join "`n").Trim()
    $trayStatus = $trayJson | ConvertFrom-Json
    if ($trayStatus.ok -ne $true) {
      throw "Packaged tray validation returned ok=false."
    }
    $steps.trayValidate = $true
  }
} finally {
  if (-not $KeepWorkDir -and -not $WhatIfPreference) {
    $cleanup.attempted = $true
    $cleanup.removed = Remove-ClaudeBuddyArtifactSmokeWorkDir -Path $workPath
  }
}

$result = [ordered]@{
  ok = if ($WhatIfPreference) { $true } else { -not ($steps.Values -contains $false) }
  artifact = $artifact
  artifactExists = $artifactExists
  workDir = $workPath
  generatedWorkDir = $generatedWorkDir
  keptWorkDir = [bool]$KeepWorkDir
  steps = $steps
  files = $files
  cleanup = $cleanup
}

if ($Json) {
  $result | ConvertTo-Json -Depth 30
} else {
  Write-Host "Artifact smoke ok=$($result.ok)"
  Write-Host "Artifact: $artifact"
  Write-Host "Work dir: $workPath"
  Write-Host "Cleaned up: $($cleanup.removed)"
}
exit 0
