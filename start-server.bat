@echo off
cd /d "%~dp0"

set "PYTHON_CMD="

where python >nul 2>nul
if %errorlevel%==0 set "PYTHON_CMD=python"

if not defined PYTHON_CMD (
  for /d %%D in ("%LocalAppData%\Programs\Python\Python*") do (
    if exist "%%~fD\python.exe" set "PYTHON_CMD=%%~fD\python.exe"
  )
)

if not defined PYTHON_CMD (
  where py >nul 2>nul
  if %errorlevel%==0 set "PYTHON_CMD=py"
)

if not defined PYTHON_CMD (
  echo Python was not found. Install Python or open index.html directly.
  pause
  exit /b 1
)

echo Starting Tech Stock Research System...
echo URL: http://127.0.0.1:8000/
echo.
echo Keep this window open while using the page.
echo Press Ctrl+C to stop the server.
echo.

start "" http://127.0.0.1:8000/
%PYTHON_CMD% -m http.server 8000 --bind 127.0.0.1

echo.
echo Server stopped.
pause
