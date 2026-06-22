@echo off
chcp 65001 >nul
title Lager Server
cd /d "%~dp0"
echo  Startar Lager server pa http://localhost:3000 ...
echo  Stang detta fonster for att stoppa servern.
echo.
node server.cjs
pause
