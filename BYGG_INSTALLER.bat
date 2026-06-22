@echo off
chcp 65001 >nul
title Lager — Bygg installer
echo.
echo  ========================================
echo     Bygger Lager-installer (.exe)
echo  ========================================
echo.
cd /d "%~dp0"

echo  [1/3] Installerar electron-builder...
call npm install electron-builder --save-dev
if errorlevel 1 ( echo FEL! & pause & exit /b 1 )

echo  [2/3] Bygger React-appen...
call npm run build
if errorlevel 1 ( echo FEL! & pause & exit /b 1 )

echo  [3/3] Paketerar som Windows-installer...
call npx electron-builder --win --x64
if errorlevel 1 ( echo FEL! & pause & exit /b 1 )

echo.
echo  ========================================
echo     Klar!
echo.
echo     Installationsfilen finns i:
echo     dist-app\Lager Setup 1.0.0.exe
echo.
echo     Dubbelklicka den filen pa vilken
echo     Windows-dator som helst for att
echo     installera Lager!
echo  ========================================
echo.
pause
