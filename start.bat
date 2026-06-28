@echo off
title SignalTrace - CDR Case Analysis (DEMO)
cd /d "%~dp0"

if not exist venv (
    echo Setting up environment for first run, please wait...
    python -m venv venv
    call venv\Scripts\activate.bat
    pip install --quiet -r requirements.txt
) else (
    call venv\Scripts\activate.bat
)

echo.
echo Starting SignalTrace on http://127.0.0.1:5050
echo Default login: admin / admin  (change it after first sign in)
echo Press CTRL+C in this window to stop the server.
echo.

start "" http://127.0.0.1:5050
python app.py

pause
