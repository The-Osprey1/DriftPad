"""
chrome_host.py - Runs configurator pages in headless Chrome (or Edge) and reads their results.

A page writes a JSON object into <pre id="results">; --dump-dom returns the DOM once the virtual
time budget has run out (timers advance in virtual time, so multi-second waits are instant).

Pure Python standard library. SkipTest when no Chromium browser is installed.
"""

import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Optional

CANDIDATES = [
    os.environ.get("DRIFTPAD_CHROME"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
]

NO_BROWSER_REASON = "No Chromium-based browser found (set DRIFTPAD_CHROME); configurator browser tests not run"


def find_browser() -> Optional[str]:
    for c in CANDIDATES:
        if not c:
            continue
        if os.path.isfile(c):
            return c
        found = shutil.which(c)
        if found:
            return found
    return None


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
        if os.environ.get("DRIFTPAD_CHROME_NO_SANDBOX", "").strip() in ("1", "true", "yes"):
            cmd.insert(1, "--no-sandbox")
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                timeout=timeout_s)
    m = re.search(r'<pre id="results">(.*?)</pre>', result.stdout, re.S)
    if not m:
        raise AssertionError(f"page produced no results: {url}\nstdout tail:\n{result.stdout[-2000:]}\n"
                             f"stderr tail:\n{result.stderr[-2000:]}")
    return json.loads(html.unescape(m.group(1)))
