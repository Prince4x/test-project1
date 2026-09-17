@echo off
rem ===================================================================
rem  Teen Patti Arena - Windows launcher
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
echo   Starting the game server...
echo.

rem start it in its own minimised window so this one stays readable
start "Teen Patti Arena server" /min cmd /c "node server\index.js"

rem let friends on the same Wi-Fi reach port 4000 (silently skipped unless
rem this window is an administrator - the README explains the manual way)
netsh advfirewall firewall add rule name="Teen Patti Arena (port 4000)" dir=in action=allow protocol=TCP localport=4000 >nul 2>nul

rem WAIT FOR THE SERVER TO ANSWER. A fixed sleep is not enough on a cold
rem start - without this the browser can open before the port is listening
rem and all you see is "can't reach this page".
where powershell >nul 2>nul
if errorlevel 1 goto :plainwait

echo   Waiting for the server to answer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://localhost:4000/api/health'; if($r.StatusCode -eq 200){ $ok=$true; break } } catch {}; Start-Sleep -Milliseconds 500 }; if($ok){ try { $n=Invoke-RestMethod -TimeoutSec 2 'http://localhost:4000/api/network'; if($n.primary){ Write-Host ('   Friends on the same Wi-Fi open: ' + $n.primary) } } catch {}; exit 0 } else { exit 1 }"
if errorlevel 1 goto :failed

start "" "http://localhost:4000"
echo.
echo   The server is up and the game is opening at http://localhost:4000
echo.
echo   To play with a friend on the same Wi-Fi: send them the link printed
echo   above (it looks like http://192.168.1.5:4000). In the game you can
echo   also press the chat button and choose "Invite" to copy it.
echo   A friend on a DIFFERENT network needs a tunnel or a deploy - see
echo   "Play with friends" in README.md.
echo.
echo   Leave this window and the minimised server window open while you play.
echo   Press any key to close THIS window - the game keeps running.
pause >nul
exit /b 0

:plainwait
rem no PowerShell on this PC: fall back to a plain three second wait
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:4000"
exit /b 0

:failed
echo.
echo   ==============================================================
echo    The server did not start within 30 seconds.
echo   ==============================================================
echo.
echo   The usual reasons are: another program is already using port
echo   4000, or Node.js refused to run.
echo.
echo   * Check the minimised "Teen Patti Arena server" window - the
echo     error message is in there.
echo   * Meanwhile the offline version is opening, which needs no
echo     server at all (practice against the computer).
echo.
start "" "%~dp0PLAY-ME-first.html"
echo   Press any key to close this window.
pause >nul
exit /b 1

:offline
echo.
echo   Node.js was not found on this PC, so the offline single-file
echo   version will open instead - practice vs AI works fully there.
echo   (Install Node.js from https://nodejs.org to unlock live tables.)
echo.
start "" "%~dp0PLAY-ME-first.html"
exit /b 0
