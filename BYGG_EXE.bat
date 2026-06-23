@echo off
chcp 65001 >nul
title Lager Bygg EXE
cd /d "%~dp0"
call npm run build
if errorlevel 1 ( echo  FEL & pause & exit /b 1 )
npx electron-packager . Lager --platform=win32 --arch=x64 --out=dist-app --overwrite --app-version=1.0.0 --ignore=dist-app --ignore=.git
echo.
echo  Klar! Filen finns i: dist-app\Lager-win32-x64\
echo.
pause
