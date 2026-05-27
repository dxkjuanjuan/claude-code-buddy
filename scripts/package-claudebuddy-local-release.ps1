[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$OutputDir = "dist",
  [string]$Npm = "npm",
  [switch]$SkipTests,
  [switch]$DryRun,
  [switch]$Json
)

. (Join-Path $PSScriptRoot "claudebuddy-daemon-lib.ps1")

$repoRoot = Get-ClaudeBuddyRepoRoot
$outputPath = Resolve-ClaudeBuddyPath -PathValue $OutputDir -BasePath $repoRoot
$packagePath = Join-Path $repoRoot "package.json"
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$packageName = [string]$package.name
$packageVersion = [string]$package.version
$manifestPath = Join-Path $outputPath "$packageName-$packageVersion-local-manifest.json"
$testsRan = $false
$packResult = $null
$artifactPath = ""
$artifactSha256 = ""
$gitCommit = ""
$gitDirty = $null
$errors = @()

function Invoke-ClaudeBuddyReleaseCommand {
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

try {
  $gitCommit = (& git -C $repoRoot rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0) {
    $gitCommit = ""
  }
} catch {
  $gitCommit = ""
}

try {
  $gitStatus = @(& git -C $repoRoot status --short 2>$null)
  if ($LASTEXITCODE -eq 0) {
    $gitDirty = $gitStatus.Count -gt 0
  }
} catch {
  $gitDirty = $null
}

if ($PSCmdlet.ShouldProcess($outputPath, "create local release output directory")) {
  New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
}

if (-not $SkipTests) {
  if ($PSCmdlet.ShouldProcess($repoRoot, "run npm test before packaging")) {
    Push-Location $repoRoot
    try {
      [void](Invoke-ClaudeBuddyReleaseCommand -FilePath $Npm -Arguments @("test") -FailureMessage "npm test")
      $testsRan = $true
    } finally {
      Pop-Location
    }
  }
}

$packArguments = @("pack", "--json", "--pack-destination", $outputPath)
if ($DryRun) {
  $packArguments += "--dry-run"
}

if ($PSCmdlet.ShouldProcess($outputPath, "run npm $($packArguments -join ' ')")) {
  Push-Location $repoRoot
  try {
    $packOutput = Invoke-ClaudeBuddyReleaseCommand -FilePath $Npm -Arguments $packArguments -FailureMessage "npm pack"
    $packJson = ($packOutput -join "`n").Trim()
    $packResult = @($packJson | ConvertFrom-Json)[0]
    if (-not $DryRun -and $null -ne $packResult -and -not [string]::IsNullOrWhiteSpace($packResult.filename)) {
      $artifactPath = Join-Path $outputPath ([string]$packResult.filename)
      if (Test-Path -LiteralPath $artifactPath) {
        $artifactSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
      }
    }
  } finally {
    Pop-Location
  }
}

$manifest = [ordered]@{
  ok = $true
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  dryRun = [bool]$DryRun
  package = [ordered]@{
    name = $packageName
    version = $packageVersion
    private = [bool]$package.private
    license = [string]$package.license
  }
  git = [ordered]@{
    commit = $gitCommit
    dirty = $gitDirty
  }
  outputDir = $outputPath
  artifact = [ordered]@{
    filename = if ($null -ne $packResult) { [string]$packResult.filename } else { "" }
    path = $artifactPath
    size = if ($null -ne $packResult) { $packResult.size } else { $null }
    unpackedSize = if ($null -ne $packResult) { $packResult.unpackedSize } else { $null }
    entryCount = if ($null -ne $packResult) { $packResult.entryCount } else { $null }
    sha1 = if ($null -ne $packResult) { [string]$packResult.shasum } else { "" }
    sha512 = if ($null -ne $packResult) { [string]$packResult.integrity } else { "" }
    sha256 = $artifactSha256
  }
  tests = [ordered]@{
    skipped = [bool]$SkipTests
    ran = $testsRan
  }
  manifestPath = if ($DryRun) { "" } else { $manifestPath }
  errors = $errors
}

if (-not $DryRun -and $PSCmdlet.ShouldProcess($manifestPath, "write local release manifest")) {
  $manifest | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}

if ($Json) {
  $manifest | ConvertTo-Json -Depth 40
} else {
  if ($DryRun) {
    Write-Host "Local release dry run complete: $packageName@$packageVersion"
  } else {
    Write-Host "Local release artifact: $artifactPath"
    Write-Host "Manifest: $manifestPath"
    if (-not [string]::IsNullOrWhiteSpace($artifactSha256)) {
      Write-Host "SHA256: $artifactSha256"
    }
  }
}
exit 0
