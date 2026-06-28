"""
launcher.py
Entry point used when packaged into host.exe via PyInstaller.
Starts the Flask app on a local port and opens the user's default browser.
"""
import threading
import webbrowser
import time

from app import create_app

HOST = "127.0.0.1"
PORT = 5050


def open_browser():
    time.sleep(1.2)
    webbrowser.open(f"http://{HOST}:{PORT}")


if __name__ == "__main__":
    threading.Thread(target=open_browser, daemon=True).start()
    app = create_app()
    app.run(host=HOST, port=PORT, debug=False)
