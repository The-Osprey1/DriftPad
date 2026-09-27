"""
run_all_tests.py - DriftPad test runner.

Discovers every tests/test_*.py module and every unittest.TestCase defined in it (classes imported
from other modules are not run twice), runs the firmware build suite FIRST so artifact checks only
see artifacts produced by this run, and reports honest accounting:

* planned / executed / passed / failed / errors / skipped tests,
* skipped and errored CLASSES (setUpClass/setUpModule raising) with the number of tests they held,
  so "3 classes skipped (27 tests not run)" is visible instead of silently missing,
* modules that failed to import,
* a scope label per suite ("synthetic model", "compiled firmware on host", "headless browser",
  "build artifacts", ...) so synthetic DSP results are never presented as hardware results,
* the host C++ compiler, headless browser and PlatformIO that were found.

Nothing here exercises physical hardware; the summary says so.

Modes:
  (default)   diagnostic: skips are allowed but printed with their reasons; the last line is
              "NOT RELEASE-QUALIFIED: ...". Exit code is non-zero on any failure or error.
  --release   any skip, class-level skip/error, import error, missing required tool or suite,
              missing/dirty/mismatched build manifest, or a dirty git tree fails the run.

Options:
  --json PATH   write a machine-readable summary (counts, per-test status, scopes, tools, build
                evidence, timestamp)
  --clean       `pio run -t clean` before building (same as DRIFTPAD_CLEAN_BUILD=1)
  --list        list the discovered suites and scopes without running anything

A test module may declare its scope with a module- or class-level `SCOPE = "..."` attribute; the
table below covers the known modules, and unknown modules are classified from their source.

Pure Python 3 standard library: zero external pip dependencies.
"""

import argparse
import importlib
import json
import os
import platform
import re
import shutil
import sys
import time
import traceback
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
for _p in (str(SCRIPT_DIR), str(PROJECT_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import build_state  # noqa: E402

RESULT_SCHEMA = "driftpad-test-results/1"
BUILD_FIRST = ("test_build",)

# Scope vocabulary
SYNTHETIC = "synthetic model"
COMPILED = "compiled firmware on host"
BROWSER = "headless browser"
ARTIFACTS = "build artifacts"
SOURCE = "source inspection"
TOOLING = "host tooling with fakes"
UNCLASSIFIED = "unclassified"

# (module, class regex or None, method regex or None, scope); first match wins
SCOPE_RULES: List[Tuple[str, Optional[str], Optional[str], str]] = [
    ("test_build", None, None, ARTIFACTS),
    ("test_flash_layout", None, None, ARTIFACTS),
    ("test_challenger2_verification", None, r"^test_0[1-4]_", ARTIFACTS),
    ("test_challenger2_verification", None, None, SOURCE),
    ("test_dsp_harness", None, None, SYNTHETIC),
    ("test_adversarial_m2", None, None, SYNTHETIC),
    ("test_config_schema", None, r"zero_external|keymap_editor", SOURCE),
    ("test_config_schema", None, r"tc14", COMPILED),
    ("test_config_schema", None, None, SYNTHETIC),
    ("test_firmware_parity", None, None, COMPILED),
    ("test_keyboard_output", None, None, COMPILED),
    ("test_calibration", None, None, COMPILED),
    ("test_settings_store", None, None, COMPILED),
    ("test_protocol_core", None, None, COMPILED),
    ("test_timing", None, None, COMPILED),
    ("test_virtual_device", None, None, COMPILED),
    ("test_protocol_device", None, None, COMPILED),
    ("test_persistence_device", None, None, COMPILED),
    ("test_build_info_script", None, None, TOOLING),
    ("test_configurator_js", None, None, BROWSER),
    ("test_configurator", None, None, SOURCE),
    ("test_flash_tool", None, None, TOOLING),
    ("test_release_tooling", None, None, TOOLING),
]

# Suites a release needs (contract section 8): (label, module name patterns)
REQUIRED_SUITES: List[Tuple[str, Tuple[str, ...]]] = [
    ("DSP model (synthetic)", ("test_dsp_harness",)),
    ("firmware parity (compiled)", ("test_firmware_parity",)),
    ("keyboard output (compiled)", ("test_keyboard_output",)),
    ("calibration (compiled)", ("test_calibration", "test_persistence_device")),
    ("settings store (compiled)", ("test_settings_store", "test_persistence_device")),
    ("protocol/parser (compiled)", ("test_protocol_core",)),
    ("virtual device integration (compiled)", ("test_virtual_device", "test_protocol_device")),
    ("configurator JS (headless Chrome)", ("test_configurator_js",)),
    ("build + artifacts", ("test_build",)),
    ("flash layout (build artifacts)", ("test_flash_layout",)),
    ("docs/contract consistency", (r"test_docs\w*", r"test_contract\w*")),
]

REQUIRED_TOOLS = ("host_cxx", "browser", "platformio")

# Human-readable ids for known tests: (module regex, method regex, id, description)
_DSP_MODULES = r"test_dsp_harness|test_firmware_parity|test_adversarial_m2"
TEST_META: List[Tuple[str, str, str, str]] = [
    (_DSP_MODULES, r"tc01", "TC-01", "RT reversal accuracy (0.20 mm)"),
    (_DSP_MODULES, r"tc02", "TC-02", "RT reversal accuracy (0.15 mm)"),
    (_DSP_MODULES, r"tc03", "TC-03", "RT reversal accuracy (0.10 mm)"),
    (_DSP_MODULES, r"tc04", "TC-04", "RT min sens (0.10 mm) depth sweep"),
    (_DSP_MODULES, r"tc05", "TC-05", "RT multi-velocity sweep"),
    (_DSP_MODULES, r"tc06", "TC-06", "10 s rest with 60 Hz EMI"),
    (_DSP_MODULES, r"tc07", "TC-07", "5 s held key sub-RT jitter"),
    (_DSP_MODULES, r"tc08", "TC-08", "5 s released sub-RT jitter"),
    (_DSP_MODULES, r"tc09", "TC-09", "Actuation response latency"),
    (_DSP_MODULES, r"tc10", "TC-10", "RT release response latency"),
    (_DSP_MODULES, r"tc11", "TC-11", "+100 counts baseline drift"),
    (_DSP_MODULES, r"tc12", "TC-12", "-100 counts baseline drift"),
    (_DSP_MODULES, r"tc16", "TC-16", "RT reversals with active noise"),
    (_DSP_MODULES, r"tc17", "TC-17", "Rapid re-taps stay responsive"),
    (_DSP_MODULES, r"polarity_auto", "TC-P1", "Polarity auto-detection"),
    (_DSP_MODULES, r"simulated_travel", "TC-S1", "Direct travel injection"),
    (_DSP_MODULES, r"clamped_to_floor", "TC-S2", "RT sensitivity floor clamp"),
    (_DSP_MODULES, r"sinusoid", "TC-W1", "Sinusoid waveform generator"),
    (_DSP_MODULES, r"triangle", "TC-W2", "Triangle ramp generator"),
    (_DSP_MODULES, r"noise_injection", "TC-W3", "Noise & EMI statistics"),
    (_DSP_MODULES, r"^test_adv01", "ADV-01", "RT floor chatter, 20-count EMI"),
    (_DSP_MODULES, r"^test_adv02", "ADV-02", "RT floor chatter, EMI + thermal"),
    (_DSP_MODULES, r"^test_adv03", "ADV-03", "Auto-zero boot negative step"),
    (_DSP_MODULES, r"^test_adv04", "ADV-04", "Auto-zero positive step"),
    (_DSP_MODULES, r"^test_adv05", "ADV-05", "Auto-zero finger rest freeze"),
    (r"test_firmware_parity", r"identical_key_events", "FW-SYNC", "hall.cpp vs model key events"),
    (r"test_firmware_parity", r"constants_match", "FW-CONST", "hall.h vs model constants"),
    (r"test_build", r"tc13", "TC-13", "PlatformIO firmware build (this run)"),
    (r"test_build", r"^test_01_", "TC-B1", "UF2 produced by this build, size"),
    (r"test_build", r"^test_02_", "TC-B2", "ELF & BIN produced by this build"),
    (r"test_build", r"^test_03_", "TC-B3", "UF2 magic & RP2040 family ID"),
    (r"test_build", r"^test_04_", "TC-B4", "Build manifest matches artifacts"),
    (r"test_challenger2_verification", r"^test_01_", "CH2-01", "All build artifacts present"),
    (r"test_challenger2_verification", r"^test_02_", "CH2-02", "UF2 exhaustive block validation"),
    (r"test_challenger2_verification", r"^test_03_", "CH2-03", "ELF headers & segment isolation"),
    (r"test_challenger2_verification", r"^test_04_", "CH2-04", "Memory footprint & budgets"),
    (r"test_challenger2_verification", r"^test_05_", "CH2-05", "Config schema & CRC32 integrity"),
    (r"test_challenger2_verification", r"^test_06_", "CH2-06", "OLED safe zone & core guards"),
    (r"test_challenger2_verification", r"^test_07_", "CH2-07", "Serial command coverage"),
    (r"test_config_schema", r"tc14", "TC-14", "WebSerial command parser"),
    (r"test_config_schema", r"tc15", "TC-15", "3-layer JSON roundtrip"),
    (r"test_config_schema", r"zero_external", "TC-C1", "Configurator zero-CDN check"),
    (r"test_config_schema", r"profile_schema_adversarial", "TC-C2", "Profile schema adversarial rejection"),
    (r"test_config_schema", r"get_config_payload_adversarial", "TC-C3", "GET_CONFIG payload adversarial rejection"),
]


# ----------------------------------------------------------------------------
# Discovery
# ----------------------------------------------------------------------------

class SuiteInfo:
    """One TestCase class: what was planned and what happened to it."""

    def __init__(self, module: str, cls: type, tests: List[unittest.TestCase],
                 test_scopes: Dict[str, str]):
        self.module = module
        self.cls = cls
        self.name = f"{module}.{cls.__name__}"
        self.strclass = unittest.util.strclass(cls)
        self.tests = tests
        self.test_scopes = test_scopes
        unique = list(dict.fromkeys(test_scopes.values()))
        self.scope = " + ".join(unique) if unique else UNCLASSIFIED
        self.class_skip: Optional[str] = None
        self.class_error: Optional[str] = None
        self.teardown_error: Optional[str] = None

    @property
    def planned(self) -> int:
        return len(self.tests)


def short_module(name: str) -> str:
    return name.rsplit(".", 1)[-1]


def discover_module_names(tests_dir: Path = SCRIPT_DIR) -> List[str]:
    names = sorted(p.stem for p in tests_dir.glob("test_*.py"))
    first = [n for n in BUILD_FIRST if n in names]
    return first + [n for n in names if n not in first]


def scope_for(module_short: str, cls: type, method: Optional[str], module_obj: Any = None,
              source: Optional[str] = None) -> str:
    for holder in (cls, module_obj):
        declared = getattr(holder, "SCOPE", None) if holder is not None else None
        if isinstance(declared, str) and declared:
            return declared
    for mod, cls_re, meth_re, scope in SCOPE_RULES:
        if mod != module_short:
            continue
        if cls_re and not re.search(cls_re, cls.__name__):
            continue
        if meth_re and (method is None or not re.search(meth_re, method)):
            continue
        return scope
    text = (source or "").lower()
    if "host_build" in text:
        return COMPILED
    if "chrome" in text or "headless" in text:
        return BROWSER
    return UNCLASSIFIED


def own_test_classes(module: Any) -> List[type]:
    """TestCase subclasses defined in `module` itself, in definition order."""
    out = []
    for obj in vars(module).values():
        if (isinstance(obj, type) and issubclass(obj, unittest.TestCase)
                and obj.__module__ == module.__name__):
            out.append(obj)
    return out


def load_module_suites(module: Any, loader: unittest.TestLoader) -> List[SuiteInfo]:
    mshort = short_module(module.__name__)
    try:
        source = Path(module.__file__).read_text(encoding="utf-8", errors="ignore")
    except (OSError, TypeError, AttributeError):
        source = ""
    suites: List[SuiteInfo] = []
    if hasattr(module, "load_tests"):
        # Honour the load_tests protocol, then group the resulting tests by class
        by_cls: Dict[type, List[unittest.TestCase]] = {}
        for t in _flatten(loader.loadTestsFromModule(module)):
            by_cls.setdefault(type(t), []).append(t)
        groups = list(by_cls.items())
    else:
        groups = [(cls, list(loader.loadTestsFromTestCase(cls))) for cls in own_test_classes(module)]
    for cls, tests in groups:
        if not tests:
            continue
        scopes = {}
        for t in tests:
            method = getattr(t, "_testMethodName", str(t))
            scopes[method] = scope_for(mshort, cls, method, module, source)
        suites.append(SuiteInfo(mshort, cls, tests, scopes))
    return suites


def _flatten(suite: unittest.TestSuite) -> List[unittest.TestCase]:
    out = []
    for t in suite:
        if isinstance(t, unittest.TestSuite):
            out.extend(_flatten(t))
        else:
            out.append(t)
    return out


def test_meta(module_short: str, cls: type, method: str) -> Tuple[str, str]:
    for mod_re, meth_re, tid, desc in TEST_META:
        if re.fullmatch(mod_re, module_short) and re.search(meth_re, method):
            if cls.__name__.endswith("OnFirmware"):
                tid = "FW " + tid
            return tid, desc
    return "", f"{module_short}.{cls.__name__}.{method}"


# ----------------------------------------------------------------------------
# Tools
# ----------------------------------------------------------------------------

BROWSER_ENV = ("DRIFTPAD_CHROME", "CHROME_PATH", "CHROME_BIN")
BROWSER_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")


def find_browser(env=os.environ, which=shutil.which, exists=os.path.isfile) -> Optional[str]:
    for var in BROWSER_ENV:
        p = env.get(var)
        if p and exists(p):
            return p
    for name in BROWSER_NAMES:
        p = which(name)
        if p:
            return p
    candidates = []
    for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)"), env.get("LOCALAPPDATA"),
                 "C:/Program Files", "C:/Program Files (x86)"):
        if base:
            candidates.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    candidates.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    for c in candidates:
        if exists(c):
            return c
    return None


def detect_tools() -> Dict[str, Dict[str, Any]]:
    tools: Dict[str, Dict[str, Any]] = {}
    try:
        import host_build
        found = host_build.find_compiler()
        tools["host_cxx"] = {"found": found is not None, "detail": host_build.compiler_description()}
    except Exception as e:  # host_build is lead-owned; never let it break the runner
        tools["host_cxx"] = {"found": False, "detail": f"tests/host_build.py unusable: {e}"}
    browser = find_browser()
    tools["browser"] = {"found": browser is not None, "detail": browser or "none"}
    pio = build_state.find_platformio()
    tools["platformio"] = {"found": pio is not None, "detail": pio[1] if pio else "none"}
    return tools


# ----------------------------------------------------------------------------
# Result tracking
# ----------------------------------------------------------------------------

_FIXTURE_RE = re.compile(r"^(setUpClass|tearDownClass|setUpModule|tearDownModule|doClassCleanups|"
                         r"doModuleCleanups)\s+\((.+)\)$")


class TrackingResult(unittest.TestResult):
    """Records one final status per test (subtests folded into their test) and fixture events."""

    def __init__(self, suites: List[SuiteInfo], printer=None):
        super().__init__()
        self.suites = suites
        self.by_strclass = {s.strclass: s for s in suites}
        self.by_test_id: Dict[str, SuiteInfo] = {t.id(): s for s in suites for t in s.tests}
        self.records: Dict[str, Dict[str, Any]] = {}
        self.fixture_events: List[Dict[str, Any]] = []
        self.printer = printer
        self._t0: Dict[str, float] = {}

    # -- per test ----------------------------------------------------------
    def _rec(self, test) -> Dict[str, Any]:
        tid = test.id()
        rec = self.records.get(tid)
        if rec is None:
            rec = {"id": tid, "status": "RUNNING", "messages": [], "duration_ms": 0.0}
            self.records[tid] = rec
        return rec

    @staticmethod
    def _owner(test):
        # unittest.case._SubTest -> the test it belongs to
        return getattr(test, "test_case", test)

    def startTest(self, test):
        super().startTest(test)
        self._t0[test.id()] = time.perf_counter()
        self._rec(test)
        if self.printer:
            self.printer.start(test)

    def stopTest(self, test):
        super().stopTest(test)
        rec = self._rec(test)
        rec["duration_ms"] = (time.perf_counter() - self._t0.get(test.id(), time.perf_counter())) * 1000.0
        if rec["status"] == "RUNNING":
            rec["status"] = "ERROR"
            rec["messages"].append("test finished without reporting an outcome")
        if self.printer:
            self.printer.finish(test, rec)

    def _set(self, test, status: str, message: Optional[str]):
        rec = self._rec(self._owner(test))
        rank = {"RUNNING": 0, "PASS": 1, "XFAIL": 1, "SKIP": 2, "FAIL": 3, "ERROR": 4}
        if rank[status] >= rank[rec["status"]]:
            rec["status"] = status
        if message:
            label = str(test) if test is not self._owner(test) else ""
            rec["messages"].append((label + "\n" if label else "") + message)

    def addSuccess(self, test):
        super().addSuccess(test)
        self._set(test, "PASS", None)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._set(test, "FAIL", self._exc_info_to_string(err, test))

    def addError(self, test, err):
        if self._is_fixture(test):
            super().addError(test, err)
            self._fixture(test, "error", self._exc_info_to_string(err, test))
            return
        super().addError(test, err)
        self._set(test, "ERROR", self._exc_info_to_string(err, test))

    def addSkip(self, test, reason):
        if self._is_fixture(test):
            super().addSkip(test, reason)
            self._fixture(test, "skip", reason)
            return
        super().addSkip(test, reason)
        if test is not self._owner(test):
            self._rec(self._owner(test))["messages"].append(f"subtest skipped: {reason}")
            return
        self._set(test, "SKIP", reason)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._set(test, "XFAIL", "expected failure")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._set(test, "FAIL", "unexpected success (test marked expectedFailure passed)")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            status = "FAIL" if issubclass(err[0], test.failureException) else "ERROR"
            self._set(subtest, status, self._exc_info_to_string(err, test))

    # -- fixtures ------------------------------------------------------------
    @staticmethod
    def _is_fixture(test) -> bool:
        return not hasattr(test, "_testMethodName") and not hasattr(test, "test_case")

    def _fixture(self, holder, kind: str, message: str):
        desc = str(getattr(holder, "description", holder))
        m = _FIXTURE_RE.match(desc)
        fixture, target = (m.group(1), m.group(2)) if m else ("fixture", desc)
        event = {"fixture": fixture, "target": target, "kind": kind, "message": message}
        self.fixture_events.append(event)
        affected: List[SuiteInfo] = []
        if target in self.by_strclass:
            affected = [self.by_strclass[target]]
        else:
            affected = [s for s in self.suites
                        if s.cls.__module__ == target or short_module(s.cls.__module__) == target]
        for s in affected:
            if fixture.startswith("setUp"):
                if kind == "skip":
                    s.class_skip = s.class_skip or f"{fixture}: {message}"
                else:
                    s.class_error = s.class_error or f"{fixture}: {message}"
            else:
                s.teardown_error = s.teardown_error or f"{fixture}: {message}"
        if self.printer:
            self.printer.fixture(event, affected)


class LivePrinter:
    """Streams one line per test and a header per suite while the run is in progress."""

    def __init__(self, suites: List[SuiteInfo], stream=sys.stdout):
        self.stream = stream
        self.by_test_id = {t.id(): s for s in suites for t in s.tests}
        self.current: Optional[SuiteInfo] = None

    def _header(self, suite: SuiteInfo):
        if suite is not self.current:
            self.current = suite
            print(f"\n-- {suite.name}  [{suite.scope}]  {suite.planned} test(s)", file=self.stream)

    def start(self, test):
        s = self.by_test_id.get(test.id())
        if s:
            self._header(s)

    def finish(self, test, rec):
        s = self.by_test_id.get(test.id())
        method = getattr(test, "_testMethodName", str(test))
        tid, desc = test_meta(s.module, s.cls, method) if s else ("", test.id())
        print(f"   {rec['status']:<6}{rec['duration_ms']:10.1f} ms  {tid:<10} {desc}", file=self.stream)
        if rec["status"] == "SKIP" and rec["messages"]:
            print(f"   {'':<32}skipped: {rec['messages'][-1]}", file=self.stream)
        self.stream.flush()

    def fixture(self, event, affected: List[SuiteInfo]):
        for s in affected:
            self._header(s)
            what = "SKIPPED" if event["kind"] == "skip" else "ERROR"
            note = f"{s.planned} test(s) not run" if event["fixture"].startswith("setUp") else "after tests"
            first = event["message"].strip().splitlines()[-1] if event["message"].strip() else ""
            print(f"   CLASS {what} in {event['fixture']} ({note}): {first}", file=self.stream)
        self.stream.flush()


# ----------------------------------------------------------------------------
# Accounting
# ----------------------------------------------------------------------------

def account(suites: List[SuiteInfo], result: TrackingResult,
            module_errors: List[Dict[str, str]]) -> Dict[str, Any]:
    counts = {k: 0 for k in ("planned", "executed", "passed", "failed", "errors", "skipped",
                             "expected_failures", "not_run", "classes", "classes_skipped",
                             "classes_skipped_tests", "classes_errored", "classes_errored_tests",
                             "teardown_errors", "not_run_other")}
    suite_rows = []
    tests = []
    for s in suites:
        row = {"module": s.module, "class": s.cls.__name__, "scope": s.scope, "planned": s.planned,
               "executed": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0,
               "expected_failures": 0, "not_run": 0, "class_skip": s.class_skip,
               "class_error": s.class_error, "teardown_error": s.teardown_error}
        for t in s.tests:
            rec = result.records.get(t.id())
            method = getattr(t, "_testMethodName", str(t))
            tid, desc = test_meta(s.module, s.cls, method)
            entry = {"name": f"{s.module}.{s.cls.__name__}.{method}", "id": tid or None,
                     "description": desc, "module": s.module, "class": s.cls.__name__, "method": method,
                     "scope": s.test_scopes.get(method, s.scope),
                     "status": "NOT_RUN", "duration_ms": 0.0, "message": None}
            if rec is None:
                row["not_run"] += 1
                entry["message"] = s.class_skip or s.class_error or "not run"
            else:
                row["executed"] += 1
                entry["status"] = rec["status"]
                entry["duration_ms"] = round(rec["duration_ms"], 2)
                entry["message"] = "\n".join(rec["messages"]) or None
                key = {"PASS": "passed", "FAIL": "failed", "ERROR": "errors", "SKIP": "skipped",
                       "XFAIL": "expected_failures"}[rec["status"]]
                row[key] += 1
            tests.append(entry)
        suite_rows.append(row)
        counts["classes"] += 1
        for k in ("planned", "executed", "passed", "failed", "errors", "skipped", "expected_failures",
                  "not_run"):
            counts[k] += row[k]
        if row["not_run"]:
            if s.class_error:
                counts["classes_errored"] += 1
                counts["classes_errored_tests"] += row["not_run"]
            elif s.class_skip:
                counts["classes_skipped"] += 1
                counts["classes_skipped_tests"] += row["not_run"]
            else:
                counts["not_run_other"] += row["not_run"]
        elif s.class_error:
            counts["classes_errored"] += 1
        if s.teardown_error:
            counts["teardown_errors"] += 1
    counts["module_import_errors"] = len(module_errors)
    skipped_suites = [r for r in suite_rows if r["skipped"] or r["not_run"]]
    counts["suites_skipped"] = len(skipped_suites)
    return {"counts": counts, "suites": suite_rows, "tests": tests}


def required_suite_status(module_names: List[str], imported: List[str],
                          suite_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for label, patterns in REQUIRED_SUITES:
        mods = [m for m in module_names if any(re.fullmatch(p, m) for p in patterns)]
        rows = [r for r in suite_rows if r["module"] in mods]
        if not mods:
            state, detail = "missing", "no matching test module"
        elif not all(m in imported for m in mods):
            state, detail = "import_error", "module failed to import"
        elif not rows:
            state, detail = "empty", "module defines no tests"
        elif any(r["failed"] or r["errors"] or r["class_error"] for r in rows):
            state, detail = "failed", "failures or errors"
        elif any(r["skipped"] or r["not_run"] for r in rows):
            state, detail = "incomplete", "tests skipped or not run"
        else:
            state, detail = "ok", f"{sum(r['passed'] for r in rows)} passed"
        out.append({"suite": label, "modules": mods, "state": state, "detail": detail})
    return out


def release_problems(summary: Dict[str, Any], tools: Dict[str, Dict[str, Any]],
                     required: List[Dict[str, Any]], build: Optional[build_state.BuildRecord],
                     repo_git: Dict[str, Any], foreign_firmware: bool) -> List[str]:
    c = summary["counts"]
    problems = []
    if c["failed"] or c["errors"]:
        problems.append(f"{c['failed']} failed / {c['errors']} errored tests")
    if c["module_import_errors"]:
        problems.append(f"{c['module_import_errors']} test module(s) failed to import")
    if c["skipped"]:
        problems.append(f"{c['skipped']} test(s) skipped")
    if c["classes_skipped"]:
        problems.append(f"{c['classes_skipped']} class(es) skipped ({c['classes_skipped_tests']} tests not run)")
    if c["classes_errored"]:
        problems.append(f"{c['classes_errored']} class(es) errored in fixtures")
    if c["not_run_other"]:
        problems.append(f"{c['not_run_other']} test(s) not run")
    if c["teardown_errors"]:
        problems.append(f"{c['teardown_errors']} class/module teardown error(s)")
    for name in REQUIRED_TOOLS:
        if not tools.get(name, {}).get("found"):
            problems.append(f"required tool missing: {name}")
    for r in required:
        if r["state"] != "ok":
            problems.append(f"required suite '{r['suite']}' {r['state']} ({r['detail']})")
    if build is None:
        problems.append("the firmware build did not run")
    else:
        if build.skipped_reason:
            problems.append(f"firmware build skipped: {build.skipped_reason}")
        elif not build.ok:
            problems.append("firmware build failed")
        problems += [f"build: {p}" for p in build.release_problems]
    if foreign_firmware:
        problems.append(f"{build_state.ENV_FIRMWARE_DIR} points outside this repository")
    if repo_git.get("commit") is None:
        problems.append("not a git checkout (release needs a commit to qualify)")
    elif repo_git.get("dirty"):
        problems.append(f"git working tree is dirty ({len(repo_git.get('dirty_files', []))} path(s))")
    return problems


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--release", action="store_true", help="release gating: any skip or gap fails")
    ap.add_argument("--json", metavar="PATH", help="write a machine-readable summary")
    ap.add_argument("--clean", action="store_true", help="pio run -t clean before building")
    ap.add_argument("--list", action="store_true", help="list suites without running them")
    return ap.parse_args(argv)


def _rule(ch="="):
    return ch * 96


def run(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    if args.release:
        os.environ[build_state.ENV_RELEASE] = "1"
    if args.clean:
        os.environ[build_state.ENV_CLEAN] = "1"
    mode = "release" if build_state.release_mode() else "diagnostic"
    started = time.time()

    tools = detect_tools()
    repo_git = build_state.git_state(PROJECT_ROOT)
    fw_dir = build_state.firmware_dir()
    foreign = build_state.using_foreign_firmware_dir()

    print(_rule())
    print("  DRIFTPAD TEST RUNNER")
    print(_rule())
    print(f"  Mode             : {mode}")
    print(f"  Python           : {sys.version.split()[0]} ({sys.executable})")
    print(f"  Project root     : {PROJECT_ROOT}")
    print(f"  Git              : {repo_git.get('commit') or 'not a git checkout'}"
          f"{' (dirty working tree)' if repo_git.get('dirty') else ''}")
    print(f"  Firmware built   : {fw_dir}{'  [DRIFTPAD_FIRMWARE_DIR override]' if foreign else ''}")
    print(f"  Host C++         : {tools['host_cxx']['detail']}")
    print(f"  Headless browser : {tools['browser']['detail']}")
    print(f"  PlatformIO       : {tools['platformio']['detail']}")
    if build_state.project_conf():
        print(f"  PIO project conf : {build_state.project_conf()}")
    print(f"  Timestamp        : {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(started))}")
    print(_rule())

    loader = unittest.TestLoader()
    module_names = discover_module_names()
    suites: List[SuiteInfo] = []
    module_errors: List[Dict[str, str]] = []
    imported: List[str] = []
    for name in module_names:
        try:
            module = importlib.import_module(f"tests.{name}")
        except BaseException as e:  # a half-written module must not stop the others
            if isinstance(e, KeyboardInterrupt):
                raise
            module_errors.append({"module": name, "error": traceback.format_exc()})
            continue
        imported.append(name)
        suites.extend(load_module_suites(module, loader))

    if args.list:
        for s in suites:
            print(f"{s.name:<60} {s.planned:>4} test(s)  [{s.scope}]")
        for e in module_errors:
            print(f"{e['module']:<60} IMPORT ERROR")
        return 1 if module_errors else 0

    for e in module_errors:
        last = e["error"].strip().splitlines()[-1]
        print(f"\n-- {e['module']}  IMPORT ERROR: {last}")

    top = unittest.TestSuite(unittest.TestSuite(s.tests) for s in suites)
    result = TrackingResult(suites, printer=LivePrinter(suites))
    top.run(result)
    elapsed = time.time() - started

    summary = account(suites, result, module_errors)
    c = summary["counts"]
    required = required_suite_status(module_names, imported, summary["suites"])
    build = build_state.current()
    problems = release_problems(summary, tools, required, build, repo_git, foreign) if mode == "release" else []

    # -- Report ----------------------------------------------------------------
    print("\n" + _rule())
    print("  SUMMARY")
    print(_rule("-"))
    print(f"  Discovered : {c['planned']} tests in {c['classes']} classes from {len(imported)} modules"
          f" ({len(module_errors)} module(s) failed to import)")
    print(f"  Executed   : {c['executed']}  ->  {c['passed']} passed, {c['failed']} failed, "
          f"{c['errors']} errors, {c['skipped']} skipped"
          + (f", {c['expected_failures']} expected failures" if c["expected_failures"] else ""))
    print(f"  Not run    : {c['not_run']}  ({c['classes_skipped']} classes skipped: "
          f"{c['classes_skipped_tests']} tests not run; {c['classes_errored']} classes errored: "
          f"{c['classes_errored_tests']} tests not run"
          + (f"; {c['not_run_other']} other" if c["not_run_other"] else "") + ")")

    by_scope: Dict[str, Dict[str, int]] = {}
    for t in summary["tests"]:
        d = by_scope.setdefault(t["scope"], {"total": 0, "PASS": 0})
        d["total"] += 1
        d["PASS"] += t["status"] == "PASS"
    print("  By scope   : " + "; ".join(f"{k}: {v['PASS']}/{v['total']} passed" for k, v in by_scope.items()))
    print("  Hardware   : no suite in this run exercises a physical DriftPad (hardware acceptance is separate)")

    skipped_rows = [r for r in summary["suites"] if r["skipped"] or r["not_run"]]
    if skipped_rows:
        print(_rule("-"))
        print("  SKIPPED / NOT RUN")
        for r in skipped_rows:
            reason = r["class_skip"] or r["class_error"]
            if not reason:
                reasons = {t["message"] for t in summary["tests"]
                           if t["module"] == r["module"] and t["class"] == r["class"] and t["status"] == "SKIP"}
                reason = "; ".join(sorted(m for m in reasons if m))
            n = r["skipped"] + r["not_run"]
            print(f"  - {r['module']}.{r['class']} [{r['scope']}]: {n} test(s): "
                  f"{(reason or '').strip().splitlines()[-1] if reason else ''}")
    missing_required = [r for r in required if r["state"] in ("missing", "import_error", "empty")]
    if missing_required:
        print(_rule("-"))
        print("  REQUIRED SUITES NOT AVAILABLE")
        for r in missing_required:
            print(f"  - {r['suite']}: {r['state']} ({r['detail']})")

    print(_rule("-"))
    print("  BUILD EVIDENCE")
    if build is None:
        print("  - the firmware build did not run in this process")
    else:
        print(f"  - firmware dir : {build.firmware_dir}")
        print(f"  - PlatformIO   : {build.pio_how or 'n/a'}{' (clean build)' if build.clean else ''}")
        state = ("skipped: " + build.skipped_reason) if build.skipped_reason else (
            f"exit {build.returncode}, {'SUCCESS' if build.ok else 'FAILED'}, {build.duration_s} s")
        print(f"  - build        : started {build.started_utc}, {state}")
        if build.removed_stale:
            print(f"  - removed stale before build: {', '.join(build.removed_stale)}")
        if build.manifest:
            m = build.manifest
            print(f"  - manifest     : fw {m.get('fw_version')}, build {m.get('build_id')}, "
                  f"git_dirty={m.get('git_dirty')}")
        elif build.ok:
            print("  - manifest     : none")
        for w in build.warnings:
            print(f"  - WARNING: {w}")

    failed_tests = [t for t in summary["tests"] if t["status"] in ("FAIL", "ERROR")]
    if failed_tests or module_errors or any(r["class_error"] or r["teardown_error"] for r in summary["suites"]):
        print(_rule("-"))
        print("  FAILURE DETAILS")
        for t in failed_tests:
            print(f"\n--- {t['status']}: {t['name']} ---\n{t['message']}")
        for r in summary["suites"]:
            for k in ("class_error", "teardown_error"):
                if r[k]:
                    print(f"\n--- CLASS ERROR: {r['module']}.{r['class']} ---\n{r[k]}")
        for e in module_errors:
            print(f"\n--- IMPORT ERROR: {e['module']} ---\n{e['error']}")

    has_failures = bool(c["failed"] or c["errors"] or module_errors or c["classes_errored"]
                        or c["teardown_errors"])
    print("\n" + _rule())
    print(f"  TOTAL ELAPSED TIME: {elapsed:.2f} s")
    if mode == "release":
        if problems:
            verdict = "RELEASE_CHECKS_FAILED"
            print(f"  VERDICT: RELEASE CHECKS FAILED ({len(problems)} problem(s))")
            for p in problems:
                print(f"    - {p}")
        else:
            verdict = "RELEASE_CHECKS_PASSED"
            print("  VERDICT: RELEASE CHECKS PASSED (automated suites only; physical hardware "
                  "acceptance is not covered by this run)")
        exit_code = 1 if problems else 0
    else:
        verdict = "FAILED" if has_failures else "PASSED_DIAGNOSTIC"
        print(f"  VERDICT: {'FAILED' if has_failures else 'no failures'} "
              f"({c['failed']} failed, {c['errors']} errors, {len(module_errors)} import errors)")
        exit_code = 1 if has_failures else 0
    print(_rule())
    if mode != "release":
        reasons = [f"{c['suites_skipped']} suites skipped"]
        if missing_required:
            reasons.append(f"{len(missing_required)} required suites unavailable")
        reasons.append("diagnostic mode (use --release)")
        print("NOT RELEASE-QUALIFIED: " + ", ".join(reasons))

    if args.json:
        doc = {
            "schema": RESULT_SCHEMA,
            "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
            "elapsed_s": round(elapsed, 2),
            "mode": mode,
            "verdict": verdict,
            "exit_code": exit_code,
            "release_problems": problems,
            "hardware_exercised": False,
            "python": {"version": sys.version.split()[0], "executable": sys.executable,
                       "platform": platform.platform()},
            "repo": {"root": str(PROJECT_ROOT), **repo_git},
            "firmware_dir": str(fw_dir),
            "firmware_dir_override": foreign,
            "tools": tools,
            "counts": c,
            "required_suites": required,
            "suites": summary["suites"],
            "tests": summary["tests"],
            "module_errors": module_errors,
            "fixture_events": result.fixture_events,
            "build": build.to_dict() if build else None,
        }
        out = Path(args.json)
        if out.parent and not out.parent.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(doc, indent=2, default=str), encoding="utf-8")
        print(f"JSON summary written to {out}")
    return exit_code


if __name__ == "__main__":
    sys.exit(run())
