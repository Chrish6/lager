@echo off
cd /d "%~dp0"
echo.
echo  ========================================
echo     Bygger och publicerar Lager...
echo  ========================================
echo.
echo  OBS: Du behoever ett GitHub token.
echo  Skapa pa: github.com/settings/tokens
echo  Markera: repo
echo.
set /p GH_TOKEN=Klistra in ditt GitHub token: 
echo.
echo  [1/2] Bygger appen...
call npm run build
if errorlevel 1 ( echo FEL: Byggfel & pause & exit /b 1 )
echo.
echo  [2/2] Bygger installer och laddar upp till GitHub...
set GH_TOKEN=%GH_TOKEN%
call npx electron-builder --win --x64 --publish always
if errorlevel 1 ( echo FEL & pause & exit /b 1 )
echo.
echo  ========================================
echo     Klar! Installer uppladdad till:
echo     github.com/Chrish6/lager/releases
echo.
echo     Alla appar uppdateras automatiskt
echo     naesta gang de oppnas!
echo  ========================================
echo.
pause
