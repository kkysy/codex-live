@echo off
rem Stop Codex Live - kills ONLY python processes running OUR server.py
rem (matches command line "server.py"; never touches ComfyUI or other python apps)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like 'python%%'\" | Where-Object { $_.CommandLine -match 'server\.py' -and $_.CommandLine -notmatch 'ComfyUI' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Stopped PID ' + $_.ProcessId) }"
if exist codex-live.pid del codex-live.pid
