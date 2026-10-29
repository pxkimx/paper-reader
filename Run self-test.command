#!/bin/bash
# Checks the Paper Reader installation offline (about 30 seconds). Uses a throwaway library; your papers are untouched.
cd "$(dirname "$0")/Paper Reader.app/Contents/Resources/app" || exit 1
PY="$HOME/Library/Application Support/PaperReader/venv/bin/python"
if [ ! -x "$PY" ]; then echo "Open Paper Reader once first (it installs its packages), then run this again."; read -r -p "Press Enter to close."; exit 1; fi
echo ">> Running the Paper Reader self-test…"
"$PY" -W ignore -m unittest discover tests -v 2>&1 | grep -E "ok$|FAIL|ERROR|Ran |^OK|FAILED|skipped"
echo; read -r -p "Press Enter to close."
