# Deploy/Redeploy Script (Windows Server)

File: scripts/deploy-redeploy.ps1

## PM2 deploy 1 lenh (khuyen dung)

PowerShell (tren server production):

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\deploy-pm2.ps1 -AppPath "D:\DIEP-NH\Copilot\apps\Order" -Branch main -ProcessName "order" -Port 5100 -NodeEnv "production" -EnvFile "D:\DIEP-NH\Copilot\apps\Order\.env.production"
```

Script tu dong:
- Pull code
- Cai dependencies
- Verify module dotenv
- Restart/start PM2 process `order`
- Health check `http://localhost:5100/admin/login`
- `pm2 save`

## PM2 deploy an toan (tranh anh huong app PM2 khac)

PowerShell (tren server production):

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\deploy-safe-order.ps1 -AppPath "D:\DIEP-NH\Copilot\apps\Order" -Branch main -ProcessName "order" -Port 5100 -EnvFile "D:\DIEP-NH\Copilot\apps\Order\.env.production"
```

Script nay se:
- Chi dung/restart process `order` (khong dung app PM2 khac)
- Tu backup `web.config` local neu bi xung dot khi pull
- Chi cai lai dependencies khi `package.json` hoac `package-lock.json` thay doi
- Thu go lock file node cua rieng app Order neu gap EPERM khi npm ci
- Health check truoc khi ket thuc

## 1) Deploy lan dau (clone + install + tao service + restart)

PowerShell (Run as Administrator):

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.
\scripts\deploy-redeploy.ps1 -Mode deploy -RepoUrl "https://github.com/<owner>/<repo>.git" -Branch main -AppPath "D:\Apps\Order" -InstallService -ServiceName "OrderApp" -NssmPath "D:\Tools\nssm\win64\nssm.exe" -NodeExePath "C:\Program Files\nodejs\node.exe" -NodeEnv "production" -EnvFile "D:\Apps\Order\.env.production"
```

## 2) Redeploy (pull code + npm ci + restart service)

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.
\scripts\deploy-redeploy.ps1 -Mode redeploy -Branch main -AppPath "D:\Apps\Order" -ServiceName "OrderApp"
```

## 3) Redeploy nhung khong restart service

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.
\scripts\deploy-redeploy.ps1 -Mode redeploy -Branch main -AppPath "D:\Apps\Order" -SkipServiceRestart
```

## Ghi chu

- Script se tao file .env tu .env.example neu .env chua ton tai.
- Script uu tien npm ci --omit=dev neu co package-lock.json.
- Script kiem tra HTTP tai duong dan /admin/login (mac dinh port 5100).
- Neu service chua ton tai, dung them tham so -InstallService.
- Khi tao service, nen set `-NodeEnv "production"` va `-EnvFile "...\\.env.production"` de app nap dung cau hinh production.
