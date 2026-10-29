#!/bin/bash
# Paper Reader launcher (shared by "Paper Reader.app" and "Start Paper Reader.command").
#   MODE=gui       -> notifications + dialogs (used by the .app); this launcher stays open while the server runs
#                     (its Dock icon), and the server quits when its window is closed or the launcher is quit
#   MODE=terminal  -> prints everything to the Terminal window and runs the server in the foreground
# Environment lives in ~/Library/Application Support/PaperReader (venv, data/, api_key.txt, log).
set -u
# If macOS started us under Rosetta on an Apple-Silicon Mac, restart natively.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && [ -z "${PR_NATIVE:-}" ]; then
  export PR_NATIVE=1
  exec arch -arm64 /bin/bash "$0" "$@"
fi
MODE="${MODE:-terminal}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/Library/Application Support/PaperReader"
VENV="$HOME_DIR/venv"
LOG="$HOME_DIR/paper-reader.log"
PORT="${PORT:-8769}"
VERSION="$(cat "$APP_DIR/VERSION" 2>/dev/null || echo dev)"
mkdir -p "$HOME_DIR"
ARCH="$(uname -m)"
export PR_HOME="$HOME_DIR" PORT
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/3.13/bin:/Library/Frameworks/Python.framework/Versions/3.12/bin:/Library/Frameworks/Python.framework/Versions/3.11/bin:/Library/Frameworks/Python.framework/Versions/3.10/bin:$PATH"
export PYTHONUNBUFFERED=1

log()  { echo "[$(date '+%H:%M:%S')] $*" >>"$LOG"; [ "$MODE" = terminal ] && echo "$*"; }
note() { log "$*"; [ "$MODE" = gui ] && osascript -e "display notification \"$1\" with title \"Paper Reader $VERSION\"" >/dev/null 2>&1; }
fail() {
  log "!! $1"
  if [ "$MODE" = gui ]; then
    osascript -e "display dialog \"$1\n\nLog: $LOG\" with title \"Paper Reader $VERSION\" buttons {\"Open log\",\"OK\"} default button \"OK\" with icon stop" 2>/dev/null | grep -q "Open log" && open -a Console "$LOG"
  else
    echo; echo "Log: $LOG"; read -r -p "Press Enter to close."
  fi
  exit 1
}

log "=== Paper Reader $VERSION starting ($MODE) — app code: $APP_DIR"

# ---- already running? reuse it if it is this version, otherwise replace it
RUNNING_VER="$(curl -s -m 2 "http://localhost:$PORT/api/health" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
if [ -n "$RUNNING_VER" ]; then
  if [ "$RUNNING_VER" = "$VERSION" ]; then
    log "Already running (v$RUNNING_VER) — opening the browser."
    open "http://localhost:$PORT"
    exit 0
  fi
  log "An older Paper Reader (v$RUNNING_VER) is on port $PORT — stopping it."
  curl -s -m 2 -X POST -H "X-Paper-Reader: 1" "http://localhost:$PORT/api/quit" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 1 "http://localhost:$PORT/api/health" >/dev/null 2>&1 || break; sleep 1; done
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null   # older builds may ignore /api/quit
  sleep 1
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  fail "Port $PORT is used by another program. Quit it, or start Paper Reader on another port: PORT=8779 \"$0\""
fi

# ---- find Python 3.10–3.13 built for this Mac's chip
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3 \
         /Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13 \
         /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12 \
         /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 \
         /opt/anaconda3/bin/python3 /usr/bin/python3; do
  command -v "$c" >/dev/null 2>&1 || continue
  info=$("$c" -c 'import sys,platform;print(sys.version_info[1], platform.machine())' 2>/dev/null) || continue
  v="${info%% *}"; m="${info##* }"
  if [ "$v" -ge 10 ] && [ "$v" -le 13 ] && [ "$m" = "$ARCH" ]; then PY="$(command -v "$c")"; break; fi
  log "skipping $(command -v "$c") (3.$v, $m; this Mac is $ARCH)"
done
if [ -z "$PY" ]; then
  if [ "$MODE" = gui ]; then
    osascript -e 'display dialog "Paper Reader needs Python 3.10–3.13 (python.org recommended).\n\nInstall Python 3.13 from python.org, then open Paper Reader again." with title "Paper Reader" buttons {"Open python.org","OK"} default button "OK" with icon caution' 2>/dev/null | grep -q python.org && open "https://www.python.org/downloads/macos/"
    exit 1
  fi
  fail "Python 3.10–3.13 not found. Install 3.13 from python.org and run this again."
fi
log "Python: $PY ($("$PY" --version 2>&1))"

# ---- (re)install packages when the environment is missing or requirements changed
REQ_SHA="$(shasum -a 256 "$APP_DIR/requirements.txt" | cut -c1-16)"
if [ -d "$VENV" ]; then
  vinfo=$("$VENV/bin/python" -c 'import platform;print(platform.machine())' 2>/dev/null) || vinfo=""
  if [ -z "$vinfo" ] || [ "$vinfo" != "$ARCH" ] || ! "$VENV/bin/pip" --version >/dev/null 2>&1; then
    log "Package environment is unusable (${vinfo:-no python}) — rebuilding it."
    rm -rf "$VENV"
  fi
fi
CHECK="import flask, anthropic, pymupdf"
NEED_INSTALL=0
if [ ! -x "$VENV/bin/python" ]; then NEED_INSTALL=1
elif [ "$(cat "$VENV/.requirements.sha" 2>/dev/null)" != "$REQ_SHA" ]; then NEED_INSTALL=1
elif ! "$VENV/bin/python" -c "$CHECK" >/dev/null 2>&1; then NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" = 1 ]; then
  if [ ! -x "$VENV/bin/python" ]; then
    note "First launch: installing packages (about a minute)."
    "$PY" -m venv "$VENV" >>"$LOG" 2>&1 || fail "Could not create a Python environment with $PY."
  else
    note "Updating packages for v$VERSION."
  fi
  if [ "$MODE" = terminal ]; then
    "$VENV/bin/pip" install -q --upgrade pip 2>&1 | tee -a "$LOG"
    "$VENV/bin/pip" install -r "$APP_DIR/requirements.txt" 2>&1 | tee -a "$LOG" | grep -v "already satisfied"
  else
    "$VENV/bin/pip" install -q --upgrade pip >>"$LOG" 2>&1
    "$VENV/bin/pip" install -r "$APP_DIR/requirements.txt" >>"$LOG" 2>&1
  fi
  "$VENV/bin/python" -c "$CHECK" >>"$LOG" 2>&1 \
    || { rm -f "$VENV/.requirements.sha"; fail "Installing packages failed. Common causes: no internet, or a Python build without SSL. Details are in the log."; }
  echo "$REQ_SHA" >"$VENV/.requirements.sha"
  log "Packages installed."
fi

# ---- the server code must import cleanly with these packages
cd "$APP_DIR" || fail "App folder missing: $APP_DIR"
"$VENV/bin/python" -c "import server" >>"$LOG" 2>&1 \
  || fail "The app failed its start-up check (a package is incompatible). The log shows which one."

# ---- start the server
log "Starting server on port $PORT"
if [ "$MODE" = terminal ]; then
  echo ">> Starting http://localhost:$PORT  (leave this window open; press Ctrl+C to stop)"
  ( for _ in $(seq 1 60); do curl -s -m 1 "http://localhost:$PORT/api/health" >/dev/null 2>&1 && { open "http://localhost:$PORT"; exit 0; }; sleep 1; done ) &
  export PR_LAUNCHER_PID=$$
  exec "$VENV/bin/python" server.py 2>&1 | tee -a "$LOG"
fi

# GUI mode: this launcher waits for the server, so the app sits in the Dock while Paper Reader is open.
# The server quits when its browser window is closed (lifecycle.py), when "Quit Paper Reader" is pressed, or when
# this launcher is quit / force-quit from the Dock (it watches PR_LAUNCHER_PID). Nothing is left running.
export PR_LAUNCHER_PID=$$
"$VENV/bin/python" server.py >>"$LOG" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; exit 0' TERM HUP INT
for _ in $(seq 1 60); do
  curl -s -m 1 "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done
if ! curl -s -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  kill "$SERVER" 2>/dev/null
  fail "The server did not start. The last lines of the log say why."
fi
open "http://localhost:$PORT"
note "Running at http://localhost:$PORT. Close its browser tab to quit."
wait "$SERVER"
log "Server stopped."
exit 0
