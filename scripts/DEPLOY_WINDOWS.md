# Deploy/Redeploy Script (Windows Server)

File: scripts/deploy-redeploy.ps1

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
