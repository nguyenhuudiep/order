[CmdletBinding()]
param(
  [string]$AppPath = "D:\DIEP-NH\Copilot\apps\Order",
  [string]$Branch = "main",
  [string]$ProcessName = "order",
  [string]$EnvFile = "D:\DIEP-NH\Copilot\apps\Order\.env.production",
  [int]$Port = 5100
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

function Assert-LastExitCode {
  param([string]$CommandName)
  if ($LASTEXITCODE -ne 0) {
    throw "$CommandName failed with exit code $LASTEXITCODE"
  }
}

function Get-TrackedChangedFiles {
  $statusLines = git status --porcelain
  Assert-LastExitCode -CommandName "git status --porcelain"

  $trackedLines = $statusLines | Where-Object { $_ -and ($_ -notmatch '^\?\?\s') }
  if (-not $trackedLines) {
    return @()
  }

  return $trackedLines | ForEach-Object {
    if ($_.Length -ge 4) {
      $_.Substring(3).Trim()
    }
  } | Where-Object { $_ } | Select-Object -Unique
}

function Prepare-WorkingTreeForPull {
  $trackedChanges = @(Get-TrackedChangedFiles)
  if ($trackedChanges.Count -eq 0) {
    return
  }

  $safeRestoreTargets = @('package-lock.json')
  $restorableOnly = $trackedChanges | Where-Object { $_ -in $safeRestoreTargets }

  if ($restorableOnly.Count -gt 0 -and $restorableOnly.Count -eq $trackedChanges.Count) {
    Write-Host "[WARN] Local tracked change detected in package-lock.json. Auto-restore before pull."
    git restore --source=HEAD --worktree -- package-lock.json
    Assert-LastExitCode -CommandName "git restore package-lock.json"
    return
  }

  $stashName = "deploy-safe-auto-stash-$(Get-Date -Format 'yyyyMMdd_HHmmss')"
  Write-Host "[WARN] Local tracked changes detected. Auto-stash before pull: $stashName"
  git stash push -m $stashName
  Assert-LastExitCode -CommandName "git stash push"
}

function Install-Dependencies {
  if (Test-Path ".\package-lock.json") {
    npm ci --omit=dev
    Assert-LastExitCode -CommandName "npm ci --omit=dev"
  } else {
    npm install --omit=dev
    Assert-LastExitCode -CommandName "npm install --omit=dev"
  }
}

function Stop-OrderNodeProcesses {
  param([string]$PathHint)

  $escapedPathHint = [Regex]::Escape($PathHint)
  $orderNodeProcesses = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match $escapedPathHint }

  foreach ($process in $orderNodeProcesses) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host "[INFO] Stopped node process $($process.ProcessId) for Order app"
    } catch {
      Write-Host "[WARN] Could not stop node process $($process.ProcessId): $($_.Exception.Message)"
    }
  }
}

Write-Step "Validate required commands"
Test-RequiredCommand -Name "git"
Test-RequiredCommand -Name "npm"
Test-RequiredCommand -Name "node"
Test-RequiredCommand -Name "pm2"

if (-not (Test-Path $AppPath)) {
  throw "AppPath not found: $AppPath"
}

Set-Location $AppPath

Write-Step "Fetch source from origin/$Branch"
git fetch origin $Branch
Assert-LastExitCode -CommandName "git fetch"

Write-Step "Handle local untracked web.config if present"
$untrackedFiles = git ls-files --others --exclude-standard
if ($untrackedFiles -contains "web.config") {
  $backupName = "web.config.local.bak.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
  Move-Item -Path ".\web.config" -Destination ".\$backupName" -Force
  Write-Host "[INFO] Backed up local web.config to $backupName"
}

Write-Step "Prepare git working tree for safe pull"
Prepare-WorkingTreeForPull

Write-Step "Pull latest code"
git checkout $Branch
Assert-LastExitCode -CommandName "git checkout"
git pull --ff-only origin $Branch
Assert-LastExitCode -CommandName "git pull --ff-only"

Write-Step "Check if dependency install is needed"
$installDeps = $true
try {
  $changedFiles = git diff --name-only HEAD@{1} HEAD
  if (-not ($changedFiles -match "package-lock.json|package.json")) {
    $installDeps = $false
  }
} catch {
  $installDeps = $true
}

if ($installDeps) {
  Write-Step "Stop only PM2 process '$ProcessName' before dependency update"
  pm2 stop $ProcessName 2>$null | Out-Null

  Write-Step "Install dependencies"
  try {
    Install-Dependencies
  } catch {
    Write-Host "[WARN] Dependency install failed. Attempting targeted unlock for Order node processes..."
    Stop-OrderNodeProcesses -PathHint $AppPath
    Install-Dependencies
  }

  Write-Step "Verify critical dependency resolution"
  node -e "require.resolve('dotenv')"
  Assert-LastExitCode -CommandName "node require.resolve('dotenv')"
} else {
  Write-Host "[INFO] package.json/package-lock.json unchanged. Skip dependency reinstall."
}

Write-Step "Restart PM2 process '$ProcessName' with production env"
$env:NODE_ENV = "production"
$env:ENV_FILE = $EnvFile

$exists = $false
try {
  $exists = [bool](pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq $ProcessName })
} catch {
  $exists = $false
}

if ($exists) {
  pm2 restart $ProcessName --update-env
} else {
  pm2 start "server.js" --name $ProcessName --cwd $AppPath --update-env
}
Assert-LastExitCode -CommandName "pm2 restart/start"

pm2 save | Out-Null
Assert-LastExitCode -CommandName "pm2 save"

Write-Step "Health check"
$response = Invoke-WebRequest -Uri "http://localhost:$Port/admin/login" -UseBasicParsing -TimeoutSec 20
Write-Host "[INFO] Health check: $($response.StatusCode) $($response.StatusDescription)" -ForegroundColor Green

pm2 list
Write-Host ""
Write-Host "Deploy-safe completed successfully." -ForegroundColor Green
