@echo off
setlocal
title Wireless Canvas - Local Only
cd /d "%~dp0server"
if not exist "..\web\dist\deployment-edition.json" (
    echo Web build is missing. Run Build-LAN.bat first.
    pause
    exit /b 1
)
where bun.exe >nul 2>nul
if errorlevel 1 (
    echo Bun was not found in PATH.
    pause
    exit /b 1
)
set "LOCAL_STANDALONE=false"
set "OA_LOGIN_ENABLED=false"
set "STANDALONE_WEB_DIR=%~dp0web\dist"
set "DEMO_HOST=127.0.0.1"
set "DEMO_PORT=5188"
set "DEMO_STATE_PATH=%~dp0server\.data\local-demo.sqlite"
echo Starting the local trial on http://127.0.0.1:5188/canvas
echo Keep this window open while using the app. Press Ctrl+C to stop.
echo This launcher does not change .env or firewall rules.
echo Model requests use the existing provider configuration and may incur charges.
bun.exe src/demo-server.ts
set "LOCAL_EXIT_CODE=%ERRORLEVEL%"
echo.
echo Local service stopped with exit code %LOCAL_EXIT_CODE%.
pause
exit /b %LOCAL_EXIT_CODE%
