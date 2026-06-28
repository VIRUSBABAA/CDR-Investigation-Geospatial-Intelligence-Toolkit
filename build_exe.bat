@echo off
REM Run this ON WINDOWS (PyInstaller cannot cross-compile from Linux/Mac).
REM Produces dist\host.exe — a double-clickable launcher that starts the
REM local server and opens your browser automatically.

cd /d "%~dp0"

if not exist venv (
    python -m venv venv
)
call venv\Scripts\activate.bat
pip install --quiet -r requirements.txt
pip install --quiet pyinstaller

pyinstaller --noconfirm --onefile --name host ^
    --add-data "templates;templates" ^
    --add-data "static;static" ^
    --add-data "data;data" ^
    launcher.py

echo.
echo Build complete: dist\host.exe
echo Copy host.exe next to this folder's templates/static/data/instance
echo folders if you move it, OR just run it from the dist folder directly.
pause
