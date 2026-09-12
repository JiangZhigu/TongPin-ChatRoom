@echo off
setlocal
cd /d "%~dp0"
if exist "..\.venv\Scripts\python.exe" (
  "..\.venv\Scripts\python.exe" -c "import http.server,webbrowser" >nul 2>nul
  if not errorlevel 1 goto project_python
)
py -3 -c "import http.server,webbrowser" >nul 2>nul
if not errorlevel 1 goto py_launcher
python -c "import http.server,webbrowser" >nul 2>nul
if not errorlevel 1 goto python_path
echo No Python found. Opening standalone HTML in your browser.
start "" "%~dp0index.html"
exit /b 0
:project_python
"..\.venv\Scripts\python.exe" "%~dp0serve.py" %*
goto finished
:py_launcher
py -3 "%~dp0serve.py" %*
goto finished
:python_path
python "%~dp0serve.py" %*
:finished
set "DEMO_EXIT=%ERRORLEVEL%"
if not "%DEMO_EXIT%"=="0" pause
exit /b %DEMO_EXIT%
