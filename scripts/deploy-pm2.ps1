[CmdletBinding()]
param(
  [string]$AppPath = 'D:\DIEP-NH\Copilot\apps\Order',
  [string]$Branch = 'main',
  [string]$ProcessName = 'order',
  [int]$Port = 5100,
  [string]$NodeEnv = 'production',
  [string]$EnvFile = 'D:\DIEP-NH\Copilot\apps\Order\.env.production'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host "[STEP] $Message" -ForegroundColor Cyan
}

function Test-RequiredCommand {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Install-Dependencies {
  if (Test-Path '.\package-lock.json') {
    npm ci --omit=dev
  } else {
    npm install --omit=dev
  }
}

Write-Step 'Validate required commands'
Test-RequiredCommand -Name 'git'
Test-RequiredCommand -Name 'npm'
Test-RequiredCommand -Name 'node'
Test-RequiredCommand -Name 'pm2'

if (-not (Test-Path $AppPath)) {
  throw "AppPath not found: $AppPath"
}

Set-Location $AppPath

Write-Step "Update source code ($Branch)"
git fetch origin $Branch
git checkout $Branch
git pull --ff-only origin $Branch

Write-Step 'Install dependencies'
Install-Dependencies

Write-Step 'Verify dotenv is installed'
node -e "require.resolve('dotenv'); console.log('dotenv-ok')"

Write-Step 'Start or restart PM2 process'
$env:NODE_ENV = $NodeEnv
$env:ENV_FILE = $EnvFile

$processExists = $false
try {
  $processExists = [bool](pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq $ProcessName })
} catch {
  $processExists = $false
}

if ($processExists) {
  pm2 restart $ProcessName --update-env
} else {
  pm2 start 'server.js' --name $ProcessName --cwd $AppPath --update-env
}

Write-Step 'Health check'
$health = Invoke-WebRequest -Uri "http://localhost:$Port/admin/login" -UseBasicParsing -TimeoutSec 15
Write-Host ("[INFO] Health check: {0} {1}" -f $health.StatusCode, $health.StatusDescription) -ForegroundColor Green

Write-Step 'Persist PM2 process list'
pm2 save
pm2 list

Write-Host ''
Write-Host 'Deploy PM2 completed successfully.' -ForegroundColor Green
