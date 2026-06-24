@echo off
cd /d "%~dp0"
echo.
echo  ========================================
echo     Lager - Installation
echo  ========================================
echo.

echo  [1/3] Installerar Bonjour (lager.local)...
where dns-sd >nul 2>&1
if errorlevel 1 (
    winget install --id Apple.Bonjour --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo  OBS: Bonjour kunde inte installeras automatiskt.
        echo  Ladda ned manuellt: support.apple.com/kb/DL999
        echo  Eller installera iTunes sa installeras Bonjour automatiskt.
    ) else (
        echo  Bonjour installerat!
    )
) else (
    echo  Bonjour redan installerat.
)

echo.
echo  [2/3] Installerar npm-paket...
call npm install
if errorlevel 1 ( echo  FEL: npm install misslyckades & pause & exit /b 1 )

echo.
echo  [3/3] Bygger appen...
call npm run build
if errorlevel 1 ( echo  FEL: Byggfel & pause & exit /b 1 )

echo.
echo  ========================================
echo     Klar! Starta med STARTA.bat
echo     Appen nar pa: http://lager.local:3000
echo  ========================================
echo.
pause
