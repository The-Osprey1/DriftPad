# Tools

Helper scripts for DriftPad. Run them from the repository root with Python 3.9 or newer.

```bash
pip install -r tools/requirements.txt      # pyserial, Pillow
```

## Releasing and updating

| Script | What it does |
|---|---|
| [`qualify_release.py`](qualify_release.py) | Decides whether this checkout can be released: clean git tree, version with a CHANGELOG entry, toolchain as locked, every test suite in release mode with a fresh build, the image checked. Writes `dist/driftpad-<version>-<build>/` (firmware, manifest, reports, configurator, `RELEASE.md`, `SHA256SUMS`). Publishes nothing. `--acceptance acceptance.json` marks the bundle ready for external beta when the hardware acceptance record for that build is complete. |
| [`flash.py`](flash.py) | Updates one DriftPad with one checked build and verifies it: checks the UF2 (RP2040, never the settings sectors, the manifest's files), finds the pad by asking INFO (never guesses between several), refuses to lose unsaved settings or downgrade without a flag, reboots it into the bootloader, copies the image, then reads INFO again and requires the manifest's version and build id and unchanged saved settings and calibration. `--build` builds first; by default the existing build is flashed as it is. |
| [`firmware_image.py`](firmware_image.py) | The image checks used by both scripts above (UF2 blocks, ELF linker symbols, manifest hashes). |
| [`check_toolchain.py`](check_toolchain.py) | Compares the installed PlatformIO core, platform, framework, compiler, tools and libraries with `firmware/toolchain.lock.json`. `--write-pinned-conf` writes the platformio.ini copy CI builds with. |

## Hardware acceptance ([`docs/hardware-acceptance.md`](../docs/hardware-acceptance.md))

| Script | What it does |
|---|---|
| [`acceptance_record.py`](acceptance_record.py) | The record of an acceptance run: `new` from a build manifest, `set` an item's result with a note, `check` what is open, `sign` when every required item passed. Items come from the procedure document. |
| [`timing_capture.py`](timing_capture.py) | Resets and samples the pad's `TIMING` counters during a scenario and judges them (no scan gap above 2 ms, or only the save's own pause with `--allow-save-gaps`). Writes a JSON record. |
| [`save_stress.py`](save_stress.py) | Saves settings in a loop for the power-cut item, logging every confirmed save; `--verify` checks the pad afterwards holds the last confirmed or the interrupted value. `--command` sends one command. |
| [`key_tester.html`](key_tester.html) | Offline page showing every keydown/keyup with timings, per-key counts and keys still held. |

## Other

| Script | What it does | Needs |
|---|---|---|
| [`serve_configurator.py`](serve_configurator.py) | Serves `configurator/` on `http://127.0.0.1:8791` for browsers or tools that cannot open it from the file system. Nothing is fetched from the internet. | - |
| [`render_oled_png.py`](render_oled_png.py) | Renders pixel-accurate OLED screenshots into [`docs/images/`](../docs/images) using the same Adafruit GFX primitives and font as the firmware | Pillow, and a firmware build so `firmware/.pio/libdeps/pico/Adafruit GFX Library/glcdfont.c` exists |
| [`oled_concepts.py`](oled_concepts.py) | Generates the alternative layouts and key-press animations in [`docs/oled_concepts/`](../docs/oled_concepts). Exits non-zero if any text overflows its region | Pillow, same font file as above |
| [`demo_oled.py`](demo_oled.py) | Plays a short showcase on a connected DriftPad over serial using `SIM` commands | pyserial, a connected board |
| [`driftpad_serial.py`](driftpad_serial.py) | Shared by the serial tools: finding DriftPads by USB id, identifying them with `INFO`, request/reply by id | - |

Every tool that talks to a pad or the machine takes its ports, drives, clock and subprocesses as
parameters, so `tests/test_flash_tool.py` and `tests/test_release_tooling.py` run them against fakes.
