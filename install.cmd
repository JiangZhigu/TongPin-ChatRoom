@echo off
setlocal
call "%~dp0tongpin.cmd" install --bootstrap-tools --download-python %*
set "install_result=%errorlevel%"
if not "%install_result%"=="0" goto finished
echo Installation complete. See INSTALL-PYTHON.zh-CN.md for account setup and startup.
:finished
if not defined TONGPIN_NO_PAUSE pause
exit /b %install_result%
