@echo off
title KeepKey Vault DEV LOGS
echo === KeepKey Vault Dev Logs ===
echo.
cd /d "C:\Users\bithi\AppData\Local\Programs\KeepKeyVault"
echo Starting bun directly with main.js...
echo.
"bin\bun.exe" "Resources\main.js" 2>&1
echo.
echo === Process exited ===
pause
