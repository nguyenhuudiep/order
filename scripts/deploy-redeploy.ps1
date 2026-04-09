[CmdletBinding()]
param(
  [ValidateSet('deploy', 'redeploy')]
  [string]$Mode = 'redeploy',

  [string]$RepoUrl = '',

  [string]$Branch = 'main',

  [string]$AppPath = 'D:\Apps\Order',

  [string]$ServiceName = 'OrderApp',

  [int]$Port = 5100,

  [switch]$SkipServiceRestart,

  [switch]$InstallService,

  [string]$NssmPath = 'D:\Tools\nssm\win64\nssm.exe',

  [string]$NodeExePath = 'C:\Program Files\nodejs\node.exe',

  [string]$NodeEnv = 'production',

  [string]$EnvFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host "[STEP] $Message" -ForegroundColor Cyan
}

function Write-Info {
  param([string]$Message)
  Write-Host "[INFO] $Message" -ForegroundColor Gray
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Test-RequiredCommand {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Test-RequiredPath {
  param([string]$PathToCheck, [string]$Label)
  if (-not (Test-Path -Path $PathToCheck)) {
    throw "$Label not found: $PathToCheck"
  }
}

function Get-ServiceOrNull {
  param([string]$Name)
  try {
    return Get-Service -Name $Name -ErrorAction Stop
  } catch {
    return $null
  }
}

function Invoke-GitSync {
  param([string]$WorkingPath, [string]$TargetBranch)

  Test-RequiredPath -PathToCheck (Join-Path $WorkingPath '.git') -Label '.git folder'

  Write-Step "Sync source code from branch '$TargetBranch'"
  git -C $WorkingPath fetch origin $TargetBranch
  git -C $WorkingPath checkout $TargetBranch
  git -C $WorkingPath pull --ff-only origin $TargetBranch
}

function Install-Dependencies {
  param([string]$WorkingPath)

  Write-Step 'Install Node.js dependencies'
  Push-Location $WorkingPath
  try {
    if (Test-Path (Join-Path $WorkingPath 'package-lock.json')) {
      npm ci --omit=dev
    } else {
      npm install --omit=dev
    }
  } finally {
    Pop-Location
  }
}

function Initialize-EnvFile {
  param([string]$WorkingPath)

  $envFile = Join-Path $WorkingPath '.env'
  $envExample = Join-Path $WorkingPath '.env.example'

  if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
      Copy-Item $envExample $envFile
      Write-Warn '.env was missing, copied from .env.example. Please update secrets before production use.'
    } else {
      Write-Warn '.env and .env.example are both missing. App may fail to start.'
    }
  }
}

function Initialize-LogsFolder {
  param([string]$WorkingPath)

  $logs = Join-Path $WorkingPath 'logs'
  if (-not (Test-Path $logs)) {
    New-Item -Path $logs -ItemType Directory | Out-Null
  }
}

function Install-Or-UpdateService {
  param(
    [string]$Name,
    [string]$WorkingPath,
    [string]$NssmExe,
    [string]$NodePath,
    [string]$RuntimeNodeEnv,
    [string]$RuntimeEnvFile
  )

  Test-RequiredPath -PathToCheck $NssmExe -Label 'nssm.exe'
  Test-RequiredPath -PathToCheck $NodePath -Label 'node.exe'

  $service = Get-ServiceOrNull -Name $Name
  if ($null -eq $service) {
    Write-Step "Install Windows service '$Name'"
    & $NssmExe install $Name $NodePath 'server.js'
  } else {
    Write-Step "Update Windows service '$Name'"
  }

  & $NssmExe set $Name AppDirectory $WorkingPath
  & $NssmExe set $Name AppStdout (Join-Path $WorkingPath 'logs\out.log')
  & $NssmExe set $Name AppStderr (Join-Path $WorkingPath 'logs\err.log')
  $environmentPairs = @("NODE_ENV=$RuntimeNodeEnv")
  if (-not [string]::IsNullOrWhiteSpace($RuntimeEnvFile)) {
    $environmentPairs += "ENV_FILE=$RuntimeEnvFile"
  }
  & $NssmExe set $Name AppEnvironmentExtra ($environmentPairs -join "`n")
  & $NssmExe set $Name Start SERVICE_AUTO_START
}

function Restart-AppService {
  param([string]$Name)

  $service = Get-ServiceOrNull -Name $Name
  if ($null -eq $service) {
    Write-Warn "Service '$Name' not found. App will not auto-run until service is installed."
    return
  }

  Write-Step "Restart service '$Name'"
  if ($service.Status -eq 'Running') {
    Restart-Service -Name $Name -Force
  } else {
    Start-Service -Name $Name
  }
}

function Test-AppHealth {
  param([int]$AppPort)

  Write-Step "Check local HTTP response on port $AppPort"
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:$AppPort/admin/login" -UseBasicParsing -TimeoutSec 10
    Write-Info "HTTP status: $($response.StatusCode)"
  } catch {
    Write-Warn "Health check failed: $($_.Exception.Message)"
  }
}

Write-Step 'Validate required tools'
Test-RequiredCommand -Name 'git'
Test-RequiredCommand -Name 'npm'

if ($Mode -eq 'deploy') {
  if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    throw 'RepoUrl is required when Mode=deploy.'
  }

  if (Test-Path $AppPath) {
    Write-Warn "AppPath already exists: $AppPath"
    Write-Warn 'Continuing with redeploy flow on existing folder.'
  } else {
    Write-Step "Clone repository to $AppPath"
    git clone --branch $Branch $RepoUrl $AppPath
  }
}

Test-RequiredPath -PathToCheck $AppPath -Label 'AppPath'
Invoke-GitSync -WorkingPath $AppPath -TargetBranch $Branch
Initialize-EnvFile -WorkingPath $AppPath
Initialize-LogsFolder -WorkingPath $AppPath
Install-Dependencies -WorkingPath $AppPath

if ($InstallService) {
  Install-Or-UpdateService -Name $ServiceName -WorkingPath $AppPath -NssmExe $NssmPath -NodePath $NodeExePath -RuntimeNodeEnv $NodeEnv -RuntimeEnvFile $EnvFile
}

if (-not $SkipServiceRestart) {
  Restart-AppService -Name $ServiceName
} else {
  Write-Info 'SkipServiceRestart enabled. Service restart was skipped.'
}

Test-AppHealth -AppPort $Port

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "Mode: $Mode"
Write-Host "AppPath: $AppPath"
Write-Host "Branch: $Branch"
Write-Host "Service: $ServiceName"
