@echo off
chcp 65001 >nul
title Lager Uppdatering
echo.
echo  ========================================
echo     Uppdaterar Lager...
echo  ========================================
echo.
cd /d "%~dp0"
echo  Hamtar fran GitHub...
git pull
if errorlevel 1 ( echo  FEL: git pull misslyckades & pause & exit /b 1 )
echo.
echo  Bygger om appen...
call npm run build
if errorlevel 1 ( echo  FEL: Byggfel & pause & exit /b 1 )
echo.
echo  Startar om servern...
sc stop "Lager Server" >nul 2>&1
sc start "Lager Server" >nul 2>&1
echo.
echo  ========================================
echo     Klar!
echo  ========================================
echo.
pause
