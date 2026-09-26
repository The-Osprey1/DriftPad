# Tools

Helper scripts for DriftPad. Run them from the repository root.

| Script | What it does | Needs |
|---|---|---|
| [`render_oled_png.py`](render_oled_png.py) | Renders pixel-accurate OLED screenshots (standby, actuated and edge cases) into [`docs/images/`](../docs/images) using the same Adafruit GFX primitives and font as the firmware | Pillow, and a firmware build so `firmware/.pio/libdeps/pico/Adafruit GFX Library/glcdfont.c` exists |
| [`oled_concepts.py`](oled_concepts.py) | Generates the alternative layouts and key-press animations in [`docs/oled_concepts/`](../docs/oled_concepts). Exits non-zero if any text overflows its region | Pillow, same font file as above |
| [`demo_oled.py`](demo_oled.py) | Plays a short showcase on a connected DriftPad over serial using `SIM` commands | pyserial, a connected board |

Install the Python dependencies with:

```bash
pip install -r tools/requirements.txt
```

Examples:

```bash
python tools/render_oled_png.py
python tools/oled_concepts.py
python tools/demo_oled.py COM3          # Windows
python tools/demo_oled.py /dev/ttyACM0  # Linux (macOS: /dev/cu.usbmodem...)
```
