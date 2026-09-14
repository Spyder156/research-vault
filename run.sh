#!/usr/bin/env bash
# Launch Research Vault.   Usage:  bash run.sh        (start)
#                                  bash run.sh stop   (stop)
set -euo pipefail
cd "$(dirname "$0")"

PORT=7777
PY=.venv/bin/python

if [ "${1:-}" = "stop" ]; then
  "$PY" run.py --stop --port "$PORT"
  exit 0
fi

# First run on a fresh clone: build the venv and install deps.
if [ ! -x "$PY" ]; then
  echo "setting up .venv ..."
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

URL="http://127.0.0.1:$PORT"

# Exit 1 just means "already serving" — that is fine, still show the address.
if "$PY" run.py --background --no-browser --port "$PORT" >/dev/null; then
  STATE="is live"
else
  STATE="was already running"
fi

printf '\n  Research Vault %s\n\n    %s\n\n  stop:  bash run.sh stop\n  log:   logs/server.log\n\n' "$STATE" "$URL"

# Open the browser if we are on a desktop session; harmless over SSH.
command -v xdg-open >/dev/null && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && xdg-open "$URL" >/dev/null 2>&1 &
exit 0
