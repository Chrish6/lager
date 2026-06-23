@echo off
chcp 65001 >nul
title Lager Installation
echo.
echo  ========================================
echo     Lager - Installation
echo  ========================================
echo.
cd /d "%~dp0"
echo  Kontrollerar Node.js version...
node --version 2>nul | findstr "v20" >nul
if errorlevel 1 (
    echo  Installerar Node.js 20 LTS...
    winget install OpenJS.NodeJS.LTS --version 20.19.2 --silent
    if errorlevel 1 (
        echo  FEL: Kör terminalen som administratör
        pause
        exit /b 1
    )
    echo  Startar om...
    start "" "%~f0"
    exit
)
echo  Node.js OK
echo.
echo  [1/2] Installerar paket...
call npm install
if errorlevel 1 ( echo  FEL & pause & exit /b 1 )
echo.
echo  [2/2] Bygger appen...
call npm run build
if errorlevel 1 ( echo  FEL & pause & exit /b 1 )
echo.
echo  ========================================
echo     Klar! Starta med STARTA.bat
echo  ========================================
echo.
pause
