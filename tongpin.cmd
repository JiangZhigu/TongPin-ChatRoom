@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 goto windows_powershell
pwsh.exe -NoLogo -NoProfile -File "%~dp0tongpin.ps1" %*
exit /b %errorlevel%
:windows_powershell
powershell.exe -NoLogo -NoProfile -File "%~dp0tongpin.ps1" %*
exit /b %errorlevel%
