#!/usr/bin/env python3
"""
render_oled_frames.py - Screenshots of the real firmware screens.

Compiles firmware/src/oled.cpp for the host (real Adafruit GFX, stubbed panel; see
tests/oled_host.py) and writes docs/images/oled_showcase.png: standby, key travelling, key
actuated, tuning menu and splash, at 4x. Unlike render_oled_png.py this cannot drift from the
firmware, because it runs the firmware's own drawing code.

Needs Pillow, a host C++ compiler (tests/host_build.py) and a firmware build so the Adafruit GFX
library exists under firmware/.pio/libdeps.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))

from PIL import Image, ImageDraw  # noqa: E402

import oled_host as oh  # noqa: E402

INK = (120, 220, 255)
SHOWCASE = ["standby", "travelling", "actuated", "menu_rt", "menu_layer", "splash"]
SCALE = 4


def to_image(fb):
    im = Image.new("RGB", (128, 64), (0, 0, 0))
    for y in range(64):
        for x in range(128):
            if oh.pixel(fb, x, y):
                im.putpixel((x, y), INK)
    return im.resize((128 * SCALE, 64 * SCALE), Image.NEAREST)


def main():
    try:
        lib = oh.load()
    except unittest.SkipTest as e:
        print(f"cannot render: {e}", file=sys.stderr)
        return 1
    cols, pad, label_h = 2, 12, 22
    w, h = 128 * SCALE, 64 * SCALE
    rows = (len(SHOWCASE) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w + (cols + 1) * pad, rows * (h + label_h) + pad), (10, 14, 22))
    draw = ImageDraw.Draw(sheet)
    for i, name in enumerate(SHOWCASE):
        x = pad + (i % cols) * (w + pad)
        y = pad + (i // cols) * (h + label_h)
        draw.text((x, y + 4), name, fill=(200, 210, 225))
        sheet.paste(to_image(oh.frame(lib, name)), (x, y + label_h))
    out = ROOT / "docs" / "images" / "oled_showcase.png"
    sheet.save(out)
    print(f"wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
