function Get-ClaudeBuddyRepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-ClaudeBuddyDefaultConfigPath {
  param([string]$RepoRoot)
  return Join-Path $RepoRoot "examples\claudebuddy.http-ble.example.config.json"
}

function Get-ClaudeBuddyDefaultPidFile {
  param([string]$RepoRoot)
  return Join-Path $RepoRoot "logs\claudebuddy-daemon.pid"
}

function Resolve-ClaudeBuddyPath {
  param(
    [string]$PathValue,
    [string]$BasePath
  )
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ""
  }
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $PathValue))
}

function Get-ClaudeBuddyConfigPath {
  param(
    [string]$Config,
    [string]$RepoRoot
  )
  $defaultConfig = Get-ClaudeBuddyDefaultConfigPath -RepoRoot $RepoRoot
  $selected = if ([string]::IsNullOrWhiteSpace($Config)) { $defaultConfig } else { $Config }
  return Resolve-ClaudeBuddyPath -PathValue $selected -BasePath $RepoRoot
}

function Get-ClaudeBuddyPidFilePath {
  param(
    [string]$PidFile,
    [string]$RepoRoot
  )
  $defaultPidFile = Get-ClaudeBuddyDefaultPidFile -RepoRoot $RepoRoot
  $selected = if ([string]::IsNullOrWhiteSpace($PidFile)) { $defaultPidFile } else { $PidFile }
  return Resolve-ClaudeBuddyPath -PathValue $selected -BasePath $RepoRoot
}

function Read-ClaudeBuddyConfig {
  param([string]$ConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
  }
  return Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

function Get-ClaudeBuddyProperty {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Fallback = $null
  )
  if ($null -eq $Object) {
    return $Fallback
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Fallback
  }
  return $property.Value
}

function Get-ClaudeBuddyConfigLogFile {
  param(
    [object]$Config,
    [string]$ConfigPath
  )
  $logFile = [string](Get-ClaudeBuddyProperty -Object $Config -Name "logFile" -Fallback "")
  if ([string]::IsNullOrWhiteSpace($logFile)) {
    return ""
  }
  return Resolve-ClaudeBuddyPath -PathValue $logFile -BasePath (Split-Path -Parent $ConfigPath)
}

function ConvertTo-ClaudeBuddyBoolean {
  param(
    [object]$Value,
    [bool]$Fallback = $false
  )
  if ($null -eq $Value) {
    return $Fallback
  }
  if ($Value -is [bool]) {
    return $Value
  }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) {
    return [double]$Value -ne 0
  }

  $text = ([string]$Value).Trim().ToLowerInvariant()
  switch ($text) {
    "1" { return $true }
    "true" { return $true }
    "yes" { return $true }
    "on" { return $true }
    "0" { return $false }
    "false" { return $false }
    "no" { return $false }
    "off" { return $false }
    default { return $Fallback }
  }
}

function Get-ClaudeBuddyControlBaseUri {
  param([object]$Config)
  $enabled = Get-ClaudeBuddyProperty -Object $Config -Name "controlServer" -Fallback $false
  if (-not (ConvertTo-ClaudeBuddyBoolean -Value $enabled -Fallback $false)) {
    return ""
  }
  $hostName = [string](Get-ClaudeBuddyProperty -Object $Config -Name "controlHost" -Fallback "127.0.0.1")
  $port = [int](Get-ClaudeBuddyProperty -Object $Config -Name "controlPort" -Fallback 27217)
  if ($hostName.Contains(":") -and -not $hostName.StartsWith("[")) {
    $hostName = "[$hostName]"
  }
  return "http://$hostName`:$port"
}

function Get-ClaudeBuddyControlHeaders {
  param([object]$Config)
  $token = [string](Get-ClaudeBuddyProperty -Object $Config -Name "controlToken" -Fallback "")
  if ([string]::IsNullOrWhiteSpace($token)) {
    return @{}
  }
  return @{ "Authorization" = "Bearer $token" }
}

function Invoke-ClaudeBuddyControl {
  param(
    [object]$Config,
    [string]$Path,
    [int]$TimeoutSec = 2
  )
  $baseUri = Get-ClaudeBuddyControlBaseUri -Config $Config
  if ([string]::IsNullOrWhiteSpace($baseUri)) {
    return $null
  }
  return Invoke-RestMethod -Method Get -Uri "$baseUri$Path" -Headers (Get-ClaudeBuddyControlHeaders -Config $Config) -TimeoutSec $TimeoutSec
}

function Get-ClaudeBuddyPid {
  param([string]$PidFile)
  if (-not (Test-Path -LiteralPath $PidFile)) {
    return $null
  }
  $content = Get-Content -LiteralPath $PidFile -Raw
  if ($null -eq $content) {
    return $null
  }
  $raw = $content.Trim()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue) -and $pidValue -gt 0) {
    return $pidValue
  }
  return $null
}

function Get-ClaudeBuddyProcess {
  param([Nullable[int]]$PidValue)
  if ($null -eq $PidValue -or $PidValue -le 0) {
    return $null
  }
  return Get-Process -Id $PidValue -ErrorAction SilentlyContinue
}

function Get-ClaudeBuddyProcessNameFromCommand {
  param(
    [string]$Command,
    [string]$Fallback
  )
  if ([string]::IsNullOrWhiteSpace($Command)) {
    return $Fallback
  }
  $leaf = Split-Path -Leaf $Command
  if ([string]::IsNullOrWhiteSpace($leaf)) {
    $leaf = $Command
  }
  $name = [System.IO.Path]::GetFileNameWithoutExtension($leaf)
  if ([string]::IsNullOrWhiteSpace($name)) {
    return $Fallback
  }
  return $name
}

function Test-ClaudeBuddyProcessName {
  param(
    [object]$Process,
    [string[]]$Names
  )
  if ($null -eq $Process) {
    return $false
  }
  foreach ($name in $Names) {
    if (-not [string]::IsNullOrWhiteSpace($name) -and $Process.ProcessName -ieq $name) {
      return $true
    }
  }
  return $false
}

function Remove-ClaudeBuddyPidFile {
  param([string]$PidFile)
  if (Test-Path -LiteralPath $PidFile) {
    try {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction Stop
    } catch {
      Set-Content -LiteralPath $PidFile -Value "" -NoNewline -Encoding ascii -ErrorAction SilentlyContinue
    }
  }
}

function Quote-ClaudeBuddyArgument {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value -or $Value.Length -eq 0) {
    return '""'
  }
  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashCount = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq '\') {
      $backslashCount += 1
      continue
    }
    if ($char -eq '"') {
      if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
        $backslashCount = 0
      }
      [void]$builder.Append('\"')
      continue
    }
    if ($backslashCount -gt 0) {
      [void]$builder.Append(('\' * $backslashCount))
      $backslashCount = 0
    }
    [void]$builder.Append($char)
  }
  if ($backslashCount -gt 0) {
    [void]$builder.Append(('\' * ($backslashCount * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Join-ClaudeBuddyArguments {
  param([string[]]$Arguments)
  return ($Arguments | ForEach-Object { Quote-ClaudeBuddyArgument -Value $_ }) -join " "
}
