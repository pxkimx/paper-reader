#!/bin/bash
# Backup only: Paper Reader quits by itself when its browser tab is closed. This stops it if it is still running.
PORT="${PORT:-8769}"
if curl -s -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  curl -s -m 2 -X POST -H "X-Paper-Reader: 1" "http://localhost:$PORT/api/quit" >/dev/null 2>&1; sleep 1
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null
  echo "Paper Reader stopped."
else
  echo "Paper Reader was not running."
fi
sleep 1
