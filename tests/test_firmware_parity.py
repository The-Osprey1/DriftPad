"""
test_firmware_parity.py - Catches drift between firmware/src/hall.cpp and the HallKeyDSP model.

Compiles the real HallKey implementation for the host (with stub Arduino headers from
tests/firmware_host/) into a shared library, then:

1. Runs the full DSP acceptance suite (TC-01..TC-16) and the adversarial suite (ADV-01..05)
   against the compiled firmware instead of the Python model.
2. Feeds identical ADC streams through both and requires identical KeyDown/KeyUp events.

Skipped when no host C++ compiler (g++, clang++ or c++, or $CXX) is on PATH.

Pure Python 3 standard library: zero external pip dependencies.
"""

import ctypes
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import List, Optional, Tuple

TESTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = TESTS_DIR.parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from test_dsp_harness import (
    HallKeyDSP, TestDSPHarness, generate_directional_reversals, generate_sinusoid,
    inject_noise_and_emi,
)
from test_adversarial_m2 import TestAdversarialDSP

FIRMWARE_DIR = PROJECT_ROOT / "firmware"
HOST_DIR = TESTS_DIR / "firmware_host"

_lib: Optional[ctypes.CDLL] = None
_build_error: Optional[str] = None
_build_dir: Optional[str] = None


def _find_compiler() -> Optional[str]:
    candidates = [os.environ.get("CXX"), "g++", "clang++", "c++"]
    for c in candidates:
        if c and shutil.which(c):
            return shutil.which(c)
    return None


def _build_library() -> ctypes.CDLL:
    """Compile hall.cpp + hall_shim.cpp into a host shared library (once per process)."""
    global _lib, _build_error, _build_dir
    if _lib is not None:
        return _lib
    if _build_error is not None:
        raise unittest.SkipTest(_build_error)

    cxx = _find_compiler()
    if cxx is None:
        _build_error = "No host C++ compiler found (set CXX or install g++/clang++); firmware parity not checked"
        raise unittest.SkipTest(_build_error)

    _build_dir = tempfile.mkdtemp(prefix="driftpad_hall_")
    suffix = ".dll" if os.name == "nt" else (".dylib" if sys.platform == "darwin" else ".so")
    out = os.path.join(_build_dir, "hallkey" + suffix)
    cmd = [
        cxx, "-std=c++17", "-O2", "-shared", "-fPIC",
        # RP2040 (Cortex-M0+) has no FMA; keep host float math unfused to match
        "-ffp-contract=off",
        "-I", str(HOST_DIR), "-I", str(FIRMWARE_DIR / "include"),
        str(FIRMWARE_DIR / "src" / "hall.cpp"), str(HOST_DIR / "hall_shim.cpp"),
        "-o", out,
    ]
    if os.name == "nt":
        cmd += ["-static-libgcc", "-static-libstdc++"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # A compile failure is a real regression in hall.cpp/hall.h, not a missing tool
        raise AssertionError(f"Host build of hall.cpp failed:\n{' '.join(cmd)}\n{result.stderr}")

    lib = ctypes.CDLL(out)
    vp, i, f = ctypes.c_void_p, ctypes.c_int, ctypes.c_float
    sigs = {
        "hk_create": ([i], vp), "hk_destroy": ([vp], None),
        "hk_update": ([vp, i], i), "hk_inject": ([vp, f], i),
        "hk_set_actuation": ([f], None), "hk_set_rt_sens": ([f], None),
        "hk_set_rt_enabled": ([i], None),
        "hk_rt_press_mm": ([], f), "hk_rt_release_mm": ([], f), "hk_actuation_mm": ([], f),
        "hk_rt_sens_min_mm": ([], f), "hk_rt_sens_max_mm": ([], f),
        "hk_is_pressed": ([vp], i), "hk_travel_mm": ([vp], f),
        "hk_rest_baseline": ([vp], f), "hk_filtered_raw": ([vp], f),
        "hk_polarity_detected": ([vp], i), "hk_voltage_increases": ([vp], i),
        "hk_unpressed_samples": ([vp], i),
    }
    for name, (args, res) in sigs.items():
        fn = getattr(lib, name)
        fn.argtypes = args
        fn.restype = res
    _lib = lib
    return lib


class FirmwareHallKey:
    """HallKeyDSP-compatible wrapper around the compiled firmware HallKey.

    The firmware keeps actuation/RT settings in statics shared by all keys, so each new
    instance resets them to the defaults, mirroring a fresh HallKeyDSP.
    """

    RT_SENS_MIN_MM: float = float("nan")
    RT_SENS_MAX_MM: float = float("nan")

    def __init__(self, key_index: int = 0, rest_baseline: int = 2048,
                 dynamic_range: float = 1000.0, auto_polarity: bool = True):
        if rest_baseline != 2048 or dynamic_range != 1000.0:
            raise ValueError("HallKey::init() always starts at baseline 2048, range 1000")
        self._lib = _build_library()
        self._k = self._lib.hk_create(1 if auto_polarity else 0)

    def __del__(self):
        k = getattr(self, "_k", None)
        if k:
            self._lib.hk_destroy(k)
            self._k = None

    def update(self, raw_adc: float) -> bool:
        # The ADC delivers integers; round fractional synthetic samples like the hardware would
        return bool(self._lib.hk_update(self._k, int(round(raw_adc))))

    def inject_simulated_travel(self, mm: float) -> bool:
        return bool(self._lib.hk_inject(self._k, mm))

    def set_actuation_point(self, mm: float) -> None:
        self._lib.hk_set_actuation(mm)

    def set_rapid_trigger(self, enabled: bool) -> None:
        self._lib.hk_set_rt_enabled(1 if enabled else 0)

    def set_rt_sensitivity(self, mm: float) -> None:
        self._lib.hk_set_rt_sens(mm)

    def get_travel_mm(self) -> float:
        return self.travel_mm

    @property
    def is_pressed(self) -> bool: return bool(self._lib.hk_is_pressed(self._k))
    @property
    def travel_mm(self) -> float: return self._lib.hk_travel_mm(self._k)
    @property
    def rest_baseline(self) -> float: return self._lib.hk_rest_baseline(self._k)
    @property
    def filtered_raw(self) -> float: return self._lib.hk_filtered_raw(self._k)
    @property
    def polarity_detected(self) -> bool: return bool(self._lib.hk_polarity_detected(self._k))
    @property
    def voltage_increases_on_press(self) -> bool: return bool(self._lib.hk_voltage_increases(self._k))
    @property
    def unpressed_samples(self) -> int: return self._lib.hk_unpressed_samples(self._k)
    @property
    def rt_press_mm(self) -> float: return self._lib.hk_rt_press_mm()
    @property
    def rt_release_mm(self) -> float: return self._lib.hk_rt_release_mm()
    @property
    def actuation_point_mm(self) -> float: return self._lib.hk_actuation_mm()


def _load_firmware_constants() -> None:
    lib = _build_library()
    FirmwareHallKey.RT_SENS_MIN_MM = lib.hk_rt_sens_min_mm()
    FirmwareHallKey.RT_SENS_MAX_MM = lib.hk_rt_sens_max_mm()


class _AgainstFirmware:
    """Mixin: run an existing TestCase's methods with HallKeyDSP swapped for the firmware."""

    @classmethod
    def setUpClass(cls):
        _load_firmware_constants()
        super().setUpClass()

    def setUp(self):
        # Patch the module the inherited test methods resolve HallKeyDSP from
        self._patched_module = sys.modules[self._source_module]
        self._orig_dsp = self._patched_module.HallKeyDSP
        self._patched_module.HallKeyDSP = FirmwareHallKey
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self._patched_module.HallKeyDSP = self._orig_dsp


class TestDSPHarnessOnFirmware(_AgainstFirmware, TestDSPHarness):
    """TC-01..TC-16 executed against the compiled firmware/src/hall.cpp."""
    _source_module = TestDSPHarness.__module__


class TestAdversarialOnFirmware(_AgainstFirmware, TestAdversarialDSP):
    """ADV-01..ADV-05 executed against the compiled firmware/src/hall.cpp."""
    _source_module = TestAdversarialDSP.__module__


# ----------------------------------------------------------------------------
# Lockstep model vs firmware comparison
# ----------------------------------------------------------------------------

def _mm_to_adc(wave: List[float], baseline: float = 2048.0, sign: float = 1.0) -> List[int]:
    return [int(round(baseline + sign * (x / 4.0) * 1000.0)) for x in wave]


def _run(dsp, samples: List[int]) -> Tuple[List[Tuple[int, bool]], List[float]]:
    events: List[Tuple[int, bool]] = []
    travel: List[float] = []
    for n, s in enumerate(samples):
        if dsp.update(s):
            events.append((n, dsp.is_pressed))
        travel.append(dsp.get_travel_mm())
    return events, travel


def _scenarios() -> List[Tuple[str, bool, float, List[int]]]:
    """(name, auto_polarity, rt_sensitivity_mm, adc_samples)."""
    sc: List[Tuple[str, bool, float, List[int]]] = []

    for s_rt, spp in [(0.10, 6), (0.10, 10), (0.20, 10), (0.50, 16)]:
        wave, _ = generate_directional_reversals(40, s_rt * 1.05, 2.0, spp)
        sc.append((f"reversals clean {s_rt}mm/{spp}spp", False, s_rt, _mm_to_adc(wave)))

    wave, _ = generate_directional_reversals(50, 0.25, 2.0, 12)
    sc.append(("reversals + EMI/thermal", False, 0.15,
               inject_noise_and_emi(wave, a60=15.0, a120=0.0, sigma_thermal=1.0, seed=7)))

    # Full-travel taps with re-press shortly after release (the chatter-guard regression)
    wave = generate_sinusoid(8.0, 1.0) + generate_sinusoid(25.0, 0.4)
    sc.append(("full-travel sinusoid taps", True, 0.20,
               inject_noise_and_emi(wave, a60=10.0, a120=3.0, sigma_thermal=2.0, seed=11)))

    # Inverted polarity sensor
    wave = generate_sinusoid(5.0, 1.0, amplitude_mm=1.5, offset_mm=1.6)
    sc.append(("inverted polarity taps", True, 0.20, _mm_to_adc(wave, sign=-1.0)))

    # Held key and released-hold with 60Hz EMI
    for depth in (2.0, 0.0):
        wave = [depth] * 3000
        sc.append((f"hold {depth}mm + EMI", False, 0.10,
                   inject_noise_and_emi(wave, a60=20.0, a120=5.0, sigma_thermal=3.0, seed=3)))

    # Baseline drift, then a keystroke
    drift = [int(round(2048 + 100.0 * min(1.0, k / 500.0))) for k in range(1000)]
    press = [int(round(2148 + (min(3.0, 0.05 * k) / 4.0) * 1000)) for k in range(200)]
    sc.append(("drift then press", True, 0.20, drift + press))

    random.seed(5)
    walk, x = [], 0.0
    for _ in range(4000):
        x = max(0.0, min(4.0, x + random.uniform(-0.08, 0.08)))
        walk.append(x)
    sc.append(("random walk", False, 0.10,
               inject_noise_and_emi(walk, a60=8.0, a120=2.0, sigma_thermal=1.5, seed=9)))
    return sc


class TestFirmwareModelLockstep(unittest.TestCase):
    """Same ADC stream through HallKeyDSP and the compiled firmware must yield the same key events."""

    # float32 (firmware) vs float64 (model) rounding accumulates in the auto-zero baseline;
    # allow up to one ADC count (4.0mm / 1000 counts)
    TRAVEL_TOL_MM = 0.004

    @classmethod
    def setUpClass(cls):
        _load_firmware_constants()

    def test_constants_match(self):
        self.assertAlmostEqual(FirmwareHallKey.RT_SENS_MIN_MM, HallKeyDSP.RT_SENS_MIN_MM, places=6)
        self.assertAlmostEqual(FirmwareHallKey.RT_SENS_MAX_MM, HallKeyDSP.RT_SENS_MAX_MM, places=6)
        fw, model = FirmwareHallKey(), HallKeyDSP()
        self.assertEqual(fw.unpressed_samples, model.unpressed_samples, "Initial _unpressedSamples differs")
        self.assertAlmostEqual(fw.rt_press_mm, model.rt_press_mm, places=6)
        self.assertAlmostEqual(fw.actuation_point_mm, model.actuation_point_mm, places=6)

    def test_identical_key_events(self):
        for name, auto_pol, s_rt, samples in _scenarios():
            with self.subTest(scenario=name):
                model = HallKeyDSP(auto_polarity=auto_pol)
                model.set_rt_sensitivity(s_rt)
                fw = FirmwareHallKey(auto_polarity=auto_pol)
                fw.set_rt_sensitivity(s_rt)

                ev_m, tr_m = _run(model, samples)
                ev_f, tr_f = _run(fw, samples)

                if not name.startswith("hold"):
                    self.assertGreater(len(ev_m), 0, f"{name}: scenario produced no key events")
                if ev_m != ev_f:
                    first = next((i for i, (a, b) in enumerate(zip(ev_m, ev_f)) if a != b),
                                 min(len(ev_m), len(ev_f)))
                    self.fail(
                        f"{name}: key events diverge at event #{first}: "
                        f"model={ev_m[first:first + 3]} firmware={ev_f[first:first + 3]} "
                        f"(model {len(ev_m)} events, firmware {len(ev_f)})"
                    )
                worst = max(abs(a - b) for a, b in zip(tr_m, tr_f))
                self.assertLess(worst, self.TRAVEL_TOL_MM, f"{name}: travel diverges by {worst:.5f}mm")


if __name__ == "__main__":
    unittest.main(verbosity=2)
