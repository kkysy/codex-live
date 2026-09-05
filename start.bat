@echo off
rem Codex Live launcher: kill own old instances first (NEVER touches other python apps like ComfyUI),
rem then start one fresh server, wait until ready, open a NEW browser window.
cd /d %~dp0

set PORT=8765

rem 1) sweep: stop every python whose command line is OUR server.py (matches by "server.py", excludes others)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'python%%'\" | Where-Object { $_.CommandLine -match 'server\.py' -and $_.CommandLine -notmatch 'ComfyUI' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

rem 2) start fresh
start "Codex Live" /min python -u server.py

rem 3) poll until the port answers (max ~25s)
set /a tries=0
:waitloop
set /a tries+=1
if %tries% gtr 25 (
  echo [start.bat] server not ready in 25s, check server.log
  pause
  exit /b 1
)
curl -s -o NUL -m 2 http://127.0.0.1:%PORT%/api/state
if errorlevel 1 (
  ping -n 2 127.0.0.1 >nul
  goto :waitloop
)

rem 4) prefer Chrome explicit new window; fallback to system default browser
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
  start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window "http://127.0.0.1:%PORT%"
) else (
  start "" "http://127.0.0.1:%PORT%"
)
echo Codex Live ready: http://127.0.0.1:%PORT%
