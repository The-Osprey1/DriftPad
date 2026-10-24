"""
test_challenger1_dsp.py - Adversarial DSP, Timing & Mathematical Model Verification Suite.

Challenger 1 (Timing, Cycle Budget & DSP Challenger)
Empirical verification and stress testing of ARCHITECTURAL_BLUEPRINT.md:
1. Cycle Budget & Timing on Cortex-M0+ (133 MHz, no hardware FPU)
2. Dual-Window Tremor Variance Discrimination & Step Drift (+60 counts)
3. Rapid Trigger Deadband Hierarchy & Quantization Tolerance
4. DKS Directional Hysteresis & Low R2 Deadband Trapping
5. SOCD Engine Last Priority Timestamp Edge-Trigger Bug
"""

import math
import random
import unittest
from typing import List, Tuple, Optional


# ============================================================================
# C++ Models Replicated Directly from ARCHITECTURAL_BLUEPRINT.md Section 2.6
# ============================================================================

class BlueprintAdaptiveBaselineFilter:
    """Exact Python mirror of AdaptiveBaselineFilter in Section 2.6."""

    TRACKING_RATE_NEG = 0.05
    MAX_STEP_NEG = 2.0
    TRACKING_RATE_POS = 0.005
    TREMOR_VARIANCE_FLOOR = 1.44  # (1.2 counts)^2
    STATIONARY_DWELL_SAMPLES = 3000
    MAX_POSITIVE_DRIFT_MM = 0.60
    CALIB_TOLERANCE_COUNTS = 40

    def __init__(self, boot_rest_raw: int = 2000, range_counts: int = 1000, polarity_positive: bool = True):
        self.baseline = float(boot_rest_raw)
        self.calibrated_rest = boot_rest_raw
        self.range_counts = max(range_counts, 600)
        self.polarity_positive = polarity_positive
        self.stationary_samples = 0
        self.prev_raw = boot_rest_raw
        self.variance_accum = 0.0
        self.is_compensating = False
        self.drift_exceeded = False

    def update(self, raw_adc: int, filtered_raw: float, is_pressed: bool, travel_mm: float) -> float:
        raw_diff = float(raw_adc) - float(self.prev_raw)
        self.prev_raw = raw_adc

        diff_sq = raw_diff * raw_diff
        self.variance_accum = 0.95 * self.variance_accum + 0.05 * diff_sq

        excursion = (filtered_raw - self.baseline) if self.polarity_positive else (self.baseline - filtered_raw)

        if excursion < 0.0:
            err = excursion
            step = err * self.TRACKING_RATE_NEG
            step = max(-self.MAX_STEP_NEG, min(self.MAX_STEP_NEG, step))
            self.baseline += step if self.polarity_positive else -step
            self.is_compensating = True
            self.stationary_samples = 0
        else:
            if (not is_pressed and 
                travel_mm < self.MAX_POSITIVE_DRIFT_MM and 
                self.variance_accum < self.TREMOR_VARIANCE_FLOOR):
                if self.stationary_samples < self.STATIONARY_DWELL_SAMPLES:
                    self.stationary_samples += 1
                else:
                    self.baseline += self.TRACKING_RATE_POS if self.polarity_positive else -self.TRACKING_RATE_POS
                    self.is_compensating = True
            else:
                self.stationary_samples = 0
                self.is_compensating = False

        max_allowed = float(self.calibrated_rest + self.CALIB_TOLERANCE_COUNTS)
        min_allowed = float(max(0, self.calibrated_rest - self.CALIB_TOLERANCE_COUNTS))

        if self.baseline > max_allowed:
            self.baseline = max_allowed
            self.drift_exceeded = True
        elif self.baseline < min_allowed:
            self.baseline = min_allowed
            self.drift_exceeded = True
        else:
            self.drift_exceeded = False

        return self.baseline


class BlueprintSplitRapidTrigger:
    """Exact Python mirror of SplitRapidTrigger in Section 2.6."""

    TOP_DEADZONE_MM = 0.20

    def __init__(self, actuation_mm: float = 1.20, press_mm: float = 0.30, release_mm: float = 0.10, enabled: bool = True):
        self.actuation_mm = actuation_mm
        self.press_sens_mm = press_mm
        self.release_sens_mm = release_mm
        self.enabled = enabled
        self.is_pressed = False
        self.ever_actuated = False
        self.peak_depth_mm = 0.0
        self.valley_depth_mm = 0.0

    def update(self, travel_mm: float, dynamic_range_counts: float) -> bool:
        prev_state = self.is_pressed
        quant_tol = 0.85 * (4.0 / dynamic_range_counts)
        quant_tol = max(0.01, min(0.04, quant_tol))

        if not self.enabled:
            if not self.is_pressed and travel_mm >= self.actuation_mm:
                self.is_pressed = True
            elif self.is_pressed and travel_mm <= (self.actuation_mm - 0.10):
                self.is_pressed = False
            return self.is_pressed != prev_state

        if not self.is_pressed:
            if not self.ever_actuated:
                if travel_mm >= self.actuation_mm:
                    self.is_pressed = True
                    self.ever_actuated = True
                    self.peak_depth_mm = travel_mm
            else:
                if travel_mm < self.valley_depth_mm:
                    self.valley_depth_mm = travel_mm
                if travel_mm >= (self.valley_depth_mm + self.press_sens_mm - quant_tol) and travel_mm >= self.actuation_mm:
                    self.is_pressed = True
                    self.peak_depth_mm = travel_mm
                if travel_mm <= self.TOP_DEADZONE_MM:
                    self.ever_actuated = False
                    self.valley_depth_mm = 0.0
                    self.peak_depth_mm = 0.0
        else:
            if travel_mm > self.peak_depth_mm:
                self.peak_depth_mm = travel_mm
            if travel_mm <= (self.peak_depth_mm - (self.release_sens_mm - quant_tol)) or travel_mm <= self.TOP_DEADZONE_MM:
                self.is_pressed = False
                self.valley_depth_mm = travel_mm

        return self.is_pressed != prev_state


class BlueprintSocdEngine:
    """Exact Python mirror of SocdEngine in Section 2.6."""

    def __init__(self):
        self.mode = 2  # LastPriority
        self.key_a = 0
        self.key_b = 1
        self.hyst_cmm = 5
        self.last_winner = -1
        self.last_press_time = [0, 0]

    def configure(self, key_a: int, key_b: int, mode: int, hyst_cmm: int = 5):
        self.key_a = key_a
        self.key_b = key_b
        self.mode = mode
        self.hyst_cmm = hyst_cmm
        self.last_winner = -1
        self.last_press_time = [0, 0]

    def process(self, travel_mm: List[float], physical_mask: int, now_ms: int) -> Tuple[int, int]:
        routed_mask = physical_mask
        act_a = bool(physical_mask & (1 << self.key_a))
        act_b = bool(physical_mask & (1 << self.key_b))

        if act_a and not act_b:
            self.last_winner = self.key_a
            self.last_press_time[0] = now_ms
        elif not act_a and act_b:
            self.last_winner = self.key_b
            self.last_press_time[1] = now_ms
        elif act_a and act_b:
            winner = -1
            hyst_mm = float(self.hyst_cmm) / 100.0

            if self.mode == 3:  # DepthPriority
                diff = travel_mm[self.key_a] - travel_mm[self.key_b]
                if diff >= hyst_mm:
                    winner = self.key_a
                elif diff <= -hyst_mm:
                    winner = self.key_b
                else:
                    winner = self.last_winner if self.last_winner >= 0 else (self.key_a if diff >= 0.0 else self.key_b)
            elif self.mode == 2:  # LastPriority
                winner = self.key_a if (self.last_press_time[0] >= self.last_press_time[1]) else self.key_b
            elif self.mode == 4:  # FirstPriority
                winner = self.key_a if (self.last_press_time[0] <= self.last_press_time[1]) else self.key_b
            else:  # Neutral
                winner = -1

            self.last_winner = winner
            if winner == self.key_a:
                routed_mask &= ~(1 << self.key_b)
            elif winner == self.key_b:
                routed_mask &= ~(1 << self.key_a)
            else:
                routed_mask &= ~(1 << self.key_a)
                routed_mask &= ~(1 << self.key_b)
        else:
            self.last_winner = -1

        return routed_mask, self.last_winner


class BlueprintDksEngine:
    """Exact Python mirror of DksEngine in Section 2.6."""

    HYSTERESIS_MM = 0.08

    def __init__(self, p1: float, p2: float, r1: float, r2: float):
        self.p1 = p1
        self.p2 = p2
        self.r1 = r1
        self.r2 = r2
        self.stage = 0  # 0=Idle, 1=Stage1Pressed, 2=Stage2Pressed
        self.events = []

    def update(self, travel_mm: float):
        if self.stage == 0:
            if travel_mm >= self.p1:
                self.stage = 1
                self.events.append("P1")
        elif self.stage == 1:
            if travel_mm >= self.p2:
                self.stage = 2
                self.events.append("P2")
            elif travel_mm <= (self.r2 - self.HYSTERESIS_MM):
                self.stage = 0
                self.events.append("R2")
        elif self.stage == 2:
            if travel_mm <= (self.r1 - self.HYSTERESIS_MM):
                self.stage = 1
                self.events.append("R1")


# ============================================================================
# Adversarial Challenge Tests
# ============================================================================

class TestChallenger1Adversarial(unittest.TestCase):

    def test_challenge_01_positive_step_recovery_time_and_clamping(self):
        """
        Adversarial Test 1: Validate claim that a +60 count (+0.24mm) step drift
        recovers within 30-60 ms.
        Result: Fails blueprint claim.
        1. Adaptation dwell requires 3000 ms of stillness before starting.
        2. Adaptation rate is 0.005 counts/scan = 5.0 counts/sec -> requires 12,000 ms to move 60 counts.
           Total time = 15,000 ms (15.0 seconds), NOT 30-60 ms (250x-500x slower).
        3. Hard boundary CALIB_TOLERANCE_COUNTS = 40 clamps baseline at +40 counts,
           leaving 20 counts (0.08 mm) permanent resting error and drift_exceeded=True!
        """
        filt = BlueprintAdaptiveBaselineFilter(boot_rest_raw=2000, range_counts=1000)
        
        # Step input: raw jumps to 2060 (+60 counts)
        step_raw = 2060
        travel_step = (60.0 / 1000.0) * 4.0  # 0.24 mm
        
        # Run for 60 ms (60 scans) - blueprint claims recovery in 30-60 ms
        for _ in range(60):
            filt.update(step_raw, float(step_raw), is_pressed=False, travel_mm=travel_step)
            
        # At 60 ms, baseline has NOT adapted at all because dwell requires 3000 ms
        self.assertEqual(filt.baseline, 2000.0, "At 60 ms, baseline must not have adapted due to 3000 ms dwell requirement")
        
        # Now run up to 3000 ms (end of dwell)
        for _ in range(3000 - 60):
            filt.update(step_raw, float(step_raw), is_pressed=False, travel_mm=travel_step)
        self.assertEqual(filt.baseline, 2000.0, "At 3000 ms, baseline has just finished dwell")
        
        # Run for another 12,000 scans (total 15,000 ms = 15 seconds)
        for _ in range(12000):
            filt.update(step_raw, float(step_raw), is_pressed=False, travel_mm=travel_step)
            
        # Observe the clamping: CALIB_TOLERANCE_COUNTS = 40 clamps maxAllowed = 2040.0
        self.assertEqual(filt.baseline, 2040.0, "Baseline is prematurely clamped at +40 counts, cannot reach 2060 (+60 counts)")
        self.assertTrue(filt.drift_exceeded, "drift_exceeded flag is permanently raised")
        
        # Residual travel error:
        residual_travel = ((2060.0 - filt.baseline) / 1000.0) * 4.0
        self.assertAlmostEqual(residual_travel, 0.08, delta=0.001,
                               msg="0.08mm phantom resting travel persists permanently due to CALIB_TOLERANCE_COUNTS = 40")

    def test_challenge_02_emi_locks_out_positive_autozero(self):
        """
        Adversarial Test 2: Dual-window tremor variance threshold (TREMOR_VARIANCE_FLOOR = 1.44)
        is evaluated directly on raw ADC differences (raw_diff = raw_adc - prev_raw).
        Ambient 60 Hz EMI produces sinusoidal raw_diff whose variance exceeds 1.44,
        permanently locking out positive baseline tracking even when key is completely untouched!
        """
        filt = BlueprintAdaptiveBaselineFilter(boot_rest_raw=2000, range_counts=1000)
        
        # Simulate 10-count 60 Hz EMI on untouched key at 1000 Hz:
        # raw[n] = 2020 + 10 * sin(2*pi*60*t)
        # filtered_raw will be filtered, but raw_adc has EMI
        for k in range(5000):
            t = k * 0.001
            emi = 10.0 * math.sin(2.0 * math.pi * 60.0 * t)
            raw = int(round(2020 + emi))
            filt.update(raw, 2020.0, is_pressed=False, travel_mm=0.08)
            
        # Check variance accumulator
        # Theoretical E[diff^2] for 10-count 60Hz EMI sampled at 1kHz:
        # diff = 10 * 2*pi*(60/1000) * cos(...) = 3.77 * cos(...)
        # E[diff^2] = 0.5 * 3.77^2 = 7.11 counts^2 >> 1.44
        self.assertGreater(filt.variance_accum, 5.0, "Variance accumulator must reflect EMI derivative amplitude")
        self.assertGreater(filt.variance_accum, filt.TREMOR_VARIANCE_FLOOR,
                           "Variance exceeds tremor floor (1.44) solely due to 60Hz EMI!")
        self.assertEqual(filt.stationary_samples, 0,
                         "Stationary sample counter is permanently held at 0 due to EMI!")
        self.assertEqual(filt.baseline, 2000.0,
                         "Positive drift tracking is completely locked out by 60Hz EMI!")

    def test_challenge_03_quant_tol_reduces_release_hysteresis_causing_chatter(self):
        """
        Adversarial Test 3: Rapid Trigger quantization tolerance deadband formula
        `_peakDepthMm - (_releaseSensMm - quantTol)` reduces effective release threshold,
        making RT MORE sensitive to noise instead of protecting against single-count dithering.
        """
        # Range = 800 counts -> quant_tol = 0.85 * (4.0 / 800) = 0.00425 -> clamped to 0.01 mm
        rt = BlueprintSplitRapidTrigger(actuation_mm=1.20, press_mm=0.30, release_mm=0.10, enabled=True)
        
        # Press key to 2.00 mm
        rt.update(1.20, 800)
        rt.update(2.00, 800)
        self.assertTrue(rt.is_pressed)
        self.assertEqual(rt.peak_depth_mm, 2.00)
        
        # Effective release threshold is 2.00 - (0.10 - 0.01) = 1.91 mm (0.09 mm upward travel),
        # NOT 1.90 mm (0.10 mm upward travel)!
        # So upward bounce to 1.905 mm (0.095 mm upward) triggers release even though configured release is 0.10 mm!
        changed = rt.update(1.905, 800)
        self.assertTrue(changed, "Key released at 0.095mm travel because quantTol reduced release distance requirement")
        self.assertFalse(rt.is_pressed)

    def test_challenge_04_missing_bottom_deadzone_triggers_bounce_release(self):
        """
        Adversarial Test 4: Section 2.3 specified a 0.15 mm bottom deadzone clamping peak ratcheting
        in 3.85-4.00 mm to absorb bottom-out bounce.
        The C++ class in Section 2.6 omitted this clamping, allowing peak to ratchet to 4.00 mm.
        Mechanical stem bounce of 0.12 mm at bottom-out (travel drops to 3.88 mm) immediately
        triggers a false release at the very bottom of the keypress!
        """
        rt = BlueprintSplitRapidTrigger(actuation_mm=1.20, press_mm=0.30, release_mm=0.10, enabled=True)
        
        # Key penetrates to full bottom-out 4.00 mm
        rt.update(4.00, 1000)
        self.assertTrue(rt.is_pressed)
        self.assertEqual(rt.peak_depth_mm, 4.00)
        
        # Mechanical stem bounces upward by 0.12 mm to 3.88 mm (within bottom 0.15 mm)
        # If bottom deadzone were implemented, peak would clamp to 3.85 mm and 3.88 mm would NOT release.
        # Without bottom deadzone: 3.88 <= 4.00 - (0.10 - 0.01) = 3.91 mm -> false release!
        changed = rt.update(3.88, 1000)
        self.assertTrue(changed, "Stem bounce at bottom-out triggered a false release because bottom deadzone clamping was omitted")
        self.assertFalse(rt.is_pressed)

    def test_challenge_05_dks_r2_below_deadzone_traps_stage1(self):
        """
        Adversarial Test 5: Section 2.5 validation allows 0.20 mm <= R2 < R1.
        If R2 = 0.25 mm, then with HYSTERESIS_MM = 0.08 mm, the release threshold is:
        r2 - 0.08 = 0.17 mm.
        If mechanical rest settles at 0.18 mm (inside TOP_DEADZONE_MM 0.20 mm),
        the key can NEVER reach <= 0.17 mm, remaining trapped in Stage 1 forever!
        """
        # P1 = 1.00, P2 = 3.00, R1 = 2.80, R2 = 0.25 (valid per Section 2.5: 0.20 <= R2)
        dks = BlueprintDksEngine(p1=1.00, p2=3.00, r1=2.80, r2=0.25)
        
        # Press key to 1.50 mm (Stage 1 triggered)
        dks.update(1.50)
        self.assertEqual(dks.stage, 1)
        self.assertEqual(dks.events, ["P1"])
        
        # Release key towards rest: settles at 0.18 mm (physical rest with slight spring tolerance)
        for _ in range(100):
            dks.update(0.18)
            
        # Stage is STILL 1! R2 never fired!
        self.assertEqual(dks.stage, 1, "Key is permanently trapped in Stage 1 pressed state")
        self.assertNotIn("R2", dks.events, "R2 action was never emitted")

    def test_challenge_06_socd_last_priority_edge_detection_bug(self):
        """
        Adversarial Test 6: In SocdEngine::process(), timestamps are only updated when
        exactly ONE key is pressed ((actA && !actB) or (!actA && actB)).
        When Key A is already held down and Key B is subsequently pressed, the condition
        (actA && actB) is met on Key B's press scan, bypassing timestamp recording.
        Key B retains a stale timestamp from a prior press, causing Key A to win priority
        even though Key B was pressed most recently!
        """
        socd = BlueprintSocdEngine()
        socd.configure(key_a=0, key_b=1, mode=2)  # Mode 2 = LastPriority
        
        # Prior state: Key B was pressed alone at t=500 ms, then released at t=600 ms
        socd.process([0.0]*16, 0x02, now_ms=500)  # B pressed
        self.assertEqual(socd.last_press_time[1], 500)
        socd.process([0.0]*16, 0x00, now_ms=600)  # B released
        
        # Later: Key A is pressed alone at t=1000 ms
        socd.process([0.0]*16, 0x01, now_ms=1000)  # A pressed
        self.assertEqual(socd.last_press_time[0], 1000)
        
        # Now at t=1050 ms, Key B is pressed while Key A remains held (physical_mask = 0x03)
        # Expected Last Input Priority behavior: Key B should win because it was pressed at t=1050 ms!
        routed_mask, winner = socd.process([0.0]*16, 0x03, now_ms=1050)
        
        # Observed bug: last_press_time[1] was NOT updated to 1050! It remains 500!
        # Because 1000 >= 500, Key A is declared the winner!
        self.assertEqual(socd.last_press_time[1], 500, "Key B press timestamp was not updated at t=1050")
        self.assertEqual(winner, 0, "Bug reproduced: Key A erroneously wins LastPriority over newly pressed Key B")
        self.assertEqual(routed_mask, 0x01, "Mask routes Key A instead of newly pressed Key B")


if __name__ == "__main__":
    unittest.main()
