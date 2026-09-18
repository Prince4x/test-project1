@echo off
rem ===================================================================
rem  Teen Patti Arena - Windows launcher
rem
rem  Double-click this file to start the multiplayer server and open the
rem  game in your browser. Keep this window open while you play.
rem
rem  This script deliberately does not use PowerShell: it is blocked on
rem  some PCs by execution policy, it is slow to start, and its HTTP calls
rem  go through the system proxy and prefer IPv6 "localhost", which can
rem  make a working server look dead. It polls with Node instead.
rem ===================================================================
setlocal
cd /d "%~dp0"
title Teen Patti Arena

set PORT=4000
set LOG=server-log.txt

where node >nul 2>nul
if errorlevel 1 goto :offline

echo.
echo   Teen Patti Arena
echo   ----------------
echo   Starting the game server...
echo.

rem Lift the firewall for friends on the same Wi-Fi. Harmless when this
rem window is not an administrator (the command is simply refused).
netsh advfirewall firewall add rule name="Teen Patti Arena (port 4000)" dir=in action=allow protocol=TCP localport=4000 >nul 2>nul

rem Fresh log each run: the launcher prints it if the server dies.
rem The path is relative (we already cd'd here) so it needs no quotes of its
rem own, keeping the whole command a single clean string for cmd /c.
if exist "%LOG%" del "%LOG%" >nul 2>nul

start "Teen Patti Arena server" /min cmd /c "node server\index.js 1> %LOG% 2>&1"

echo   Waiting for the server to answer (up to 25 seconds)...
echo.

rem Node polls 127.0.0.1 - the address the server is certain to answer on.
node "%~dp0tools\wait-for-server.mjs" %PORT% 25
if errorlevel 1 goto :failed

start "" "http://127.0.0.1:%PORT%"

echo   The game is opening at http://127.0.0.1:%PORT%
echo   (http://localhost:%PORT% works too.)
echo.
echo   ---------------------------------------------------------------
echo    To play with a friend on the same Wi-Fi: send them the
echo    "Friends on the same Wi-Fi open" link printed above.
echo    They open it, press "Sit down", and you are playing together.
echo    A friend on a DIFFERENT network needs a tunnel or a deploy -
echo    see "Play with friends" in README.md.
echo   ---------------------------------------------------------------
echo.
echo   Leave this window and the minimised server window open while you
echo   play. Press any key to close THIS window - the game keeps running.
pause >nul
exit /b 0

:failed
echo.
echo   ==============================================================
echo    The server did not start.
echo   ==============================================================
echo.
echo   The offline version is opening now - it needs no server at all
echo   and practice against the computer works completely.
echo.
echo   If you want the live tables, the message above says why the
echo   server stopped. The two usual reasons are:
echo.
echo     * Something else is already using port 4000 - often a copy of
echo       Teen Patti Arena you started earlier. Check your taskbar for
echo       another "Teen Patti Arena" window.
echo     * Node.js could not start. Type:  node --version
echo.
start "" "%~dp0PLAY-ME-first.html"
echo   Press any key to close this window.
pause >nul
exit /b 1

:offline
echo.
echo   Node.js was not found on this PC, so the offline single-file
echo   version will open instead - practice vs AI works fully there.
echo.
echo   (Install Node.js from https://nodejs.org to unlock live tables.)
echo.
start "" "%~dp0PLAY-ME-first.html"
exit /b 0
