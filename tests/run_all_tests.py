"""
run_all_tests.py - Master Automated Test Runner for DriftPad Macropad.

Authoritative References:
- ORIGINAL_REQUEST.md: Requirements R1, R2, R3, and Acceptance Criteria
- spec_verification_harness.md: Sections 6, 9, 10
- PROJECT.md: Milestone M1 Test Suite Harness

Pure Python 3 standard library: zero external pip dependencies.
"""

import sys
import time
import unittest
from pathlib import Path
from typing import List, Dict, Any

# Ensure tests package and project root are in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Import individual test modules
import test_dsp_harness
import test_build
import test_config_schema
import test_firmware_parity


class TableTestResult(unittest.TestResult):
    """Custom TestResult that captures timing and status for each test."""

    def __init__(self):
        super().__init__()
        self.records: List[Dict[str, Any]] = []
        self._current_start_time: float = 0.0

    def startTest(self, test):
        super().startTest(test)
        self._current_start_time = time.perf_counter()

    def addSuccess(self, test):
        super().addSuccess(test)
        elapsed = (time.perf_counter() - self._current_start_time) * 1000.0
        self.records.append({
            "test": test,
            "status": "PASS",
            "elapsed_ms": elapsed,
            "err": None
        })

    def addFailure(self, test, err):
        super().addFailure(test, err)
        elapsed = (time.perf_counter() - self._current_start_time) * 1000.0
        self.records.append({
            "test": test,
            "status": "FAIL",
            "elapsed_ms": elapsed,
            "err": err
        })

    def addError(self, test, err):
        super().addError(test, err)
        elapsed = (time.perf_counter() - self._current_start_time) * 1000.0
        self.records.append({
            "test": test,
            "status": "ERROR",
            "elapsed_ms": elapsed,
            "err": err
        })

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        elapsed = (time.perf_counter() - self._current_start_time) * 1000.0
        self.records.append({
            "test": test,
            "status": "SKIP",
            "elapsed_ms": elapsed,
            "err": reason
        })


def get_test_metadata(test_method_name: str, docstring: str) -> Dict[str, str]:
    """Extract human-readable ID and short description."""
    doc = (docstring or "").strip().split("\n")[0]
    
    # Check if method contains explicit TC-xx
    if "tc01" in test_method_name:
        return {"id": "TC-01", "cat": "DSP RT", "desc": "RT Reversal Accuracy (0.20mm)"}
    elif "tc02" in test_method_name:
        return {"id": "TC-02", "cat": "DSP RT", "desc": "RT Reversal Accuracy (0.15mm)"}
    elif "tc03" in test_method_name:
        return {"id": "TC-03", "cat": "DSP RT", "desc": "RT Reversal Accuracy (0.10mm)"}
    elif "tc04" in test_method_name:
        return {"id": "TC-04", "cat": "DSP RT", "desc": "RT Min Sens (0.10mm) Depth Sweep"}
    elif "tc05" in test_method_name:
        return {"id": "TC-05", "cat": "DSP RT", "desc": "RT Multi-Velocity Sweep"}
    elif "tc06" in test_method_name:
        return {"id": "TC-06", "cat": "DSP Noise", "desc": "10s Rest with 60Hz EMI"}
    elif "tc07" in test_method_name:
        return {"id": "TC-07", "cat": "DSP Noise", "desc": "5s Held Key Sub-RT Jitter"}
    elif "tc08" in test_method_name:
        return {"id": "TC-08", "cat": "DSP Noise", "desc": "5s Released Sub-RT Jitter"}
    elif "tc09" in test_method_name:
        return {"id": "TC-09", "cat": "DSP Latency", "desc": "Actuation Response Latency"}
    elif "tc10" in test_method_name:
        return {"id": "TC-10", "cat": "DSP Latency", "desc": "RT Release Response Latency"}
    elif "tc11" in test_method_name:
        return {"id": "TC-11", "cat": "DSP Drift", "desc": "+100 Counts Baseline Drift"}
    elif "tc12" in test_method_name:
        return {"id": "TC-12", "cat": "DSP Drift", "desc": "-100 Counts Baseline Drift"}
    elif "tc13" in test_method_name:
        return {"id": "TC-13", "cat": "Build", "desc": "PlatformIO Clean Build"}
    elif "tc14" in test_method_name:
        return {"id": "TC-14", "cat": "Serial", "desc": "WebSerial Command Parser"}
    elif "tc15" in test_method_name:
        return {"id": "TC-15", "cat": "Profile", "desc": "3-Layer JSON Roundtrip"}
    elif "polarity_auto" in test_method_name:
        return {"id": "TC-P1", "cat": "DSP Model", "desc": "Polarity Auto-Detection"}
    elif "simulated_travel" in test_method_name:
        return {"id": "TC-S1", "cat": "DSP Model", "desc": "Direct Travel Injection"}
    elif "sinusoid" in test_method_name:
        return {"id": "TC-W1", "cat": "Waveform", "desc": "Sinusoid Waveform Generator"}
    elif "triangle" in test_method_name:
        return {"id": "TC-W2", "cat": "Waveform", "desc": "Triangle Ramp Generator"}
    elif "noise_injection" in test_method_name:
        return {"id": "TC-W3", "cat": "Waveform", "desc": "Noise & EMI Statistics"}
    elif "uf2_artifact" in test_method_name:
        return {"id": "TC-B1", "cat": "Artifact", "desc": "UF2 Binary Artifact Exists"}
    elif "elf_and_bin" in test_method_name:
        return {"id": "TC-B2", "cat": "Artifact", "desc": "ELF & BIN Artifacts Exist"}
    elif "header_and_magic" in test_method_name:
        return {"id": "TC-B3", "cat": "Artifact", "desc": "UF2 Magic & RP2040 Family ID"}
    elif "zero_external" in test_method_name:
        return {"id": "TC-C1", "cat": "Config", "desc": "Configurator Zero-CDN Check"}
    elif "adversarial" in test_method_name:
        return {"id": "TC-C2", "cat": "Config", "desc": "Adversarial Schema Rejection"}
    elif "tc16" in test_method_name:
        return {"id": "TC-16", "cat": "DSP RT Noise", "desc": "RT Reversals with Active Noise"}
    elif "clamped_to_floor" in test_method_name:
        return {"id": "TC-S2", "cat": "DSP Model", "desc": "RT Sensitivity Floor Clamp"}
    elif test_method_name.startswith("test_adv0"):
        adv = {
            "1": "RT Floor Chatter, 20-count EMI",
            "2": "RT Floor Chatter, EMI + Thermal",
            "3": "Auto-Zero Boot Negative Step",
            "4": "Auto-Zero Positive Step",
            "5": "Auto-Zero Finger Rest Freeze",
        }
        n = test_method_name[len("test_adv0")]
        return {"id": f"ADV-0{n}", "cat": "Adversarial", "desc": adv.get(n, test_method_name)}
    elif "identical_key_events" in test_method_name:
        return {"id": "FW-SYNC", "cat": "FW Parity", "desc": "hall.cpp vs Model Key Events"}
    elif "constants_match" in test_method_name:
        return {"id": "FW-CONST", "cat": "FW Parity", "desc": "hall.h vs Model Constants"}
    else:
        clean_name = test_method_name.replace("test_", "")[:32]
        return {"id": "UNIT", "cat": "Unit", "desc": clean_name}


def run_all() -> int:
    """Run complete test suite and print formatted results table."""
    print("=" * 86)
    print("  DRIFTPAD 16-KEY HALL-EFFECT RAPID TRIGGER MACROPAD // AUTOMATED TEST HARNESS")
    print("=" * 86)
    print(f"  Python Version : {sys.version.split()[0]} ({sys.executable})")
    print(f"  Project Root   : {PROJECT_ROOT}")
    print(f"  Timestamp      : {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    print("=" * 86)

    suite = unittest.TestSuite()
    loader = unittest.TestLoader()

    # Load all test cases in deterministic order
    suite.addTests(loader.loadTestsFromTestCase(test_dsp_harness.TestDSPHarness))
    suite.addTests(loader.loadTestsFromTestCase(test_build.TestPlatformIOBuild))
    suite.addTests(loader.loadTestsFromTestCase(test_config_schema.TestConfigSchema))
    # Same DSP suites against firmware/src/hall.cpp compiled for the host (skipped without g++/clang++)
    suite.addTests(loader.loadTestsFromTestCase(test_firmware_parity.TestFirmwareModelLockstep))
    suite.addTests(loader.loadTestsFromTestCase(test_firmware_parity.TestDSPHarnessOnFirmware))
    suite.addTests(loader.loadTestsFromTestCase(test_firmware_parity.TestAdversarialOnFirmware))

    table_result = TableTestResult()
    start_time = time.perf_counter()
    suite.run(table_result)
    total_time_s = time.perf_counter() - start_time

    # Print Table
    header = f"{'Test ID':<9} | {'Category':<12} | {'Description':<36} | {'Duration':<10} | {'Status'}"
    print(header)
    print("-" * 86)

    for rec in table_result.records:
        test = rec["test"]
        method_name = getattr(test, "_testMethodName", None)
        if method_name is None:
            # Class-level skip or error (e.g. parity tests without a host C++ compiler):
            # unittest reports it as an _ErrorHolder with only a description
            meta = {"id": "CLASS", "cat": "Setup", "desc": str(test)}
        else:
            doc = getattr(test, method_name).__doc__ or ""
            meta = get_test_metadata(method_name, doc)
        if type(test).__name__.endswith("OnFirmware"):
            meta = {"id": "FW " + meta["id"], "cat": "FW Parity", "desc": meta["desc"]}
        
        status = rec["status"]
        elapsed_str = f"{rec['elapsed_ms']:6.1f} ms"
        status_display = f"[{status}]"

        desc_truncated = meta['desc'][:36]
        print(f"{meta['id']:<9} | {meta['cat']:<12} | {desc_truncated:<36} | {elapsed_str:<10} | {status_display}")

    print("=" * 86)
    total_tests = table_result.testsRun
    failures = len(table_result.failures)
    errors = len(table_result.errors)
    skipped = len(table_result.skipped)
    passed = total_tests - failures - errors - skipped

    print(f"  SUMMARY: {total_tests} Tests Run | {passed} Passed | {failures} Failed | {errors} Errors | {skipped} Skipped")
    print(f"  TOTAL ELAPSED TIME: {total_time_s:.2f} seconds")
    
    if failures == 0 and errors == 0:
        print("  VERDICT: ALL ACCEPTANCE TESTS PASSED (100% SUCCESS)")
        print("=" * 86)
        return 0
    else:
        print("  VERDICT: TEST SUITE FAILED")
        print("=" * 86)
        for failure in table_result.failures:
            print(f"\n--- FAILURE: {failure[0]} ---")
            print(failure[1])
        for error in table_result.errors:
            print(f"\n--- ERROR: {error[0]} ---")
            print(error[1])
        return 1


if __name__ == "__main__":
    sys.exit(run_all())
