@echo off
rem ===================================================================
rem  Teen Patti Arena — Windows launcher
rem  Double-click this file to start the multiplayer server and open
rem  the game in your browser. Keep the server window open while you play.
rem ===================================================================
setlocal
cd /d "%~dp0"
title Teen Patti Arena

where node >nul 2>nul
if errorlevel 1 goto :offline

echo.
echo   Teen Patti Arena
echo   ----------------
echo   Starting the game server... a browser window will open at
echo   http://localhost:4000
echo.
echo   Keep this window open while you play. Press Ctrl+C to stop.
echo.

start "Teen Patti Arena server" /min cmd /c "node server\index.js"
rem give the server a moment to bind the port (2 seconds, no console spam)
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:4000"
exit /b 0

:offline
echo.
echo   Node.js was not found on this PC, so the offline single-file
echo   version will open instead - practice vs AI works fully there.
echo   (Install Node.js from https://nodejs.org to unlock live tables.)
echo.
start "" "%~dp0PLAY-ME-first.html"
exit /b 0
