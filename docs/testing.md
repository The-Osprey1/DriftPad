# Testing

What is verified, by what, and what none of it proves. Run everything from the repository root
(use the full interpreter path where `python` is not on PATH).

```bash
python tests/run_all_tests.py            # diagnostic run: skips allowed, printed with reasons
python tests/run_all_tests.py --release  # what CI runs: no skips, fresh firmware build, clean git tree
python tests/run_all_tests.py --list     # suites, test counts and scopes; runs nothing
python tests/run_all_tests.py --json out.json --clean
```

Nothing in the suite touches a physical DriftPad. A green run means "the software behaves as specified
against models and fakes"; [hardware-acceptance.md](hardware-acceptance.md) lists what still needs a
pad. The runner labels every suite with a **scope** and prints the tools it found (host C++ compiler,
headless Chrome, PlatformIO). Skipped and errored *classes* are reported with the number of tests they
held, and in `--release` any skip, import error, missing tool, dirty tree or stale build fails the run.

## 1. What each scope means

| Scope | Meaning | Not proof of |
|---|---|---|
| compiled firmware on host | The production `.cpp` files (`hall.cpp`, the protocol core, `commands.cpp`, settings, `display_link`, keyboard output, ...) compiled for the PC with fake ADC, flash, USB and display, and driven through their real entry points | Timing on the RP2040, real flash, USB enumeration, the OLED |
| headless browser | The configurator's real JavaScript modules and pages in headless Chrome against `fake_device.js` | WebSerial with a real port, other browsers |
| headless browser + compiled firmware on host | The fake device's replies compared line by line with the compiled firmware's | |
| synthetic model | The Python model of the sensor chain and Rapid Trigger (`test_dsp_harness.py`) | Real magnets, sensors and noise |
| build artifacts | The PlatformIO build's UF2/ELF/BIN, flash layout and linker symbols | That the image runs |
| source inspection | Text checks of the repository (limits, docs, workflow, offline pages, core ownership) | Behaviour |
| host tooling with fakes | `tools/` scripts against fake serial ports, drives and subprocesses | The scripts on real hardware |
| test validator self-check | Tests of the validators the other suites rely on | |

## 2. Test modules

| Module | Scope | What it establishes |
|---|---|---|
| `test_build` | build artifacts | PlatformIO build succeeds; UF2 structure and RP2040 family id; ELF/BIN belong to this run |
| `test_flash_layout` | build artifacts | The settings sectors (A/B slots, legacy sector at `_FS_start`) do not overlap the program |
| `test_challenger2_verification` | build artifacts + source inspection | Binary layout, RAM/flash budgets, command coverage |
| `test_dsp_harness` | synthetic model | Waveforms, Rapid Trigger accuracy, EMI/noise rejection, latency, auto-zero drift (TC-01..TC-12 and helpers) |
| `test_adversarial_m2` | synthetic model | ADV-01..ADV-05: chatter at the RT floor, auto-zero lockout |
| `test_firmware_parity` | compiled firmware on host | The same DSP scenarios on the real `hall.cpp`, and lockstep event equality with the Python model |
| `test_protocol_core` | compiled firmware on host | Line reader, request ids, parser, JSON writer, dispatcher, transmit queue, deferred replies, command table |
| `test_protocol_device` | compiled firmware on host | The whole firmware (`main.cpp`, `commands.cpp`) over a fake serial port: every command, every error code, limits, streaming |
| `test_keyboard_output` | compiled firmware on host | Output ownership: no stuck keys, 6-key rollover, remap or layer change while held, host sleep, boot suppression, calibration gating; includes a reproduction of the pre-fix revision |
| `test_persistence_device` | compiled firmware on host | A/B slot saves, torn-write and corruption recovery, legacy migration, calibration lifecycle and rules |
| `test_display_link` | compiled firmware on host | Core 0 to core 1 snapshot (seqlock) and request counters |
| `test_display_scheduling` | compiled firmware on host + source inspection | Display work never delays a scan; deferred `OLED_TEST`/`OLED_SCAN`; the encoder save waits for typing to stop; core ownership in source |
| `test_timing` | compiled firmware on host | Scan statistics and the `TIMING` counters |
| `test_config_schema` | test validator self-check + compiled firmware on host | Profile schema, adversarial profiles, protocol vectors against the firmware |
| `test_configurator_contract` | headless browser + compiled firmware on host | `fake_device.js` answers exactly as the firmware does |
| `test_configurator_js` | headless browser | The configurator's module tests (`configurator/tests/unit_tests.js`, `session_tests.js`), page-level tests (`app_tests.js`), and reproductions of the old page's defects |
| `test_contract_consistency` | source inspection | Limits, error codes, factory keymaps, label rules, offline pages and these documents agree with the code |
| `test_flash_tool` | host tooling with fakes | `tools/flash.py` and the UF2/ELF/manifest checks |
| `test_release_tooling` | host tooling with fakes + source inspection | `check_toolchain.py`, `timing_capture.py`, `save_stress.py`, `acceptance_record.py`, `qualify_release.py`, the CI workflow |

Classes named `TestPreFix...` compile earlier commits (`e2031e2`, `21834a8`) to show that the
regression tests **fail** against the old implementation, so CI checks out the full history.
Counts change; `--list` and the runner's summary are the source of truth, not this page.

## 3. Requirements

| Needs | Used by | Without it |
|---|---|---|
| Python 3.9+ (standard library) | everything | |
| PlatformIO 6.2.0 with the locked platform | `test_build`, `test_flash_layout`, release | those suites fail |
| A host C++ compiler: `$CXX`, else the pinned `ziglang` (`pip install -r tests/requirements-dev.txt`), else `g++`/`clang++` | every "compiled firmware on host" suite | skipped in a diagnostic run, fails `--release` |
| Chrome or Edge (or `DRIFTPAD_CHROME`) | both browser suites | skipped in a diagnostic run, fails `--release` |
| `pyserial`, Pillow (`tools/requirements.txt`) | the tool scripts only; tests use fakes | |

CI (`.github/workflows/ci.yml`) installs the locked toolchain (`firmware/toolchain.lock.json`) and runs
`--release --clean`; it uploads the reports and the build, and publishes nothing.

## 4. Building and qualifying

```bash
python tools/check_toolchain.py --require-libs   # installed toolchain equals firmware/toolchain.lock.json
cd firmware && pio run                            # build; artifacts in firmware/.pio/build/pico/
python tools/qualify_release.py                   # release gate: clean tree, changelog, locked toolchain, all suites, image checks
```

`qualify_release.py` writes `dist/driftpad-<version>-<build>/` and publishes nothing.

## 5. Signal-chain derivations

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

## 6. Determinism

1. **Thermal Noise Pseudo-Random Sequences:**
   - Gaussian thermal noise in synthetic waveform generators uses `random.gauss(0, sigma)` with an explicit seed (`seed=42` or `seed=123`) to ensure bit-exact, deterministic test repeatability across test runs.
2. **Sub-Millisecond Timing Offsets:**
   - Latency tests evaluate 10 sub-millisecond continuous phase offsets ($0.0\text{ms}$ to $0.9\text{ms}$) to verify that discrete sampling jitter does not cause latency spikes exceeding $4.0\text{ms}$.

---

## 7. Known open issues

- **Resolved: ADV-02.** At 0.05 mm the DSP produced 285 false releases in 5 s under 10-count 60 Hz EMI plus 3-sigma Gaussian noise. The RT sensitivity floor is now 0.10 mm (`HallKey::RT_SENS_MIN_MM`, mirrored by `HallKeyDSP.RT_SENS_MIN_MM`), where ADV-02 produces none.
- **Scan rate.** Several constants are counted in samples, not milliseconds: the comb filter's `raw[n-8]`/`raw[n-9]` taps (half a 60 Hz period at 1 kHz), the 8-sample EMI correlation, the 30-sample held window and `_stationaryUnpressedMs`. They rely on the firmware's fixed 1 kHz scan in `loop()`. Unpaced, the loop ran at about 1,480 Hz, which put the comb taps near a third of a 60 Hz cycle instead of a half. `SCAN_RATE` reports the live rate and the longest gap between scans (about 1.5 ms at worst, when USB serial traffic delays a scan).
- **Never measured on hardware:** every latency, noise and drift figure above comes from the synthetic model or the compiled `hall.cpp` fed synthetic samples. Real values come from [hardware-acceptance.md](hardware-acceptance.md) items HW-06, HW-10..HW-12 and HW-25..HW-28.
