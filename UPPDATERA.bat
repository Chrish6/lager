@echo off
chcp 65001 >nul
title Lager — Uppdatering
echo.
echo  ========================================
echo     Uppdaterar Lager...
echo  ========================================
echo.
cd /d "%~dp0"

echo  Bygger ny version av appen...
call npm run build
if errorlevel 1 ( echo  FEL: Byggfel! & pause & exit /b 1 )

echo  Startar om server-tjansten...
sc stop "Lager Server" >nul 2>&1
sc start "Lager Server" >nul 2>&1
if errorlevel 1 (
  echo  Tjanst hittades inte, provar pm2...
  pm2 restart lager >nul 2>&1
)

echo.
echo  ========================================
echo     Uppdatering klar!
echo  ========================================
echo.
pause
