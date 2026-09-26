"""
test_dsp_harness.py - Reference DSP Engine and Rapid Trigger Automated Test Harness for DriftPad.

Authoritative References:
- ORIGINAL_REQUEST.md: Requirements R1 (Firmware DSP), R3 (Automated DSP Harness), Acceptance Criteria
- spec_verification_harness.md: Sections 2, 3, 4, 5, 6
- PROJECT.md: Milestone M1 Test Suite Harness

Pure Python 3 standard library: zero external pip dependencies.
"""

import math
import random
import unittest
from dataclasses import dataclass
from typing import List, Tuple, Dict, Any, Optional


# ============================================================================
# 1. Reference DSP Engine: HallKeyDSP
# ============================================================================

class HallKeyDSP:
    """
    Bit-accurate reference implementation of the RP2040 HallKey DSP pipeline.
    
    Models:
    - 12-bit ADC raw acquisition (0..4095 counts)
    - Velocity-adaptive low-pass filter (suppresses 60Hz EMI while minimizing stroke lag)
    - Magnetic polarity auto-detection and dynamic range calibration
    - Baseline auto-zero drift compensation
    - Directional hysteresis & Rapid Trigger peak/valley ratchet state machine
    """

    SWITCH_TOTAL_TRAVEL_MM: float = 4.0
    TOP_DEADZONE_MM: float = 0.20
    BOTTOM_DEADZONE_MM: float = 0.15
    REST_DRIFT_THRESHOLD_MM: float = 0.15

    def __init__(
        self,
        key_index: int = 0,
        rest_baseline: int = 2048,
        dynamic_range: float = 1000.0,
        auto_polarity: bool = True
    ):
        self.key_index: int = key_index
        self.rest_baseline: float = float(rest_baseline)
        self.filtered_raw: float = float(rest_baseline)
        self.current_raw: int = rest_baseline
        self.bottom_raw: float = float(rest_baseline + dynamic_range)
        self.dynamic_range: float = float(dynamic_range)
        
        self.polarity_detected: bool = not auto_polarity
        self.voltage_increases_on_press: bool = True
        
        self.travel_mm: float = 0.0
        self.peak_depth_mm: float = 0.0
        self.valley_depth_mm: float = 0.0
        
        self.is_pressed: bool = False
        self.ever_actuated: bool = False
        
        # Configuration settings
        self.actuation_point_mm: float = 1.20
        self.rt_press_mm: float = 0.20
        self.rt_release_mm: float = 0.20
        self.rt_enabled: bool = True

        # Adaptive filter parameters
        self.alpha_min: float = 0.18
        self.alpha_max: float = 0.95
        self.v_thresh: float = 2.0
        self.prev_raw: float = float(rest_baseline)
        self.d_hist: List[float] = [0.0] * 18
        self.d_idx: int = 0
        self.raw_hist: List[float] = [2048.0] * 18
        self.h_idx: int = 0
        self.swung_pos: bool = False
        self.swung_neg: bool = False

        # Auto-zero baseline tracking parameters
        self.beta: float = 0.20
        self.max_step: float = 2.0
        self.drift_travel: float = 0.0
        self.baseline_err_filt: float = 0.0

        # Held state sample counters and adaptive noise envelope
        self.press_samples: int = 0
        self.unpressed_samples: int = 100
        self.noise_env: float = 0.0
        self.stationary_unpressed_ms: int = 0
        self.recovering_baseline: bool = False
        self.chatter_guard: int = 0
        self.motion_samples: int = 0
        self.human_contact: bool = False

    def calibrate_rest(self, sample: int) -> None:
        """Establish initial resting baseline calibration."""
        self.rest_baseline = float(sample)
        self.filtered_raw = float(sample)
        self.current_raw = sample
        self.prev_raw = float(sample)
        self.d_hist = [0.0] * 18
        self.d_idx = 0
        self.raw_hist = [float(sample)] * 18
        self.h_idx = 0
        self.swung_pos = False
        self.swung_neg = False
        self.drift_travel = 0.0
        self.baseline_err_filt = 0.0
        self.press_samples = 0
        self.unpressed_samples = 100
        self.noise_env = 0.0
        self.stationary_unpressed_ms = 0
        self.recovering_baseline = False
        self.chatter_guard = 0
        self.motion_samples = 0
        self.human_contact = False
        if self.rest_baseline < 2048:
            self.bottom_raw = self.rest_baseline + self.dynamic_range
        else:
            self.bottom_raw = self.rest_baseline - self.dynamic_range

    def set_actuation_point(self, mm: float) -> None:
        """Set fixed actuation point threshold in millimeters."""
        self.actuation_point_mm = max(0.25, min(3.80, mm))

    def set_rapid_trigger(self, enabled: bool) -> None:
        """Enable or disable Rapid Trigger dynamic actuation mode."""
        self.rt_enabled = enabled

    def set_rt_sensitivity(self, mm: float) -> None:
        """Set Rapid Trigger press and release turnaround sensitivity in millimeters."""
        clamped = max(0.05, min(2.00, mm))
        self.rt_press_mm = clamped
        self.rt_release_mm = clamped

    def get_travel_mm(self) -> float:
        """Get current calculated physical travel in millimeters."""
        return self.travel_mm

    def get_raw_adc(self) -> int:
        """Get latest raw ADC reading."""
        return self.current_raw

    def update(self, raw_adc: float) -> bool:
        """
        Process a new 12-bit ADC raw sample (0..4095).
        Returns True if a switch state change occurred (KeyDown or KeyUp).
        """
        raw_val = float(raw_adc)
        self.current_raw = int(round(raw_val))

        # 1. Instantaneous velocity and 60Hz EMI comb filter
        inst_v = abs(raw_val - self.prev_raw)
        self.prev_raw = raw_val

        self.raw_hist[self.h_idx] = raw_val
        raw8 = self.raw_hist[(self.h_idx - 8) % 18]
        raw9 = self.raw_hist[(self.h_idx - 9) % 18]
        self.h_idx = (self.h_idx + 1) % 18

        comb_val = 0.5 * (raw_val + (2.0 / 3.0) * raw8 + (1.0 / 3.0) * raw9)

        d0 = raw_val - self.filtered_raw
        d8 = self.d_hist[(self.d_idx - 8) % 18]
        d17 = self.d_hist[(self.d_idx - 17) % 18]
        self.d_hist[self.d_idx] = d0
        self.d_idx = (self.d_idx + 1) % 18

        corr8 = d0 * d8
        corr17 = d0 * d17

        is_held = (self.press_samples > 30) or (self.unpressed_samples > 30)

        is_releasing = False
        if self.is_pressed:
            if self.voltage_increases_on_press:
                is_releasing = (raw_val < self.filtered_raw - 1.5)
            else:
                is_releasing = (raw_val > self.filtered_raw + 1.5)
            if corr8 < -2.0:
                is_releasing = False

        if is_releasing:
            target_val = raw_val
            alpha = 0.95
        elif not self.is_pressed and (inst_v > 10.0 or abs(d0) > 22.0):
            target_val = raw_val
            alpha = 0.95
        elif is_held:
            target_val = comb_val
            alpha = 0.25
        else:
            target_val = raw_val
            alpha = 0.90

        self.filtered_raw += alpha * (target_val - self.filtered_raw)

        # 2. Polarity Detection
        delta = self.filtered_raw - self.rest_baseline
        if not self.polarity_detected and abs(delta) > 150:
            self.voltage_increases_on_press = (delta > 0)
            self.polarity_detected = True
            if self.voltage_increases_on_press:
                self.bottom_raw = self.rest_baseline + self.dynamic_range
            else:
                self.bottom_raw = self.rest_baseline - self.dynamic_range

        # 3. Magnetic Magnitude
        if self.polarity_detected:
            if self.voltage_increases_on_press:
                mag = delta if delta > 0 else 0.0
            else:
                mag = -delta if delta < 0 else 0.0
        else:
            mag = abs(delta)

        # 4. Dynamic Range Calibration
        dyn_range = abs(self.bottom_raw - self.rest_baseline)
        if dyn_range < 600.0:
            dyn_range = 600.0
        if self.polarity_detected and mag > dyn_range:
            dyn_range = mag
            if self.voltage_increases_on_press:
                self.bottom_raw = self.rest_baseline + dyn_range
            else:
                self.bottom_raw = self.rest_baseline - dyn_range
        self.dynamic_range = dyn_range

        # 5. Travel Conversion (0.00mm to 4.00mm)
        raw_mm = (mag / dyn_range) * self.SWITCH_TOTAL_TRAVEL_MM
        self.travel_mm = max(0.0, min(self.SWITCH_TOTAL_TRAVEL_MM, raw_mm))

        # Human contact approach velocity discriminator
        if inst_v >= 0.5:
            if self.motion_samples < 255:
                self.motion_samples += 1
            if self.motion_samples >= 3 and self.travel_mm > 0.15:
                self.human_contact = True
        elif inst_v < 0.2:
            self.motion_samples = 0

        if self.travel_mm < 0.10:
            self.human_contact = False

        # 6. Auto-Zero Resting Baseline Drift Tracking
        self.drift_travel += 0.05 * (self.travel_mm - self.drift_travel)
        motion_freeze = (not self.polarity_detected and inst_v >= 0.5)
        if self.travel_mm < 0.20 and self.drift_travel < self.REST_DRIFT_THRESHOLD_MM and not self.is_pressed and not motion_freeze:
            err = self.filtered_raw - self.rest_baseline
            self.baseline_err_filt += 0.04 * (err - self.baseline_err_filt)
            if abs(self.baseline_err_filt) > 0.01:
                step = math.copysign(
                    min(self.max_step, max(0.1, abs(self.baseline_err_filt) * self.beta)),
                    self.baseline_err_filt
                )
                self.rest_baseline += step

        # Unpressed stationary drift recovery for positive steps (>=0.20mm, <0.80mm)
        # Gated by not self.ever_actuated and not self.human_contact to isolate human finger rest
        if not self.is_pressed and not self.ever_actuated and not self.human_contact and inst_v < 0.5 and self.travel_mm < 0.80:
            if self.stationary_unpressed_ms < 65535:
                self.stationary_unpressed_ms += 1
            if self.stationary_unpressed_ms > 400 and self.travel_mm >= 0.20:
                self.recovering_baseline = True
        elif self.travel_mm >= 0.80 or inst_v >= 0.5 or self.ever_actuated or self.human_contact:
            self.stationary_unpressed_ms = 0

        if self.recovering_baseline:
            err = self.filtered_raw - self.rest_baseline
            step = math.copysign(min(self.max_step, max(0.1, abs(err) * self.beta)), err)
            self.rest_baseline += step
            if abs(self.filtered_raw - self.rest_baseline) < 0.5:
                self.recovering_baseline = False
                self.stationary_unpressed_ms = 0

        # State tracking and noise envelope estimation
        if self.is_pressed:
            if self.press_samples < 65535:
                self.press_samples += 1
            self.unpressed_samples = 0
        else:
            if self.unpressed_samples < 65535:
                self.unpressed_samples += 1
            self.press_samples = 0

        # 7. Rapid Trigger State Machine
        state_changed = False
        count_res_mm = self.SWITCH_TOTAL_TRAVEL_MM / self.dynamic_range
        quant_tol = 0.85 * count_res_mm

        if not self.is_pressed:
            should_actuate = False

            if not self.ever_actuated:
                # Initial press crossing fixed threshold
                if self.travel_mm >= self.actuation_point_mm:
                    should_actuate = True
            else:
                # Key already actuated in current stroke
                if self.rt_enabled:
                    if (self.travel_mm - self.valley_depth_mm >= self.rt_press_mm - quant_tol) and (self.travel_mm > self.TOP_DEADZONE_MM):
                        should_actuate = True
                else:
                    if self.travel_mm >= self.actuation_point_mm:
                        should_actuate = True

            if should_actuate:
                self.is_pressed = True
                self.peak_depth_mm = self.travel_mm
                self.ever_actuated = True
                self.press_samples = 0
                state_changed = True
            else:
                if self.travel_mm < self.valley_depth_mm:
                    self.valley_depth_mm = self.travel_mm
                if self.travel_mm <= self.TOP_DEADZONE_MM:
                    self.ever_actuated = False
                    self.valley_depth_mm = 0.0
        else:
            if self.travel_mm > self.peak_depth_mm:
                self.peak_depth_mm = self.travel_mm

            should_release = False

            if self.travel_mm <= self.TOP_DEADZONE_MM:
                should_release = True
            elif self.rt_enabled and (self.peak_depth_mm - self.travel_mm >= self.rt_release_mm - quant_tol):
                should_release = True
            elif not self.rt_enabled and (self.travel_mm < self.actuation_point_mm - 0.20):
                should_release = True

            if should_release:
                self.is_pressed = False
                self.valley_depth_mm = self.travel_mm
                self.unpressed_samples = 0
                state_changed = True

        return state_changed

    def inject_simulated_travel(self, mm: float) -> bool:
        """Bypass ADC acquisition and directly inject physical travel depth."""
        self.travel_mm = max(0.0, min(self.SWITCH_TOTAL_TRAVEL_MM, mm))
        state_changed = False
        count_res_mm = self.SWITCH_TOTAL_TRAVEL_MM / self.dynamic_range
        quant_tol = 0.85 * count_res_mm

        if not self.is_pressed:
            should_actuate = False
            if not self.ever_actuated:
                if self.travel_mm >= self.actuation_point_mm:
                    should_actuate = True
            else:
                if self.rt_enabled:
                    if (self.travel_mm - self.valley_depth_mm >= self.rt_press_mm - quant_tol) and (self.travel_mm > self.TOP_DEADZONE_MM):
                        should_actuate = True
                else:
                    if self.travel_mm >= self.actuation_point_mm:
                        should_actuate = True

            if should_actuate:
                self.is_pressed = True
                self.ever_actuated = True
                self.peak_depth_mm = self.travel_mm
                state_changed = True
            else:
                if self.travel_mm < self.valley_depth_mm:
                    self.valley_depth_mm = self.travel_mm
                if self.travel_mm <= self.TOP_DEADZONE_MM:
                    self.ever_actuated = False
                    self.valley_depth_mm = 0.0
        else:
            if self.travel_mm > self.peak_depth_mm:
                self.peak_depth_mm = self.travel_mm

            should_release = False
            if self.travel_mm <= self.TOP_DEADZONE_MM:
                should_release = True
            elif self.rt_enabled and (self.peak_depth_mm - self.travel_mm >= self.rt_release_mm - quant_tol):
                should_release = True
            elif not self.rt_enabled and (self.travel_mm < self.actuation_point_mm - 0.20):
                should_release = True

            if should_release:
                self.is_pressed = False
                self.valley_depth_mm = self.travel_mm
                state_changed = True

        return state_changed


# ============================================================================
# 2. Synthetic Waveform Generators
# ============================================================================

def generate_sinusoid(
    freq_hz: float,
    duration_s: float,
    sample_rate_hz: int = 1000,
    amplitude_mm: float = 2.0,
    offset_mm: float = 2.0
) -> List[float]:
    """
    Synthesize continuous sinusoidal switch travel waveform x(t).
    x(t) = offset_mm - amplitude_mm * cos(2*pi*f*t)
    For amplitude=2.0, offset=2.0: oscillates cleanly between 0.0mm and 4.0mm.
    """
    num_samples = int(duration_s * sample_rate_hz)
    wave: List[float] = []
    for k in range(num_samples):
        t = k / sample_rate_hz
        x = offset_mm - amplitude_mm * math.cos(2.0 * math.pi * freq_hz * t)
        wave.append(max(0.0, min(4.0, x)))
    return wave


def generate_triangle(
    v_press_mm_s: float,
    v_release_mm_s: float,
    max_travel_mm: float = 4.0,
    sample_rate_hz: int = 1000
) -> List[float]:
    """
    Synthesize linear triangle travel ramp:
    - Press phase: ramps down from 0.0 to max_travel_mm at v_press_mm_s
    - Release phase: ramps up from max_travel_mm to 0.0 at v_release_mm_s
    """
    t_down = max_travel_mm / v_press_mm_s
    t_up = max_travel_mm / v_release_mm_s
    n_down = int(t_down * sample_rate_hz)
    n_up = int(t_up * sample_rate_hz)

    wave: List[float] = []
    for k in range(n_down):
        t = k / sample_rate_hz
        wave.append(min(max_travel_mm, v_press_mm_s * t))
    for k in range(n_up):
        t = k / sample_rate_hz
        wave.append(max(0.0, max_travel_mm - v_release_mm_s * t))
    wave.append(0.0)
    return wave


@dataclass
class ReversalCycle:
    cycle_index: int
    t_rev_start_s: float
    t_press_start_s: float
    reversal_depth_mm: float
    base_depth_mm: float


def generate_directional_reversals(
    num_cycles: int,
    reversal_depth_mm: float,
    base_depth_mm: float = 2.0,
    samples_per_stroke: int = 8,
    sample_rate_hz: int = 1000
) -> Tuple[List[float], List[ReversalCycle]]:
    """
    Synthesize periodic sub-millimeter Rapid Trigger reversal waveform:
    - Initial entry ramp from 0.0mm to base_depth_mm (30 samples)
    - For each cycle:
        - Upward stroke: base_depth_mm -> (base_depth_mm - reversal_depth_mm)
        - Downward stroke: (base_depth_mm - reversal_depth_mm) -> base_depth_mm
    Returns tuple of (wave_samples, list_of_cycle_metadata).
    """
    wave: List[float] = []
    cycles: List[ReversalCycle] = []

    # Initial settling ramp to base depth
    ramp_samples = 30
    for s in range(ramp_samples):
        wave.append(min(base_depth_mm, base_depth_mm * (s / (ramp_samples - 5))))

    valley_depth = base_depth_mm - reversal_depth_mm

    for i in range(num_cycles):
        t_rev_start = len(wave) / sample_rate_hz
        # Upward stroke (towards release)
        for s in range(1, samples_per_stroke + 1):
            frac = min(1.0, s / (samples_per_stroke - 2))
            x = base_depth_mm - reversal_depth_mm * frac
            wave.append(x)

        t_press_start = len(wave) / sample_rate_hz
        # Downward stroke (towards re-press)
        for s in range(1, samples_per_stroke + 1):
            frac = min(1.0, s / (samples_per_stroke - 2))
            x = valley_depth + reversal_depth_mm * frac
            wave.append(x)

        cycles.append(
            ReversalCycle(
                cycle_index=i,
                t_rev_start_s=t_rev_start,
                t_press_start_s=t_press_start,
                reversal_depth_mm=reversal_depth_mm,
                base_depth_mm=base_depth_mm
            )
        )

    return wave, cycles


def inject_noise_and_emi(
    wave_mm: List[float],
    sample_rate_hz: int = 1000,
    rest_baseline: int = 2048,
    dynamic_range: float = 1000.0,
    max_travel_mm: float = 4.0,
    a60: float = 15.0,
    a120: float = 5.0,
    sigma_thermal: float = 3.0,
    seed: Optional[int] = 42
) -> List[int]:
    """
    Convert travel waveform x(t) to noisy 12-bit ADC counts:
    ADC(t) = clamp(round(rest_baseline + (x/4.0)*dynamic_range + N_emi(t) + N_thermal(t)), 0, 4095)
    """
    if seed is not None:
        random.seed(seed)

    raw_samples: List[int] = []
    for k, x in enumerate(wave_mm):
        t = k / sample_rate_hz
        ideal_adc = rest_baseline + (x / max_travel_mm) * dynamic_range
        emi = a60 * math.sin(2.0 * math.pi * 60.0 * t) + a120 * math.sin(2.0 * math.pi * 120.0 * t)
        thermal = random.gauss(0.0, sigma_thermal)
        sample = int(round(ideal_adc + emi + thermal))
        raw_samples.append(max(0, min(4095, sample)))
    return raw_samples


def generate_drift(
    num_samples: int,
    drift_counts: float,
    drift_samples: int,
    start_baseline: int = 2048
) -> List[float]:
    """
    Synthesize baseline drift over drift_samples followed by steady state:
    baseline(k) = start_baseline + drift_counts * min(1.0, k / drift_samples)
    """
    baseline_wave: List[float] = []
    for k in range(num_samples):
        frac = min(1.0, k / drift_samples)
        baseline_wave.append(start_baseline + drift_counts * frac)
    return baseline_wave


# ============================================================================
# 3. Test Cases (TC-01 through TC-12)
# ============================================================================

class TestDSPHarness(unittest.TestCase):
    """
    Authoritative test suite for the DriftPad HallKey DSP engine.
    Verifies Rapid Trigger turnaround accuracy, EMI rejection, latency, and auto-zero tracking.
    """

    def _evaluate_rt_reversals(
        self,
        s_rt: float,
        num_cycles: int = 100,
        margin_pct: float = 0.0,
        base_depth_mm: float = 2.0
    ) -> float:
        """
        Helper: Execute num_cycles reversals with reversal displacement:
        delta_d = s_rt * (1 + margin_pct)
        Returns accuracy percentage: (detected_releases + detected_presses) / (2 * num_cycles) * 100.
        """
        dsp = HallKeyDSP(auto_polarity=False)
        if base_depth_mm <= 1.0:
            dsp.set_actuation_point(0.50)
        dsp.set_rt_sensitivity(s_rt)
        
        delta_d = s_rt * (1.0 + margin_pct)
        samples_per_stroke = 10
        wave, cycles = generate_directional_reversals(
            num_cycles=num_cycles,
            reversal_depth_mm=delta_d,
            base_depth_mm=base_depth_mm,
            samples_per_stroke=samples_per_stroke
        )

        detected_up = 0
        detected_down = 0

        # Run initial settling samples (first 30)
        idx = 0
        while idx < 30:
            adc = 2048.0 + (wave[idx] / 4.0) * 1000.0
            dsp.update(adc)
            idx += 1

        self.assertTrue(dsp.is_pressed, f"Switch must be actuated after settling at {base_depth_mm}mm")

        # Process each turnaround cycle
        for cycle in cycles:
            up_found = False
            for _ in range(samples_per_stroke):
                adc = 2048.0 + (wave[idx] / 4.0) * 1000.0
                if dsp.update(adc) and not dsp.is_pressed:
                    up_found = True
                idx += 1
            if up_found:
                detected_up += 1

            down_found = False
            for _ in range(samples_per_stroke):
                adc = 2048.0 + (wave[idx] / 4.0) * 1000.0
                if dsp.update(adc) and dsp.is_pressed:
                    down_found = True
                idx += 1
            if down_found:
                detected_down += 1

        total_opportunities = 2 * num_cycles
        total_detected = detected_up + detected_down
        accuracy = (total_detected / total_opportunities) * 100.0
        return accuracy

    # ------------------------------------------------------------------------
    # TC-01 to TC-05: Rapid Trigger Turnaround Accuracy
    # ------------------------------------------------------------------------

    def test_tc01_rapid_trigger_accuracy_0_20mm(self):
        """TC-01: Rapid Trigger turnaround accuracy at 0.20mm sensitivity (>= 99.0%)."""
        accuracy = self._evaluate_rt_reversals(s_rt=0.20, num_cycles=100)
        self.assertGreaterEqual(
            accuracy, 99.0,
            f"TC-01: Turnaround accuracy {accuracy:.2f}% below threshold 99.0%"
        )

    def test_tc02_rapid_trigger_accuracy_0_15mm(self):
        """TC-02: Rapid Trigger turnaround accuracy at 0.15mm sensitivity (>= 99.0%)."""
        accuracy = self._evaluate_rt_reversals(s_rt=0.15, num_cycles=100)
        self.assertGreaterEqual(
            accuracy, 99.0,
            f"TC-02: Turnaround accuracy {accuracy:.2f}% below threshold 99.0%"
        )

    def test_tc03_rapid_trigger_accuracy_0_10mm(self):
        """TC-03: Rapid Trigger turnaround accuracy at 0.10mm sensitivity (>= 99.0%)."""
        accuracy = self._evaluate_rt_reversals(s_rt=0.10, num_cycles=100)
        self.assertGreaterEqual(
            accuracy, 99.0,
            f"TC-03: Turnaround accuracy {accuracy:.2f}% below threshold 99.0%"
        )

    def test_tc04_rapid_trigger_accuracy_0_05mm(self):
        """TC-04: Rapid Trigger turnaround accuracy at 0.05mm sensitivity (>= 99.0%)."""
        for depth in [1.0, 1.5, 2.0, 2.5, 3.0]:
            accuracy = self._evaluate_rt_reversals(s_rt=0.05, num_cycles=100, margin_pct=0.0, base_depth_mm=depth)
            self.assertGreaterEqual(
                accuracy, 99.0,
                f"TC-04: Turnaround accuracy {accuracy:.2f}% at base depth {depth:.1f}mm below threshold 99.0%"
            )

    def test_tc05_rapid_trigger_multi_velocity_sweep(self):
        """TC-05: Rapid Trigger turnaround accuracy across multi-velocity strokes (>= 99.0%)."""
        # Test velocities: fast (6 samples/stroke), standard (10 samples), slow (16 samples)
        velocities = [6, 10, 16]
        dsp = HallKeyDSP(auto_polarity=False)
        dsp.set_rt_sensitivity(0.10)

        total_detected = 0
        total_expected = 0

        for stroke_samples in velocities:
            wave, cycles = generate_directional_reversals(
                num_cycles=30,
                reversal_depth_mm=0.105,
                base_depth_mm=2.0,
                samples_per_stroke=stroke_samples
            )
            # Settle at 2.0mm
            for s in range(30):
                dsp.update(int(round(2048 + (wave[s] / 4.0) * 1000)))

            idx = 30
            for cycle in cycles:
                total_expected += 2
                up_det = False
                for _ in range(stroke_samples):
                    adc = int(round(2048 + (wave[idx] / 4.0) * 1000))
                    if dsp.update(adc) and not dsp.is_pressed:
                        up_det = True
                    idx += 1
                if up_det: total_detected += 1

                down_det = False
                for _ in range(stroke_samples):
                    adc = int(round(2048 + (wave[idx] / 4.0) * 1000))
                    if dsp.update(adc) and dsp.is_pressed:
                        down_det = True
                    idx += 1
                if down_det: total_detected += 1

        accuracy = (total_detected / total_expected) * 100.0
        self.assertGreaterEqual(
            accuracy, 99.0,
            f"TC-05: Sweep turnaround accuracy {accuracy:.2f}% below 99.0%"
        )

    # ------------------------------------------------------------------------
    # TC-06 to TC-08: Zero False Actuations and Chatter Rejection
    # ------------------------------------------------------------------------

    def test_tc06_quiescent_noise_stationary_hold(self):
        """TC-06: Zero false actuations under 10s rest with 60Hz EMI (20 counts) and thermal noise."""
        random.seed(42)
        dsp = HallKeyDSP()
        false_actuations = 0

        # 10.0 seconds at 1000Hz = 10,000 samples
        for k in range(10000):
            t = k * 0.001
            emi = 20.0 * math.sin(2.0 * math.pi * 60.0 * t) + 5.0 * math.sin(2.0 * math.pi * 120.0 * t)
            thermal = random.gauss(0.0, 3.5)
            raw = int(round(max(0, min(4095, 2048 + emi + thermal))))
            if dsp.update(raw):
                if dsp.is_pressed:
                    false_actuations += 1

        self.assertEqual(
            false_actuations, 0,
            f"TC-06: Quiescent noise produced {false_actuations} false KeyDown events (expected strictly 0)"
        )
        self.assertFalse(dsp.is_pressed, "TC-06: Key must remain unpressed throughout quiescent noise")

    def test_tc07_in_stroke_stationary_hold_sub_rt_jitter(self):
        """TC-07: Zero false releases during 5s held key at 2.0mm with 20-count 60Hz EMI jitter."""
        dsp = HallKeyDSP(auto_polarity=False)
        dsp.set_rt_sensitivity(0.10)

        # Press and settle at 2.0mm
        for _ in range(50):
            dsp.update(2548)
        self.assertTrue(dsp.is_pressed, "Must be pressed prior to stationary hold")

        false_releases = 0
        for k in range(5000):
            t = k * 0.001
            emi = 20.0 * math.sin(2.0 * math.pi * 60.0 * t)
            raw = int(round(2548 + emi))
            if dsp.update(raw):
                if not dsp.is_pressed:
                    false_releases += 1

        self.assertEqual(
            false_releases, 0,
            f"TC-07: 60Hz EMI produced {false_releases} false KeyUp releases (expected strictly 0)"
        )
        self.assertTrue(dsp.is_pressed, "TC-07: Key must remain continuously pressed")

    def test_tc08_released_stationary_hold_sub_rt_jitter(self):
        """TC-08: Zero false actuations during 5s released hold at 1.5mm with 20-count 60Hz EMI jitter."""
        dsp = HallKeyDSP(auto_polarity=False)
        dsp.set_rt_sensitivity(0.10)

        # Actuate to 2.0mm, then release to 1.5mm
        for _ in range(30):
            dsp.update(2548)
        for _ in range(30):
            dsp.update(int(round(2048 + (1.5 / 4.0) * 1000)))
        self.assertFalse(dsp.is_pressed, "Must be released at 1.5mm prior to hold")

        false_actuations = 0
        for k in range(5000):
            t = k * 0.001
            emi = 20.0 * math.sin(2.0 * math.pi * 60.0 * t)
            raw = int(round(2048 + (1.5 / 4.0) * 1000 + emi))
            if dsp.update(raw):
                if dsp.is_pressed:
                    false_actuations += 1

        self.assertEqual(
            false_actuations, 0,
            f"TC-08: 60Hz EMI produced {false_actuations} false KeyDown events (expected strictly 0)"
        )
        self.assertFalse(dsp.is_pressed, "TC-08: Key must remain continuously unpressed")

    # ------------------------------------------------------------------------
    # TC-09, TC-10: Response Latency Measurement
    # ------------------------------------------------------------------------

    def test_tc09_actuation_latency_measurement(self):
        """TC-09: Fixed actuation latency measurement (mean <= 2.0ms, max <= 4.0ms)."""
        latencies_ms: List[float] = []

        # Evaluate across 4 velocities and 10 continuous start phase offsets
        velocities = [50.0, 100.0, 200.0, 500.0]
        for v in velocities:
            for offset_idx in range(10):
                t_offset = offset_idx * 0.0001
                t_cross = t_offset + (1.20 / v)
                dsp = HallKeyDSP(auto_polarity=False)
                dsp.set_actuation_point(1.20)

                detected_time = None
                for k in range(500):
                    t_sample = k * 0.001
                    if t_sample < t_offset:
                        x = 0.0
                    else:
                        x = min(4.0, (t_sample - t_offset) * v)
                    raw = int(round(2048 + (x / 4.0) * 1000))
                    if dsp.update(raw):
                        if dsp.is_pressed:
                            detected_time = t_sample
                            break

                self.assertIsNotNone(detected_time, "Actuation must trigger on linear ramp")
                lat = (detected_time - t_cross) * 1000.0
                latencies_ms.append(lat)

        mean_lat = sum(latencies_ms) / len(latencies_ms)
        max_lat = max(latencies_ms)
        self.assertLessEqual(
            mean_lat, 2.0,
            f"TC-09: Mean actuation latency {mean_lat:.2f}ms exceeds threshold 2.0ms"
        )
        self.assertLessEqual(
            max_lat, 4.0,
            f"TC-09: Max actuation latency {max_lat:.2f}ms exceeds threshold 4.0ms"
        )

    def test_tc10_release_latency_measurement(self):
        """TC-10: Rapid Trigger release latency measurement (mean <= 2.0ms, max <= 4.0ms)."""
        latencies_ms: List[float] = []
        s_rt = 0.10
        velocities = [20.0, 50.0, 100.0]

        for v in velocities:
            for offset_idx in range(10):
                t_offset = offset_idx * 0.0001
                t_rev = 0.030 + t_offset
                t_cross = t_rev + (s_rt / v)

                dsp = HallKeyDSP(auto_polarity=False)
                dsp.set_rt_sensitivity(s_rt)

                # Settle at 2.0mm
                for _ in range(30):
                    dsp.update(int(round(2048 + (2.0 / 4.0) * 1000)))
                self.assertTrue(dsp.is_pressed)

                rel_time = None
                for k in range(30, 200):
                    t_sample = k * 0.001
                    if t_sample < t_rev:
                        x = 2.0
                    else:
                        x = max(1.0, 2.0 - (t_sample - t_rev) * v)
                    raw = int(round(2048 + (x / 4.0) * 1000))
                    if dsp.update(raw):
                        if not dsp.is_pressed:
                            rel_time = t_sample
                            break

                self.assertIsNotNone(rel_time, "RT release must trigger on reversal")
                lat = (rel_time - t_cross) * 1000.0
                latencies_ms.append(lat)

        mean_lat = sum(latencies_ms) / len(latencies_ms)
        max_lat = max(latencies_ms)
        self.assertLessEqual(
            mean_lat, 2.0,
            f"TC-10: Mean release latency {mean_lat:.2f}ms exceeds threshold 2.0ms"
        )
        self.assertLessEqual(
            max_lat, 4.0,
            f"TC-10: Max release latency {max_lat:.2f}ms exceeds threshold 4.0ms"
        )

    # ------------------------------------------------------------------------
    # TC-11, TC-12: Auto-Zero Baseline Drift Tracking
    # ------------------------------------------------------------------------

    def test_tc11_positive_baseline_auto_zero_drift(self):
        """TC-11: Auto-zero baseline tracking adapts to +100 counts drift over 500ms without false triggering."""
        dsp = HallKeyDSP()
        false_actuations = 0
        max_travel = 0.0
        err_at_500 = None

        # 1000 samples total: 500 samples linear drift + 500 samples steady state
        for k in range(1000):
            drift = 100.0 * min(1.0, k / 500.0)
            true_baseline = 2048.0 + drift
            raw = int(round(true_baseline))

            if dsp.update(raw):
                if dsp.is_pressed:
                    false_actuations += 1

            max_travel = max(max_travel, dsp.get_travel_mm())
            if k == 499:
                err_at_500 = abs(dsp.rest_baseline - true_baseline)

        residual_err = abs(dsp.rest_baseline - 2148.0)

        self.assertEqual(false_actuations, 0, "TC-11: False actuation triggered during +100 drift")
        self.assertFalse(dsp.is_pressed, "TC-11: Key must remain unpressed")
        self.assertLess(max_travel, 0.20, f"TC-11: Max travel {max_travel:.4f}mm exceeded top deadzone (0.20mm)")
        self.assertLessEqual(err_at_500, 5.0, f"TC-11: Error at 500ms {err_at_500:.2f} counts exceeded 5.0")
        self.assertLessEqual(residual_err, 2.0, f"TC-11: Final residual error {residual_err:.2f} exceeded 2.0")

        # Verify subsequent real keystroke actuates accurately relative to new baseline
        # 1.20mm at 250 counts/mm = +300 counts -> raw = 2148 + 300 = 2448
        actuated = False
        for s in range(20):
            x = 1.20 * (s / 10.0)
            raw = int(round(dsp.rest_baseline + (x / 4.0) * 1000))
            if dsp.update(raw) and dsp.is_pressed:
                actuated = True
                break
        self.assertTrue(actuated, "Keystroke after positive drift must actuate at configured depth")

    def test_tc12_negative_baseline_auto_zero_drift(self):
        """TC-12: Auto-zero baseline tracking adapts to -100 counts drift over 500ms without false triggering."""
        dsp = HallKeyDSP()
        false_actuations = 0
        max_travel = 0.0
        err_at_500 = None

        for k in range(1000):
            drift = -100.0 * min(1.0, k / 500.0)
            true_baseline = 2048.0 + drift
            raw = int(round(true_baseline))

            if dsp.update(raw):
                if dsp.is_pressed:
                    false_actuations += 1

            max_travel = max(max_travel, dsp.get_travel_mm())
            if k == 499:
                err_at_500 = abs(dsp.rest_baseline - true_baseline)

        residual_err = abs(dsp.rest_baseline - 1948.0)

        self.assertEqual(false_actuations, 0, "TC-12: False actuation triggered during -100 drift")
        self.assertFalse(dsp.is_pressed, "TC-12: Key must remain unpressed")
        self.assertLess(max_travel, 0.20, f"TC-12: Max travel {max_travel:.4f}mm exceeded top deadzone (0.20mm)")
        self.assertLessEqual(err_at_500, 5.0, f"TC-12: Error at 500ms {err_at_500:.2f} counts exceeded 5.0")
        self.assertLessEqual(residual_err, 2.0, f"TC-12: Final residual error {residual_err:.2f} exceeded 2.0")

        # Verify subsequent real keystroke actuates accurately relative to new baseline
        actuated = False
        for s in range(20):
            x = 1.20 * (s / 10.0)
            raw = int(round(dsp.rest_baseline + (x / 4.0) * 1000))
            if dsp.update(raw) and dsp.is_pressed:
                actuated = True
                break
        self.assertTrue(actuated, "Keystroke after negative drift must actuate at configured depth")

    def test_tc16_rapid_trigger_reversals_with_active_noise(self):
        """TC-16: Rapid Trigger turnaround accuracy at 0.15mm sensitivity with active 60Hz EMI + thermal noise (>= 95.0%)."""
        s_rt = 0.15
        num_cycles = 50
        samples_per_stroke = 12
        wave, cycles = generate_directional_reversals(
            num_cycles=num_cycles,
            reversal_depth_mm=0.25,
            base_depth_mm=2.0,
            samples_per_stroke=samples_per_stroke
        )
        noisy = inject_noise_and_emi(wave, a60=15.0, a120=0.0, sigma_thermal=1.0, seed=42)
        dsp = HallKeyDSP(auto_polarity=False)
        dsp.set_rt_sensitivity(s_rt)

        for s in range(30):
            dsp.update(noisy[s])
        self.assertTrue(dsp.is_pressed, "Key must be pressed after settling at 2.0mm")

        ups = 0
        downs = 0
        for k in range(30, len(noisy)):
            if dsp.update(noisy[k]):
                if dsp.is_pressed:
                    downs += 1
                else:
                    ups += 1

        accuracy = min(100.0, (ups + downs) / (2 * num_cycles) * 100.0)
        self.assertGreaterEqual(
            accuracy, 95.0,
            f"TC-16: Turnaround accuracy with active noise {accuracy:.2f}% below threshold 95.0%"
        )

    # ------------------------------------------------------------------------
    # Additional Waveform & Algorithmic Unit Tests
    # ------------------------------------------------------------------------

    def test_waveform_sinusoid_properties(self):
        """Verifies synthetic sinusoidal generator range, period, and boundary compliance."""
        for f in [1.0, 5.0, 10.0, 20.0]:
            duration = 1.0 / f
            wave = generate_sinusoid(freq_hz=f, duration_s=duration)
            self.assertAlmostEqual(min(wave), 0.0, places=2)
            self.assertAlmostEqual(max(wave), 4.0, places=2)

    def test_waveform_triangle_properties(self):
        """Verifies synthetic triangle ramp linearity, peak depth, and slope."""
        wave = generate_triangle(v_press_mm_s=100.0, v_release_mm_s=100.0)
        self.assertEqual(wave[0], 0.0)
        self.assertAlmostEqual(max(wave), 4.0, places=2)
        self.assertEqual(wave[-1], 0.0)

    def test_waveform_noise_injection_statistics(self):
        """Verifies noise injection produces correct 12-bit clamped range and expected mean."""
        base_wave = [2.0] * 1000
        noisy = inject_noise_and_emi(base_wave, a60=15.0, a120=5.0, sigma_thermal=3.0, seed=123)
        self.assertTrue(all(0 <= s <= 4095 for s in noisy))
        mean_adc = sum(noisy) / len(noisy)
        # 2.0mm on 2048 baseline with 1000 dynamic range = 2048 + 500 = 2548
        self.assertAlmostEqual(mean_adc, 2548.0, delta=2.0)

    def test_polarity_auto_detection(self):
        """Verifies polarity auto-detection handles both positive and inverted Hall sensors."""
        # Test positive polarity (voltage increases on press)
        dsp_pos = HallKeyDSP(auto_polarity=True)
        self.assertFalse(dsp_pos.polarity_detected)
        # Press by +200 counts (>150 delta)
        dsp_pos.update(2048 + 200)
        self.assertTrue(dsp_pos.polarity_detected)
        self.assertTrue(dsp_pos.voltage_increases_on_press)

        # Test negative polarity (voltage decreases on press)
        dsp_neg = HallKeyDSP(auto_polarity=True)
        dsp_neg.update(2048 - 200)
        self.assertTrue(dsp_neg.polarity_detected)
        self.assertFalse(dsp_neg.voltage_increases_on_press)

    def test_simulated_travel_injection(self):
        """Verifies direct simulated travel injection bypasses ADC processing."""
        dsp = HallKeyDSP()
        dsp.set_actuation_point(1.50)
        self.assertFalse(dsp.is_pressed)
        dsp.inject_simulated_travel(1.00)
        self.assertFalse(dsp.is_pressed)
        dsp.inject_simulated_travel(1.55)
        self.assertTrue(dsp.is_pressed)
        dsp.inject_simulated_travel(0.10)
        self.assertFalse(dsp.is_pressed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
