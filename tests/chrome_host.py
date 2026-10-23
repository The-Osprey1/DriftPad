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
