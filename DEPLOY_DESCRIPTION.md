# Deploy Description (Windows Server + IIS)

Tai lieu nay luu quy trinh deploy/redeploy de su dung lai cho cac lan cap nhat sau.

## 1) Muc tieu

- App Node.js chay o localhost:5100
- Windows Service: OrderApp (tu khoi dong cung he thong)
- IIS lam reverse proxy cho domain
- Co checklist test sau deploy

## 2) Gia dinh duong dan

- Source tren server: D:\DIEP-NH\Copilot\apps\Order
- Node exe: C:\Program Files\nodejs\node.exe
- Service name: OrderApp
- Nguon code: branch main

Neu ban doi duong dan, cap nhat lai lenh ben duoi.

## 3) First deploy (lan dau)

### 3.1 Clone code

PowerShell (Run as Administrator):

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

if (Test-Path "D:\DIEP-NH\Copilot\apps\Order") {
  Rename-Item "D:\DIEP-NH\Copilot\apps\Order" ("D:\DIEP-NH\Copilot\apps\Order_backup_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
}

git clone --branch main https://github.com/nguyenhuudiep/order.git "D:\DIEP-NH\Copilot\apps\Order"

### 3.2 Cai dependency

Set-Location "D:\DIEP-NH\Copilot\apps\Order"

if (Test-Path ".\package-lock.json") {
  npm ci --omit=dev
} else {
  npm install --omit=dev
}

### 3.3 Tao .env

Neu chua co file .env:

Copy-Item ".env.example" ".env"

Sau do sua .env voi gia tri production.

### 3.4 Tao service OrderApp

$app = "D:\DIEP-NH\Copilot\apps\Order"
$runner = Join-Path $app "start-orderapp.ps1"

$runnerContent = @'
$ErrorActionPreference = "Stop"
Set-Location "D:\DIEP-NH\Copilot\apps\Order"
${env:NODE_ENV} = "production"
${env:ENV_FILE} = "D:\DIEP-NH\Copilot\apps\Order\.env.production"
& "C:\Program Files\nodejs\node.exe" "server.js"
'@

Set-Content -Path $runner -Value $runnerContent -Encoding UTF8

if (Get-Service -Name "OrderApp" -ErrorAction SilentlyContinue) {
  Stop-Service -Name "OrderApp" -Force -ErrorAction SilentlyContinue
  sc.exe delete OrderApp | Out-Null
  Start-Sleep -Seconds 2
}

$bin = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`""
New-Service -Name "OrderApp" -BinaryPathName $bin -DisplayName "Order App" -StartupType Automatic
sc.exe failure OrderApp reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
Start-Service OrderApp
Get-Service OrderApp

## 4) Redeploy (lan cap nhat sau)

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Set-Location "D:\DIEP-NH\Copilot\apps\Order"

git fetch origin main
git checkout main
git pull --ff-only origin main

if (Test-Path ".\package-lock.json") {
  npm ci --omit=dev
} else {
  npm install --omit=dev
}

Restart-Service OrderApp
Get-Service OrderApp

## 5) Cau hinh IIS reverse proxy

### 5.1 Cai feature IIS/WAS (neu chua co)

Install-WindowsFeature Web-Server,Web-WebServer,Web-Common-Http,Web-Static-Content,Web-Default-Doc,Web-Http-Errors,WAS,WAS-Process-Model,WAS-Config-APIs,Web-Mgmt-Tools -IncludeManagementTools

### 5.2 Dam bao service IIS dang chay

Set-Service -Name WAS -StartupType Automatic
Set-Service -Name W3SVC -StartupType Automatic
Start-Service WAS
Start-Service W3SVC
iisreset

### 5.3 Web.config

File web.config da duoc dat trong root project. Dam bao IIS site tro dung vao thu muc app.

### 5.4 Bat ARR proxy

& "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /commit:apphost

iisreset

### 5.5 Mo firewall

netsh advfirewall firewall add rule name="IIS HTTP 80" dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="IIS HTTPS 443" dir=in action=allow protocol=TCP localport=443

## 6) Smoke test sau deploy

- Local node: http://localhost:5100/admin/login
- Domain qua IIS: http://<domain>/admin/login
- Dang nhap duoc
- Tao don duoc
- Doi trang thai don duoc
- Bam da thanh toan -> doanh thu cap nhat
- Realtime van hoat dong

## 7) Xu ly loi nhanh

### 7.1 Service OrderApp khong ton tai

Get-Service OrderApp

Neu bao khong ton tai -> tao lai theo muc 3.4.

### 7.2 Service ton tai nhung khong start

- Kiem tra app chay tay:

Set-Location "D:\DIEP-NH\Copilot\apps\Order"
${env:NODE_ENV} = "production"
${env:ENV_FILE} = "D:\DIEP-NH\Copilot\apps\Order\.env.production"
& "C:\Program Files\nodejs\node.exe" server.js

- Neu chay tay OK: kiem tra port 5100 bi chiem, dung process trung.

### 7.3 Domain khong vao

- Kiem tra DNS domain da tro dung IP server
- Kiem tra IIS binding dung host
- Kiem tra ARR proxy da enable
- Kiem tra Node local 5100 con chay

## 8) Checklist thay doi code lan sau

Moi lan thay doi code:

1. Pull code main
2. npm ci --omit=dev
3. Restart-Service OrderApp
4. iisreset (neu co thay doi IIS/web.config)
5. Test 6 buoc trong muc Smoke test

## 9) Ghi chu bao mat

- Dat SESSION_SECRET manh trong .env
- Khong dung tai khoan sa cho production neu co the
- Gioi han quyen truy cap SQL account theo principle of least privilege
- Luu tru backup DB truoc cac thay doi lon


powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-safe-order.ps1" -AppPath "D:\DIEP-NH\Copilot\apps\Order" -Branch "main" -ProcessName "order" -Port 5100 -EnvFile "D:\DIEP-NH\Copilot\apps\Order\.env.production"
