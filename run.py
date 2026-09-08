#!/usr/bin/env python3
"""Launch Research Vault on http://127.0.0.1:7777 and open the browser."""

import threading
import webbrowser

import uvicorn

PORT = 7777

if __name__ == "__main__":
    threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=PORT)
