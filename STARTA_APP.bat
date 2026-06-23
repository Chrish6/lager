@echo off
cd /d "%~dp0"
start "Lager Server" node server.cjs
timeout /t 2 /nobreak >nul
npx electron electron-main.js
