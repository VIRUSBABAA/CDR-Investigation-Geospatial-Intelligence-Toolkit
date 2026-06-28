#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d venv ]; then
    echo "Setting up environment for first run, please wait..."
    python3 -m venv venv
    source venv/bin/activate
    pip install --quiet -r requirements.txt
else
    source venv/bin/activate
fi

echo ""
echo "Starting SignalTrace on http://127.0.0.1:5050"
echo "Default login: admin / admin  (change it after first sign in)"
echo "Press CTRL+C to stop the server."
echo ""

( sleep 1.5 && (xdg-open http://127.0.0.1:5050 2>/dev/null || open http://127.0.0.1:5050 2>/dev/null) ) &
python app.py
