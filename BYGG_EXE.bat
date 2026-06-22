@echo off
chcp 65001 >nul
title Lager — Bygg .exe
echo.
echo  ========================================
echo     Bygger Lager.exe...
echo  ========================================
echo.
cd /d "%~dp0"

call npm run build
if errorlevel 1 ( echo  FEL: Byggfel! & pause & exit /b 1 )

npx electron-packager . Lager --platform=win32 --arch=x64 --out=dist-app --overwrite --app-version=1.0.0 --ignore=dist-app --ignore=node_modules/.cache --ignore=.git --ignore=lager.db

echo.
echo  ========================================
echo     Klar!
echo     Filen finns i: dist-app\Lager-win32-x64\
echo     Dubbelklicka Lager.exe for att starta.
echo  ========================================
echo.
pause
