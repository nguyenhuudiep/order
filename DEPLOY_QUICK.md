# Deploy Quick (Windows)

## 1) Deploy lan dau

PowerShell (Run as Administrator):

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$repo = "https://github.com/nguyenhuudiep/order.git"
$app = "D:\DIEP-NH\Copilot\apps\Order"
if (Test-Path $app) { Rename-Item $app ($app + "_backup_" + (Get-Date -Format "yyyyMMdd_HHmmss")) }
git clone --branch main $repo $app
Set-Location $app
if (Test-Path ".\package-lock.json") { npm ci --omit=dev } else { npm install --omit=dev }

## 2) Redeploy (moi lan cap nhat)

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Set-Location "D:\DIEP-NH\Copilot\apps\Order"
git fetch origin main
git checkout main
git pull --ff-only origin main
if (Test-Path ".\package-lock.json") { npm ci --omit=dev } else { npm install --omit=dev }
if (Get-Service -Name "OrderApp" -ErrorAction SilentlyContinue) { Restart-Service OrderApp }

## 3) Kiem tra nhanh

http://localhost:5100/admin/login
http://<domain>/admin/login
