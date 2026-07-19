@echo off
rem Icarus supervisor loop — the restart guarantee lives here, not in Task Scheduler.
cd /d "%~dp0.."
if not exist state\logs mkdir state\logs
:loop
rem Rotate the service log at each (re)start if it grew past ~20 MB.
for %%A in (state\logs\service.out.log) do if exist "%%A" if %%~zA gtr 20000000 move /y "%%A" state\logs\service.out.old.log >nul
"C:\Program Files\nodejs\node.exe" node_modules\tsx\dist\cli.mjs src\main.ts >> state\logs\service.out.log 2>&1
rem 10s backoff before restart (ping instead of timeout: timeout breaks with redirected stdin).
ping -n 11 127.0.0.1 >nul
goto loop
