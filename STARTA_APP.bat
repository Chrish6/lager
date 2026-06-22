@echo off
chcp 65001 >nul
title Lager
cd /d "%~dp0"
start "" npx electron electron-main.js
