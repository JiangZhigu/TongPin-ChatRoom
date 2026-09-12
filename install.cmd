@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 goto windows_powershell
pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\bootstrap_windows.ps1" %*
set "install_result=%errorlevel%"
goto finished
:windows_powershell
powershell.exe -NoLogo -NoProfile -File "%~dp0scripts\bootstrap_windows.ps1" %*
set "install_result=%errorlevel%"
:finished
if /I "%~1"=="--dry-run" exit /b %install_result%
if /I "%~1"=="--help" exit /b %install_result%
if not defined TONGPIN_NO_PAUSE pause
exit /b %install_result%
