@echo off
chcp 65001 >nul
title Lager — Installation
echo.
echo  ========================================
echo     Lager — Forsta gangs-installation
echo  ========================================
echo.

cd /d "%~dp0"

echo  Kontrollerar Node.js...
node --version >nul 2>&1
if errorlevel 1 (
  echo  FEL: Node.js hittades inte!
  echo  Installera fran: https://nodejs.org
  pause & exit /b 1
)

echo  [1/3] Installerar npm-paket...
call npm install
if errorlevel 1 ( echo  FEL: npm install misslyckades! & pause & exit /b 1 )

echo  [2/3] Installerar Electron...
call npm install electron electron-packager --save-dev
if errorlevel 1 ( echo  FEL: Electron install misslyckades! & pause & exit /b 1 )

echo  [3/3] Bygger appen...
call npm run build
if errorlevel 1 ( echo  FEL: Byggfel! & pause & exit /b 1 )

echo.
echo  ========================================
echo     Klar!
echo.
echo     Webbläsare:  dubbelklicka STARTA.bat
echo     Desktop-app: dubbelklicka STARTA_APP.bat
echo     Bygg .exe:   dubbelklicka BYGG_EXE.bat
echo  ========================================
echo.
pause
