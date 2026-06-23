@echo off
chcp 65001 >nul
title Lager Bygg Installer
cd /d "%~dp0"
npm install electron-builder --save-dev
call npm run build
if errorlevel 1 ( echo  FEL & pause & exit /b 1 )
call npx electron-builder --win --x64
if errorlevel 1 ( echo  FEL & pause & exit /b 1 )
echo.
echo  Klar! dist-app\Lager Setup 1.0.0.exe
echo.
pause
