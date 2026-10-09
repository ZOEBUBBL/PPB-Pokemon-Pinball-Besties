@echo off
title Pinball Pals server
cd /d "%~dp0server"
if not exist node_modules call npm install
echo.
echo Pinball Pals server - keep this window open while streaming. Close it to stop.
echo Admin:   http://localhost:8080/admin/
echo Overlay: see the links printed below.
echo.
call npm start
pause
