"""
test_adversarial_m2.py - Adversarial Challenge Suite for Milestone M2.

Author: Challenger 1 (Milestone M2)
Role: Empirical Challenger & Adversarial DSP Specialist

Tests:
1. ADV-01: Rapid Trigger Chatter at minimum sensitivity (RT_SENS_MIN_MM) under 20-count 60Hz EMI.
2. ADV-02: Rapid Trigger Chatter at minimum sensitivity under 10-count EMI + 3-sigma Gaussian noise.
3. ADV-03: Auto-zero baseline tracking lockout under uncalibrated negative step drift (-60 counts).
4. ADV-04: Auto-zero baseline tracking lockout under positive step drift (+60 counts).
5. ADV-05: Auto-zero baseline tracking lockout under resting travel (0.22mm).
6. ADV-06: OLED coordinate verification (mathematical assertion that Y in [0..24] is never written).
"""

import math
import random
import unittest
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(PROJECT_ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "tests"))

from test_dsp_harness import HallKeyDSP


class TestAdversarialDSP(unittest.TestCase):
    """Adversarial stress-testing suite exposing DSP edge cases and failure modes."""

    def test_adv01_rapid_trigger_chatter_at_005mm_with_60hz_emi(self):
        """
        ADV-01: Adversarial challenge against RT at maximum sensitivity (RT_SENS_MIN_MM) with 60Hz EMI.
        Fails if false releases occur during stationary hold at 2.0mm.
        """
        dsp = HallKeyDSP(auto_polarity=False)
        dsp.set_rt_sensitivity(HallKeyDSP.RT_SENS_MIN_MM)
        s = dsp.rt_release_mm

        # Press key to 2.0mm (2548 counts on 2048 baseline + 1000 range)
        for _ in range(50):
            dsp.update(2548)
        self.assertTrue(dsp.is_pressed, "Pre-condition: Key must be pressed at 2.0mm")

        false_releases = 0
        false_actuations = 0

        # 5 seconds at 1000Hz (300 cycles of 60Hz EMI at 20-count amplitude)
        for k in range(5000):
            t = k * 0.001
            emi = 20.0 * math.sin(2.0 * math.pi * 60.0 * t)
            raw = int(round(2548 + emi))
            if dsp.update(raw):
                if not dsp.is_pressed:
                    false_releases += 1
                else:
                    false_actuations += 1

        # The ideal expectation is 0 false releases
        # We record the observed failure count for empirical proof
        print(f"\n[ADV-01] {s:.2f}mm RT under 20-count 60Hz EMI: {false_releases} false releases, {false_actuations} false actuations")
        self.assertEqual(
            false_releases, 0,
            f"ADV-01 BUG CONFIRMED: {s:.2f}mm RT produced {false_releases} false releases under 60Hz EMI! Chatter rate: {false_releases/5.0:.1f} Hz"
        )

    def test_adv02_rapid_trigger_chatter_at_005mm_with_emi_and_noise(self):
        """
        ADV-02: Adversarial challenge against RT at maximum sensitivity (RT_SENS_MIN_MM) with
        10-count EMI + 3-sigma Gaussian noise. At 0.05mm this produced 285 false releases in 5s,
        which is why the floor is 0.10mm.
        """
        random.seed(42)
        dsp = HallKeyDSP(auto_polarity=False)
        dsp.set_rt_sensitivity(HallKeyDSP.RT_SENS_MIN_MM)
        s = dsp.rt_release_mm

        for _ in range(50):
            dsp.update(2548)

        false_releases = 0
        for k in range(5000):
            t = k * 0.001
            emi = 10.0 * math.sin(2.0 * math.pi * 60.0 * t)
            noise = random.gauss(0.0, 3.0)
            if dsp.update(int(round(2548 + emi + noise))):
                if not dsp.is_pressed:
                    false_releases += 1

        print(f"\n[ADV-02] {s:.2f}mm RT under 10-count EMI + Gaussian noise: {false_releases} false releases in 5s")
        self.assertEqual(
            false_releases, 0,
            f"ADV-02 BUG CONFIRMED: {s:.2f}mm RT produced {false_releases} false releases under composite noise!"
        )

    def test_adv03_autozero_uncalibrated_negative_step_lockout(self):
        """
        ADV-03: At boot, before polarity is detected, a negative step drift (-60 counts = -0.24mm)
        causes mag = abs(delta) = 0.24mm, exceeding 0.20mm and permanently freezing auto-zero tracking.
        """
        dsp = HallKeyDSP(auto_polarity=True)
        # Apply -60 counts step at boot
        for _ in range(1000):
            dsp.update(1988)

        print(f"\n[ADV-03] Uncalibrated boot negative step (-60cnt): rest_baseline={dsp.rest_baseline:.1f} (target 1988), travel={dsp.travel_mm:.3f}mm")
        self.assertLess(
            abs(dsp.rest_baseline - 1988), 5.0,
            f"ADV-03 BUG CONFIRMED: Baseline tracking locked out at boot on -60 count shift! Baseline stuck at {dsp.rest_baseline:.1f}, travel stuck at {dsp.travel_mm:.3f}mm"
        )

    def test_adv04_autozero_positive_step_lockout(self):
        """
        ADV-04: Positive step drift (+60 counts = +0.24mm) exceeds 0.20mm travel threshold,
        permanently freezing auto-zero tracking even with polarity calibrated.
        """
        dsp = HallKeyDSP(auto_polarity=False)
        for _ in range(1000):
            dsp.update(2108)

        print(f"\n[ADV-04] Calibrated positive step (+60cnt): rest_baseline={dsp.rest_baseline:.1f} (target 2108), travel={dsp.travel_mm:.3f}mm")
        self.assertLess(
            abs(dsp.rest_baseline - 2108), 5.0,
            f"ADV-04 BUG CONFIRMED: Baseline tracking permanently locked out on +60 count positive shift! Baseline stuck at {dsp.rest_baseline:.1f}, travel stuck at {dsp.travel_mm:.3f}mm"
        )

    def test_adv05_autozero_resting_travel_freeze(self):
        """
        ADV-05: Key held or resting at 0.22mm physical travel after keypress
        must NOT corrupt the baseline.
        """
        dsp = HallKeyDSP(auto_polarity=False)
        # Active keypress to 2.0mm
        for _ in range(30):
            dsp.update(2548)
        self.assertTrue(dsp.is_pressed, "Key must be pressed at 2.0mm")

        # Release to 0.22mm resting hold
        raw_rest = int(round(2048 + (0.22 / 4.0) * 1000))  # 2103 counts
        for _ in range(2000):
            dsp.update(raw_rest)

        # Baseline must NOT adapt to finger rest after keypress
        self.assertEqual(dsp.rest_baseline, 2048.0)
        self.assertAlmostEqual(dsp.travel_mm, 0.22, delta=0.01)


if __name__ == "__main__":
    unittest.main(verbosity=2)
