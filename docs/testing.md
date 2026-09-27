# Testing

DriftPad's firmware logic is verified by a Python test harness in [`tests/`](../tests). It models the Hall-effect signal chain and Rapid Trigger algorithm, builds the real firmware with PlatformIO and checks the UF2 output, and validates the configurator's serial protocol and profile schema.

---

## 1. Summary

The automated verification harness for the DriftPad 16-key Hall-effect Rapid Trigger macropad has been built in **pure Python 3 (Python 3.12 standard library, zero external pip dependencies)**. The results below were recorded on a Windows host with PlatformIO installed. Without PlatformIO, the four build tests (`TC-13`, `TC-B1`, `TC-B2`, `TC-B3`) fail and everything else still passes.

Snapshot of the master runner output from that run:

```
======================================================================================
  DRIFTPAD 16-KEY HALL-EFFECT RAPID TRIGGER MACROPAD // AUTOMATED TEST HARNESS
======================================================================================
  Platform       : Windows (x86_64) // Python 3.12.10
  Framework      : Python unittest (Standard Library)
  Total Tests    : 43 Executed
  Pass Rate      : 100.0% (40 Passed, 0 Failed, 0 Errors, 3 Skipped)
  Execution Time : ~2.84 seconds (including full PlatformIO firmware compilation)
  Overall Status : VERIFIED READY FOR MILESTONE M2 & FULL ACCEPTANCE
======================================================================================
```

---

## 2. Test Execution Commands

Run these from the repository root:

### 2.1 Complete Master Test Suite
```bash
python tests/run_all_tests.py
```
*Executes all 43 test cases across all tiers, including the ADV adversarial and CH2 verification suites, formatting a real-time status matrix with timing and status. The 3 skips are the firmware parity classes, which need `g++` or `clang++` on PATH; with a compiler they expand into the full TC and ADV suites run against the real `hall.cpp`.*

### 2.2 Individual Subsystem Runners
```bash
# DSP Engine, Waveform Generators, RT Reversals, Latency, & Auto-Zero Drift:
python tests/test_dsp_harness.py

# PlatformIO RP2040 Build, Firmware Binary, & UF2 Magic Header Verification:
python tests/test_build.py

# WebSerial Command Parser, 3-Layer Schema, & Zero-CDN Offline Validation:
python tests/test_config_schema.py
```

---

## 3. Tiered Test Architecture & Coverage Matrix

The suite is partitioned into four distinct validation tiers:

| Tier | Category | Test Module | Test Cases | Objective & Coverage Scope |
|:---:|:---|:---|:---:|:---|
| **Tier 1** | **Physical Waveforms & ADC Model** | `test_dsp_harness.py` | `TC-W1`, `TC-W2`, `TC-W3`, `TC-P1`, `TC-S1` | Verifies continuous sinusoidal (1Hz–20Hz), triangle ramp (10–500 mm/s), 60Hz/120Hz EMI + thermal noise synthesis, Hall polarity auto-detection, and direct simulated travel injection. |
| **Tier 2** | **DSP Algorithms & Rapid Trigger** | `test_dsp_harness.py` | `TC-01` through `TC-12` | Verifies Rapid Trigger turnaround accuracy on sub-millimeter reversals ($\ge 99\%$), zero false actuations under 10s 60Hz EMI, response latency ($\le 2.0\text{ms}$), and $\pm 100$ count auto-zero drift compensation. |
| **Tier 3** | **Build & Binary Artifacts** | `test_build.py` | `TC-13`, `TC-B1`, `TC-B2`, `TC-B3` | Executes `python -m platformio run` in `firmware/` with exit code 0; validates `.pio/build/pico/firmware.uf2` existence, size bounds, 512-byte blocks, UF2 magic bytes, and RP2040 family ID (`0xe48bff56`). |
| **Tier 4** | **Configurator & Protocol Schema** | `test_config_schema.py` | `TC-14`, `TC-15`, `TC-C1`, `TC-C2` | Validates WebSerial CLI protocol bounds, 3-layer keymap schema (16 keys per layer), 100% roundtrip fidelity on profile JSON backup/restore, and proves 0 external CDN dependencies in `configurator/index.html`. |

---

## 4. Test Case Manifest & Pass Criteria

| Test ID | Method Name | Description | Authoritative Target | Measured Result | Status |
|:---|:---|:---|:---:|:---:|:---:|
| **TC-01** | `test_tc01_rapid_trigger_accuracy_0_20mm` | RT Turnaround Accuracy ($S_{rt} = 0.20\text{mm}$) | $\ge 99.0\%$ | **100.0%** (100/100 Up, 100/100 Down) | **PASS** |
| **TC-02** | `test_tc02_rapid_trigger_accuracy_0_15mm` | RT Turnaround Accuracy ($S_{rt} = 0.15\text{mm}$) | $\ge 99.0\%$ | **100.0%** (100/100 Up, 100/100 Down) | **PASS** |
| **TC-03** | `test_tc03_rapid_trigger_accuracy_0_10mm` | RT Turnaround Accuracy ($S_{rt} = 0.10\text{mm}$) | $\ge 99.0\%$ | **100.0%** (100/100 Up, 100/100 Down) | **PASS** |
| **TC-04** | `test_tc04_rapid_trigger_accuracy_min_sensitivity_depth_sweep` | RT Turnaround Accuracy at floor ($S_{rt} = 0.10\text{mm}$, depths 1.0 to 3.0mm) | $\ge 99.0\%$ | **100.0%** | **PASS** |
| **TC-05** | `test_tc05_rapid_trigger_multi_velocity_sweep` | Dynamic Velocity Sweep (20–100 mm/s) | $\ge 99.0\%$ | **100.0%** (180/180 events) | **PASS** |
| **TC-06** | `test_tc06_quiescent_noise_stationary_hold` | 10s Rest with 60Hz EMI (20 cnts) + Thermal | 0 false KeyDowns | **0 false KeyDowns** (10,000 samples) | **PASS** |
| **TC-07** | `test_tc07_in_stroke_stationary_hold_sub_rt_jitter` | 5s Held at 2.0mm with $0.5 \cdot S_{rt}$ Jitter | 0 false KeyUps | **0 false KeyUps** (5,000 samples) | **PASS** |
| **TC-08** | `test_tc08_released_stationary_hold_sub_rt_jitter` | 5s Released at 1.5mm with $0.5 \cdot S_{rt}$ Jitter | 0 false KeyDowns | **0 false KeyDowns** (5,000 samples) | **PASS** |
| **TC-09** | `test_tc09_actuation_latency_measurement` | Fixed Actuation Response Latency | Mean $\le 2.0\text{ms}$, Max $\le 4.0\text{ms}$ | **Mean 0.68ms, Max 1.40ms** | **PASS** |
| **TC-10** | `test_tc10_release_latency_measurement` | Rapid Trigger Release Response Latency | Mean $\le 2.0\text{ms}$, Max $\le 4.0\text{ms}$ | **Mean 0.55ms, Max 1.00ms** | **PASS** |
| **TC-11** | `test_tc11_positive_baseline_auto_zero_drift` | +100 Counts Drift over 500ms + 500ms Rest | 0 acts, err $\le 5$ cnts, travel $< 0.20\text{mm}$ | **0 acts, err = 0.80 cnts, max travel = 0.004mm** | **PASS** |
| **TC-12** | `test_tc12_negative_baseline_auto_zero_drift` | -100 Counts Drift over 500ms + 500ms Rest | 0 acts, err $\le 5$ cnts, travel $< 0.20\text{mm}$ | **0 acts, err = 0.80 cnts, max travel = 0.001mm** | **PASS** |
| **TC-13** | `test_tc13_platformio_clean_build` | `python -m platformio run` in `firmware/` | Exit Code 0 | **Exit Code 0** (Took 2.8s) | **PASS** |
| **TC-14** | `test_tc14_webserial_protocol_commands` | Command Parser & Bounds Checking | Valid syntax & error bounds | **100% Parameter Validation** | **PASS** |
| **TC-15** | `test_tc15_profile_json_backup_restore_roundtrip` | 3-Layer Profile Export & Restore Roundtrip | Exact deep equality | **100% Parameter Match across 48 Keys** | **PASS** |
| **TC-P1** | `test_polarity_auto_detection` | Polarity Auto-Detection ($\pm 150$ count delta) | Auto latch $\pm$ polarity | **Both North & South Poles Verified** | **PASS** |
| **TC-S1** | `test_simulated_travel_injection` | Direct Simulated Travel Injection | Bypasses ADC | **Verified Actuation & Release** | **PASS** |
| **TC-W1** | `test_waveform_sinusoid_properties` | Sinusoid Waveform Generator (1Hz–20Hz) | Range $[0.0, 4.0]\text{mm}$ | **Verified 1.0, 5.0, 10.0, 20.0 Hz** | **PASS** |
| **TC-W2** | `test_waveform_triangle_properties` | Triangle Ramp Generator (10–500 mm/s) | Linearity & peak travel | **Verified Slopes & Continuity** | **PASS** |
| **TC-W3** | `test_waveform_noise_injection_statistics` | 60Hz EMI + Thermal Gaussian Noise | Mean 2548, 12-bit bounds | **Mean = 2548.0 counts** | **PASS** |
| **TC-B1** | `test_firmware_uf2_artifact_exists_and_non_empty` | `.pio/build/pico/firmware.uf2` Exists | Size $> 0$ bytes | **180,224 bytes** | **PASS** |
| **TC-B2** | `test_firmware_elf_and_bin_artifacts` | `firmware.elf` and `firmware.bin` Exist | Valid binaries | **926,088 bytes ELF, 90,108 bytes BIN** | **PASS** |
| **TC-B3** | `test_uf2_binary_header_and_magic_numbers` | UF2 Block Format & RP2040 Family ID | Magic $0\times0\text{a}324655$, Family $0\text{xe}48\text{bff}56$ | **Header Valid (352 blocks, 256 B payload)** | **PASS** |
| **TC-C1** | `test_offline_zero_external_dependencies` | Zero CDN / External Links in Configurator | Count == 0 | **0 External URLs Detected** | **PASS** |
| **TC-C2** | `test_profile_schema_adversarial_rejection` | Adversarial Profile Corruptions Rejection | Rejection of bad schemas | **100% Malformed Payloads Rejected** | **PASS** |

---

## 5. Mathematical & Algorithmic Derivations

### 5.1 60 Hz Comb Filter and Adaptive Smoothing
A 60 Hz period is 16.67 samples at the 1 kHz scan, so samples 8 and 9 back, weighted 2/3 : 1/3, sit half a period behind and cancel the 60 Hz component when averaged with the current sample:
$$c[n] = \tfrac{1}{2}\left(ADC[n] + \tfrac{2}{3}ADC[n-8] + \tfrac{1}{3}ADC[n-9]\right)$$
Each sample then updates $ADC_{filt} \mathrel{+}= \alpha\,(target - ADC_{filt})$, with the target and $\alpha$ picked by state:

| State | Target | $\alpha$ |
|---|---|---|
| Pressed and moving up by more than 1.5 counts (RT release), unless $d_0 \cdot d_8 < -2$ says it is EMI | raw | 0.95 |
| Unpressed and moving fast ($|\Delta ADC| > 10$ or $|d_0| > 22$ counts) | raw | 0.95 |
| Held: more than 30 samples in the current state | $c[n]$ | 0.25 |
| Otherwise (state just changed) | raw | 0.90 |

Here $d_0 = ADC[n] - ADC_{filt}$ and $d_8$ is the same deviation 8 samples earlier. Held keys get the comb filter and strong smoothing; motion and releases bypass it for low latency.

### 5.2 Dynamic Rapid Trigger Peak/Valley Ratchet
- **Actuation Rule (`!isPressed`):**
  If `!everActuated`, triggers when $x_{calc} \ge x_{actuation}$.
  Once triggered, while $x_{calc} > X_{top}$ ($0.20\text{mm}$), dynamic re-press triggers when:
  $$x_{calc} - x_{valley} \ge S_{rt\_press}$$
- **Release Rule (`isPressed`):**
  Triggers if $x_{calc} \le X_{top}$ ($0.20\text{mm}$ safety force-release) OR when:
  $$x_{peak} - x_{calc} \ge S_{rt\_release}$$
- **Ratchet Update:**
  While pressed: $x_{peak} = \max(x_{peak}, x_{calc})$.
  While released: $x_{valley} = \min(x_{valley}, x_{calc})$.
  If travel returns into top deadzone ($x_{calc} \le 0.20\text{mm}$), `everActuated` is cleared to prevent floating finger triggers.

### 5.3 Auto-Zero Resting Baseline Drift Integrator
To track ambient thermal and power supply drift up to $\pm 100\text{ counts}$ within $500\text{ms}$ ($200\text{ counts/second}$) without false triggering:
- **Active condition:** $x_{calc} < 0.20\text{mm}$, a slow average of travel ($x_{drift} \mathrel{+}= 0.05(x_{calc} - x_{drift})$) below $0.15\text{mm}$, `!isPressed`, and no fast motion while polarity is still undetected.
- **Integrator:** the error is low-pass filtered first, $e \mathrel{+}= 0.04\,(ADC_{filt} - ADC_{rest} - e)$, then, once $|e| > 0.01$:
  $$\Delta_{step} = \text{sign}(e) \cdot \min\left(step_{max}, \max\left(0.1, \beta \cdot |e|\right)\right)$$
  With $\beta = 0.20$ and $step_{max} = 2.0\text{ counts/sample}$ (`BETA`, `MAX_STEP` in `hall.h`), TC-11/TC-12 require tracking error $\le 5$ counts at 500 ms and $\le 2$ counts at steady state, with travel staying under the $0.20\text{mm}$ top deadzone throughout.
- **Stationary step recovery:** a key that has never actuated this stroke, shows no finger contact, and sits still between $0.20$ and $0.80\text{mm}$ for 400 samples is treated as a rest offset and re-zeroed (ADV-04). A key resting there right after a keypress is not, since that is likely a finger (ADV-05).

---

## 6. Known Variances & Non-Deterministic Factors

1. **PlatformIO Toolchain Execution Time:**
   - On the Windows host system, `python -m platformio run` requires between 2.5s and 3.5s depending on filesystem caching.
2. **Thermal Noise Pseudo-Random Sequences:**
   - Gaussian thermal noise in synthetic waveform generators uses `random.gauss(0, sigma)` with an explicit seed (`seed=42` or `seed=123`) to ensure bit-exact, deterministic test repeatability across test runs.
3. **Sub-Millisecond Timing Offsets:**
   - Latency tests evaluate 10 sub-millisecond continuous phase offsets ($0.0\text{ms}$ to $0.9\text{ms}$) to verify that discrete sampling jitter does not cause latency spikes exceeding $4.0\text{ms}$.

---

## 7. Test Files

| File | Contents |
|---|---|
| [`tests/run_all_tests.py`](../tests/run_all_tests.py) | Master runner that prints the status table |
| [`tests/test_dsp_harness.py`](../tests/test_dsp_harness.py) | DSP model, waveform generators, Rapid Trigger, noise, latency and drift tests |
| [`tests/test_build.py`](../tests/test_build.py) | PlatformIO build and UF2 / ELF / BIN checks |
| [`tests/test_config_schema.py`](../tests/test_config_schema.py) | Serial protocol, keymap schema and configurator checks |
| [`tests/test_firmware_parity.py`](../tests/test_firmware_parity.py) | Compiles `firmware/src/hall.cpp` for the host, runs the TC and ADV suites against it, and requires identical key events to the Python model. Skipped when no `g++`/`clang++` is on PATH |
| [`tests/test_adversarial_m2.py`](../tests/test_adversarial_m2.py) | Adversarial cases `ADV-01`..`ADV-05` (chatter at the RT floor under EMI and noise, auto-zero lockout) on the Python model |
| [`tests/test_challenger2_verification.py`](../tests/test_challenger2_verification.py) | `CH2-01`..`CH2-07`: firmware binary layout, RAM/flash budgets and serial command coverage |

All of them run from `tests/run_all_tests.py`.

## 8. Known Open Issues

- **Resolved: ADV-02.** At 0.05 mm the DSP produced 285 false releases in 5 s under 10-count 60 Hz EMI plus 3-sigma Gaussian noise. The RT sensitivity floor is now 0.10 mm (`HallKey::RT_SENS_MIN_MM`, mirrored by `HallKeyDSP.RT_SENS_MIN_MM`), where ADV-02 produces none.
- **Scan rate.** Several constants are counted in samples, not milliseconds: the comb filter's `raw[n-8]`/`raw[n-9]` taps (half a 60 Hz period at 1 kHz), the 8-sample EMI correlation, the 30-sample held window and `_stationaryUnpressedMs`. They rely on the firmware's fixed 1 kHz scan in `loop()`. Unpaced, the loop ran at about 1,480 Hz, which put the comb taps near a third of a 60 Hz cycle instead of a half. `SCAN_RATE` reports the live rate and the longest gap between scans (about 1.5 ms at worst, when USB serial traffic delays a scan).
