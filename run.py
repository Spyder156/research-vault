#!/usr/bin/env python3
"""Launch Research Vault.

    python run.py                # run in this terminal, open the browser
    python run.py --background   # detach; log to logs/server.log
    python run.py --stop         # stop whatever is serving the port
    python run.py --port 7788    # use a different port

Everything the app writes stays inside this folder: ideas/ for your data,
logs/ for server output. Both are gitignored.
"""

import argparse
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
PID_FILE = LOG_DIR / "server.pid"
DEFAULT_PORT = 7777


def port_pid(port: int) -> int | None:
    """PID listening on the port, or None. Falls back to the pidfile if ss is absent."""
    try:
        out = subprocess.run(["ss", "-ltnpH"], capture_output=True, text=True).stdout
        for line in out.splitlines():
            if f":{port} " in line and "pid=" in line:
                return int(line.split("pid=")[1].split(",")[0])
    except (FileNotFoundError, ValueError, IndexError):
        pass
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, 0)            # signal 0 = "does this process exist?"
            return pid
        except (ValueError, ProcessLookupError, PermissionError, OSError):
            return None
    return None


def stop(port: int) -> int:
    pid = port_pid(port)
    if not pid:
        print(f"nothing serving port {port}")
        return 0
    os.kill(pid, 15)
    for _ in range(40):                # wait up to ~4s for a clean exit
        time.sleep(0.1)
        if not port_pid(port):
            break
    PID_FILE.unlink(missing_ok=True)
    print(f"stopped pid {pid} on port {port}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Research Vault")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--background", "-b", action="store_true",
                    help="detach and log to logs/server.log")
    ap.add_argument("--stop", action="store_true", help="stop the running server")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if args.stop:
        return stop(args.port)

    running = port_pid(args.port)
    if running:
        print(f"already running on port {args.port} (pid {running})")
        print(f"  open   http://127.0.0.1:{args.port}")
        print(f"  stop   python run.py --stop")
        return 1

    url = f"http://127.0.0.1:{args.port}"

    if args.background:
        LOG_DIR.mkdir(exist_ok=True)
        log = LOG_DIR / "server.log"
        with open(log, "ab") as fh:
            proc = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "app.main:app",
                 "--host", "127.0.0.1", "--port", str(args.port)],
                cwd=ROOT, stdout=fh, stderr=fh, stdin=subprocess.DEVNULL,
                start_new_session=True,       # survives this terminal closing
            )
        PID_FILE.write_text(str(proc.pid))
        time.sleep(1.5)
        print(f"serving {url}  (pid {proc.pid})")
        print(f"  log    {log.relative_to(ROOT)}")
        print(f"  stop   python run.py --stop")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    import uvicorn
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print(f"serving {url}   (ctrl+c to stop)")
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
