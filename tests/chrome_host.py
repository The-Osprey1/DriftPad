"""
chrome_host.py - Runs configurator pages in headless Chrome (or Edge) and reads their results.

A page writes a JSON object into <pre id="results">; --dump-dom returns the DOM once the virtual
time budget has run out (timers advance in virtual time, so multi-second waits are instant).

Virtual time only covers the page's own thread: work the browser does elsewhere (decoding a picture
with ImageDecoder, a Web Worker) does not hold it, so the budget can run out first. run_page_realtime()
runs such pages on the real clock instead, reading the results over the DevTools protocol (a
minimal WebSocket client, so still no third-party packages).

Pure Python standard library. SkipTest when no Chromium browser is installed.
"""

import base64
import html
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from typing import Optional

BROWSER_ENV = ("DRIFTPAD_CHROME", "CHROME_PATH", "CHROME_BIN")
BROWSER_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")

NO_BROWSER_REASON = "No Chromium-based browser found (set DRIFTPAD_CHROME); configurator browser tests not run"


def find_browser(env=None, which=shutil.which, exists=os.path.isfile) -> Optional[str]:
    """Shared discovery for execution and release gating; read overrides at call time."""
    env = os.environ if env is None else env
    candidates = [env.get(var) for var in BROWSER_ENV] + list(BROWSER_NAMES)
    for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)"), env.get("LOCALAPPDATA"),
                 "C:/Program Files", "C:/Program Files (x86)"):
        if base:
            for vendor, product, executable in (("Google", "Chrome", "chrome.exe"),
                                                 ("Microsoft", "Edge", "msedge.exe")):
                candidates.append(os.path.join(base, vendor, product, "Application", executable))
    candidates += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                   "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    for c in candidates:
        if not c:
            continue
        if exists(c):
            return c
        found = which(c)
        if found:
            return found
    return None


def no_sandbox_requested() -> bool:
    return os.environ.get("DRIFTPAD_CHROME_NO_SANDBOX", "").strip().lower() in ("1", "true", "yes", "on")


def require_browser() -> str:
    b = find_browser()
    if b is None:
        raise unittest.SkipTest(NO_BROWSER_REASON)
    return b


def file_url(path: Path, fragment: str = "", query: str = "") -> str:
    url = Path(path).resolve().as_uri()
    if query:
        url += "?" + query
    if fragment:
        url += "#" + fragment
    return url


def run_page(url: str, budget_ms: int = 60000, timeout_s: int = 180) -> dict:
    """Loads `url` headless and returns the JSON in <pre id="results"> (AssertionError if absent)."""
    browser = require_browser()
    with tempfile.TemporaryDirectory(prefix="driftpad_chrome_") as profile:
        cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--disable-extensions", "--allow-file-access-from-files", f"--user-data-dir={profile}",
               f"--virtual-time-budget={budget_ms}", "--dump-dom", url]
        # CI containers that forbid Chrome's sandbox (Ubuntu 24.04 AppArmor) set this; never by default
        if no_sandbox_requested():
            cmd.insert(1, "--no-sandbox")
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                timeout=timeout_s)
    if result.returncode != 0:
        raise AssertionError(f"browser exited {result.returncode}: {url}\n"
                             f"stderr tail:\n{result.stderr[-2000:]}")
    m = re.search(r'<pre id="results">(.*?)</pre>', result.stdout, re.S)
    if not m:
        raise AssertionError(f"page produced no results: {url}\nstdout tail:\n{result.stdout[-2000:]}\n"
                             f"stderr tail:\n{result.stderr[-2000:]}")
    return json.loads(html.unescape(m.group(1)))


class _WebSocket:
    """Just enough of RFC 6455 for the DevTools protocol on localhost: text frames, masked sends."""

    def __init__(self, host: str, port: int, path: str, timeout: float):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise AssertionError("DevTools closed the connection during the handshake")
            head += chunk
        status, _, rest = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n", 1)[0]:
            raise AssertionError(f"DevTools refused the WebSocket: {status[:200]!r}")
        self.buf = rest

    def close(self):
        self.sock.close()

    def _frame(self, opcode: int, data: bytes):
        header = bytearray([0x80 | opcode])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(bytes(header) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, text: str):
        self._frame(0x1, text.encode("utf-8"))

    def _read(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise AssertionError("DevTools closed the connection")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self) -> str:
        message = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            opcode = b0 & 0x0F
            if opcode == 0x8:
                raise AssertionError("DevTools closed the connection")
            if opcode == 0x9:
                self._frame(0xA, payload)
                continue
            if opcode in (0x0, 0x1, 0x2):
                message += payload
                if b0 & 0x80:
                    return message.decode("utf-8", errors="replace")


RESULTS_EXPRESSION = "(() => { const r = document.getElementById('results'); return document.title === 'done' && r ? r.textContent : ''; })()"


def run_page_realtime(url: str, timeout_s: int = 180) -> dict:
    """Loads `url` headless on the real clock and returns the JSON the harness writes into
    <pre id="results"> once it sets the title to "done" (AssertionError on timeout)."""
    browser = require_browser()
    with tempfile.TemporaryDirectory(prefix="driftpad_chrome_", ignore_cleanup_errors=True) as profile:
        cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--disable-extensions", "--allow-file-access-from-files", f"--user-data-dir={profile}",
               "--remote-debugging-port=0", url]
        if no_sandbox_requested():
            cmd.insert(1, "--no-sandbox")
        log_path = Path(profile) / "browser_stderr.log"
        log = open(log_path, "wb")    # a file, not a pipe: a chatty browser can never block on it
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=log)
        deadline = time.monotonic() + timeout_s
        ws = None
        try:
            port_file = Path(profile) / "DevToolsActivePort"
            while True:
                lines = port_file.read_text(encoding="utf-8").split() if port_file.exists() else []
                if len(lines) >= 2:
                    break
                if proc.poll() is not None:
                    raise AssertionError(f"browser exited {proc.returncode} before DevTools started: {url}\n"
                                         f"stderr tail:\n{log_path.read_text(errors='replace')[-2000:]}")
                if time.monotonic() > deadline:
                    raise AssertionError(f"DevTools did not start: {url}")
                time.sleep(0.1)
            port = int(lines[0])
            # Never through the agent or corporate proxy: DevTools listens on this machine only
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            page = None
            while page is None:
                targets = json.loads(opener.open(f"http://127.0.0.1:{port}/json/list", timeout=10).read())
                page = next((t for t in targets if t.get("type") == "page"), None)
                if page is None:
                    if time.monotonic() > deadline:
                        raise AssertionError(f"no page target: {url}")
                    time.sleep(0.1)
            path = "/" + page["webSocketDebuggerUrl"].split("/", 3)[3]
            ws = _WebSocket("127.0.0.1", port, path, timeout=30)
            next_id = 0
            last = ""
            while time.monotonic() < deadline:
                next_id += 1
                ws.send(json.dumps({"id": next_id, "method": "Runtime.evaluate",
                                    "params": {"expression": RESULTS_EXPRESSION, "returnByValue": True}}))
                while True:
                    msg = json.loads(ws.recv())
                    if msg.get("id") == next_id:
                        break
                last = msg.get("result", {}).get("result", {}).get("value") or ""
                if last:
                    return json.loads(last)
                time.sleep(0.25)
            raise AssertionError(f"page produced no results within {timeout_s} s: {url}")
        finally:
            if ws is not None:
                ws.close()
            proc.kill()
            proc.wait(timeout=30)
            log.close()
