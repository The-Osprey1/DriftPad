#!/usr/bin/env python3
"""
render_oled_png.py - Pixel-accurate OLED renderer for DriftPad V2
Generates exact 1:1 hardware screenshots directly from Adafruit GFX primitives and glcdfont.c.
Includes full parameterization for RT sensitivity, active layer, status pill, redline flash,
and comprehensive rendering of all edge cases (NRM pill, 4-char labels, ripple frames 1-3).
"""

import os
import re
import math
import shutil
from PIL import Image, ImageDraw

# -------------------------------------------------------------
# 1. Load exact glcdfont.c from firmware
# -------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
FONT_PATH = os.path.join(PROJECT_ROOT, "firmware/.pio/libdeps/pico/Adafruit GFX Library/glcdfont.c")

with open(FONT_PATH, "r") as f:
    hex_vals = [int(h, 16) for h in re.findall(r'0x[0-9A-Fa-f]{2}', f.read())]

# -------------------------------------------------------------
# 2. Hardware Framebuffer Simulator (128x64 Monochrome)
# -------------------------------------------------------------
class OLEDDisplay:
    def __init__(self):
        self.width = 128
        self.height = 64
        self.fb = [[0 for _ in range(self.width)] for _ in range(self.height)]

    def clear(self):
        self.fb = [[0 for _ in range(self.width)] for _ in range(self.height)]

    def drawPixel(self, x, y, col=1):
        if 0 <= x < self.width and 0 <= y < self.height:
            self.fb[y][x] = col

    def drawFastHLine(self, x, y, w, col=1):
        for i in range(w):
            self.drawPixel(x + i, y, col)

    def drawFastVLine(self, x, y, h, col=1):
        for j in range(h):
            self.drawPixel(x, y + j, col)

    def fillRect(self, x, y, w, h, col=1):
        for j in range(h):
            for i in range(w):
                self.drawPixel(x + i, y + j, col)

    def drawRect(self, x, y, w, h, col=1):
        self.drawFastHLine(x, y, w, col)
        self.drawFastHLine(x, y + h - 1, w, col)
        self.drawFastVLine(x, y, h, col)
        self.drawFastVLine(x + w - 1, y, h, col)

    def drawLine(self, x0, y0, x1, y1, col=1):
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx - dy
        while True:
            self.drawPixel(x0, y0, col)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x0 += sx
            if e2 < dx:
                err += dx
                y0 += sy

    def drawRoundRect(self, x, y, w, h, r, col=1):
        self.drawFastHLine(x + r, y, w - 2 * r, col)
        self.drawFastHLine(x + r, y + h - 1, w - 2 * r, col)
        self.drawFastVLine(x, y + r, h - 2 * r, col)
        self.drawFastVLine(x + w - 1, y + r, h - 2 * r, col)
        # Corner arcs
        for i in range(r):
            self.drawPixel(x + r - 1 - i, y + 1 + i, col)
            self.drawPixel(x + w - r + i, y + 1 + i, col)
            self.drawPixel(x + r - 1 - i, y + h - 2 - i, col)
            self.drawPixel(x + w - r + i, y + h - 2 - i, col)

    def fillRoundRect(self, x, y, w, h, r=2, col=1):
        self.fillRect(x, y, w, h, col)
        bg = 1 - col
        if r <= 1:
            self.drawPixel(x, y, bg)
            self.drawPixel(x + w - 1, y, bg)
            self.drawPixel(x, y + h - 1, bg)
            self.drawPixel(x + w - 1, y + h - 1, bg)
        else:
            for px, py in ((x, y), (x + 1, y), (x, y + 1),
                           (x + w - 1, y), (x + w - 2, y), (x + w - 1, y + 1),
                           (x, y + h - 1), (x + 1, y + h - 1), (x, y + h - 2),
                           (x + w - 1, y + h - 1), (x + w - 2, y + h - 1), (x + w - 1, y + h - 2)):
                self.drawPixel(px, py, bg)

    def drawChar(self, c, x, y, size=1, col=1, bg=None):
        ascii_code = ord(c) if isinstance(c, str) else c
        if ascii_code >= 256:
            return
        glyph_bytes = hex_vals[ascii_code * 5 : (ascii_code + 1) * 5]
        for col_idx in range(5):
            line = glyph_bytes[col_idx]
            for row_idx in range(8):
                if line & (1 << row_idx):
                    if size == 1:
                        self.drawPixel(x + col_idx, y + row_idx, col)
                    else:
                        self.fillRect(x + col_idx * size, y + row_idx * size, size, size, col)
                elif bg is not None:
                    if size == 1:
                        self.drawPixel(x + col_idx, y + row_idx, bg)
                    else:
                        self.fillRect(x + col_idx * size, y + row_idx * size, size, size, bg)
        # Blank separator column
        if bg is not None:
            if size == 1:
                self.drawFastVLine(x + 5, y, 8, bg)
            else:
                self.fillRect(x + 5 * size, y, size, 8 * size, bg)

    def printText(self, text, x, y, size=1, col=1, bg=None):
        cx = x
        for ch in text:
            self.drawChar(ch, cx, y, size, col, bg)
            cx += 6 * size

    def to_pil_image(self, scale=4, cyan_tint=True):
        img_w = self.width * scale
        img_h = self.height * scale
        img = Image.new("RGB", (img_w, img_h), (5, 7, 10))
        draw = ImageDraw.Draw(img)

        # Authentic monochrome OLED white / light cyan color
        pixel_color = (228, 248, 255) if cyan_tint else (255, 255, 255)

        for y in range(self.height):
            for x in range(self.width):
                if self.fb[y][x]:
                    px = x * scale
                    py = y * scale
                    draw.rectangle([px, py, px + scale - 1, py + scale - 1], fill=pixel_color)
        return img


# -------------------------------------------------------------
# 3. Exact Render Logic Replicated from firmware/src/oled.cpp
# -------------------------------------------------------------
def render_screen(
    display,
    is_active=True,
    key_label="D",
    travel_mm=1.85,
    active_key_idx=7,
    ripple_frame=0,
    layer_name="NUMPAD",
    rt_sens=0.20,
    rt_enabled=True,
    layer_idx=0,
    pill_text=None,
    redline_flash=True,
    wave_clock=0,
    a1_mode=True,
    overshoot_keys=None,
    key_travels=None,
):
    """
    Renders an exact frame matching firmware/src/oled.cpp.
    All text readouts (RT sensitivity, layer name, pill text) and animation states
    (A1 Plunge, ripple frame, redline flash) are fully parameterized.
    """
    display.clear()

    # 1. Header: Motorsport Checkered Flag + DriftPad V2 Banner + Speed Chevrons + Status Pill (Y: 0..10)
    # Micro Checkered Flag (X: 0..5, Y: 1..8) - 3 cols x 4 rows of 2x2 squares
    for r in range(4):
        for c in range(3):
            if (r + c) % 2 == 0:
                display.fillRect(c * 2, 1 + r * 2, 2, 2, 1)

    # Inverted Drift Speed Banner (X: 7..72, Y: 0..10) - 66 pixels wide
    display.fillRect(7, 0, 66, 10, 1)
    display.printText("DRIFTPAD V2", 8, 1, size=1, col=0, bg=1)

    # Slanted Kinetic Speed Chevrons /// (X: 77..85)
    # Clean 2px+ margin from banner at Y=10 (X: 72 vs X: 74)
    display.drawLine(77, 0, 74, 10, 1)
    display.drawLine(81, 0, 78, 10, 1)
    display.drawLine(85, 0, 82, 10, 1)

    # Right Status Pill (X: 87..126, Y: 0..10) - 40 pixels wide
    PILL_X = 87
    PILL_W = 40
    display.drawRoundRect(PILL_X, 0, PILL_W, 11, 2, 1)

    # Center pill text on measured width (prevent L0:NRM overflow at X=126/127)
    if pill_text is None:
        pill_text = f"L{layer_idx}:{'RT' if rt_enabled else 'NRM'}"
    pill_text_w = len(pill_text) * 6 - 1
    pill_text_x = PILL_X + (PILL_W - pill_text_w) // 2
    display.printText(pill_text, pill_text_x, 2, size=1, col=1)

    # Hairline divider with accent gap (Y: 11)
    display.drawFastHLine(0, 11, 65, 1)
    display.drawFastHLine(68, 11, 60, 1)

    # 2. Center Laser Divider (X: 66, Y: 12..62)
    for y in range(13, 62, 3):
        display.drawPixel(66, y, 1)
    display.drawFastHLine(64, 13, 5, 1)
    display.drawFastHLine(64, 61, 5, 1)

    # 3. Left Side: Active Key Cockpit vs Standby Cockpit
    if is_active:
        # Subtext with clean clearance
        display.printText("TRIGGERED", 6, 13, size=1, col=1)

        cx, cy, cw, ch = 5, 23, 54, 26
        # Top/bottom framing accents with clear spacing
        display.drawFastHLine(14, 21, 36, 1)
        display.drawFastHLine(14, 50, 36, 1)

        # Inverted filled card with chamfered corners
        display.fillRect(cx + 3, cy, cw - 3, ch, 1)
        display.fillRect(cx, cy + 3, 3, ch - 3, 1)
        display.drawPixel(cx, cy, 0)
        display.drawPixel(cx + 1, cy, 0)
        display.drawPixel(cx, cy + 1, 0)
        display.drawPixel(cx + cw - 1, cy + ch - 1, 0)
        display.drawPixel(cx + cw - 2, cy + ch - 1, 0)
        display.drawPixel(cx + cw - 1, cy + ch - 2, 0)

        # Inverted speed chevrons and centered label based on label length
        key_len = len(key_label)
        if key_len == 1:
            display.drawLine(12, 27, 9, 44, 0)
            display.drawLine(15, 27, 12, 44, 0)
            display.drawLine(49, 27, 46, 44, 0)
            display.drawLine(52, 27, 49, 44, 0)
            display.printText(key_label, cx + (cw - 15) // 2, cy + (ch - 21) // 2, size=3, col=0, bg=1)
        elif key_len == 2:
            display.drawLine(10, 27, 8, 44, 0)
            display.drawLine(54, 27, 52, 44, 0)
            display.printText(key_label, cx + (cw - 22) // 2, cy + (ch - 14) // 2, size=2, col=0, bg=1)
        elif key_len == 3:
            display.printText(key_label, cx + (cw - 34) // 2, cy + (ch - 14) // 2, size=2, col=0, bg=1)
        elif key_len == 4:
            display.printText(key_label, cx + (cw - 46) // 2, cy + (ch - 14) // 2, size=2, col=0, bg=1)
        else:
            display.printText(key_label, cx + 4, cy + (ch - 8) // 2, size=1, col=0, bg=1)

        # Sub-Telemetry: Depth readout (X: 3..37) + Formula Drift Motec Tachometer (X: 41..63)
        display.printText(f"{travel_mm:.2f}mm", 3, 53, size=1, col=1)

        # 6-Stage Motec Tachometer with Angled Speed Chevrons /// (X: 41..63, Y: 52..59)
        active_segs = int((travel_mm / 4.0) * 6.0)
        if is_active and active_segs < 3: active_segs = 3
        if active_segs > 6: active_segs = 6

        for s in range(5):
            sx = 41 + s * 4
            if s < active_segs:
                display.drawLine(sx, 59, sx + 2, 53, 1)
                display.drawLine(sx + 1, 59, sx + 3, 53, 1)
            else:
                display.drawPixel(sx + 1, 59, 1)

        # Segment 5: Redline shift block (X: 61..63) with redline_flash support
        if active_segs >= 6 or is_active:
            if redline_flash:
                display.fillRect(61, 52, 3, 8, 1)  # Strobe F1 Shift Light
            else:
                display.drawRect(61, 52, 3, 8, 1)  # Outlined resting block
        else:
            display.drawPixel(62, 59, 1)
    else:
        # Standby Cockpit Mode - Zero Text Overlap Layout
        display.drawRoundRect(4, 14, 57, 47, 2, 1)
        display.printText("STATUS:", 8, 17, size=1, col=1)
        # Pulsing status diamond
        display.fillRect(50, 18, 5, 5, 1)
        display.drawPixel(50, 18, 0)
        display.drawPixel(54, 18, 0)
        display.drawPixel(50, 22, 0)
        display.drawPixel(54, 22, 0)

        # Bold Inverted STANDBY Badge (X: 7..57, W: 51)
        display.fillRect(7, 26, 51, 10, 1)
        display.printText("STANDBY", 13, 27, size=1, col=0, bg=1)

        # Informative RT Sensitivity Readout (parameterized: "RT 0.15mm")
        rt_str = f"RT {rt_sens:.2f}mm"
        display.printText(rt_str, 6, 38, size=1, col=1)

        # Active Layer centered (parameterized: "NUMPAD", "NAVIG", "GAMING", etc.)
        layer_str = str(layer_name)
        layer_w = len(layer_str) * 6 - 1
        layer_x = 4 + (57 - layer_w) // 2
        display.printText(layer_str, layer_x, 47, size=1, col=1)

        # Live Hall-Effect Sensor Telemetry Oscilloscope Waveform (X: 7..57, Y: 56..60)
        # C-style integer truncation towards zero for sineTable/2 (int(v / 2))
        sine_table = [0, 1, 2, 2, 3, 2, 2, 1, 0, -1, -2, -2, -3, -2, -2, -1]
        for x in range(7, 58):
            wy = 58 + int(sine_table[(x + wave_clock) % 16] / 2)
            display.drawPixel(x, wy, 1)

    # 4. Right Side: 4x4 Live Matrix with A1 Plunge Animation (X: 69..123, Y: 15..60)
    GRID_X = 69
    GRID_Y = 15
    BOX_W  = 11
    BOX_H  = 9
    GAP_X  = 3
    GAP_Y  = 3

    if overshoot_keys is None:
        overshoot_keys = set()

    for row in range(4):
        for col in range(4):
            key_idx = row * 4 + col
            bx = GRID_X + col * (BOX_W + GAP_X)
            by = GRID_Y + row * (BOX_H + GAP_Y)
            pressed = (is_active and key_idx == active_key_idx)
            is_macro = (key_idx in [4, 8, 12, 13])

            if a1_mode:
                if key_travels and key_idx in key_travels:
                    t = key_travels[key_idx]
                elif pressed:
                    t = travel_mm
                else:
                    t = 0.0

                if key_idx in overshoot_keys:
                    inset = -1
                else:
                    inset = min(3, int(t / 4.0 * 4.0 + 0.5))
                    if inset < 0:
                        inset = 0

                top = by + inset

                if pressed:
                    # A1 Plunge: Solid fill on actuation
                    display.fillRoundRect(bx, top, BOX_W, BOX_H - inset, r=2, col=1)
                else:
                    # A1 Plunge: Unpressed outline sinking with analog travel
                    display.drawRoundRect(bx, top, BOX_W, BOX_H - inset, 1, 1)
                    if inset <= 0:
                        display.drawFastHLine(bx + 2, top + 1, BOX_W - 4, 1)
                    if is_macro:
                        display.drawPixel(bx + 2, top + 2, 1)

                # Fixed switch-plate base lip (1px below box: by + BOX_H = by + 9)
                display.drawFastHLine(bx + 1, by + BOX_H, BOX_W - 2, 1)

            else:
                # Legacy ripple/halo mode
                if pressed:
                    if ripple_frame > 0:
                        r = 1
                        if ripple_frame <= 2:
                            display.drawRoundRect(bx - r, by + 1 - r, BOX_W + 2 * r, 8 + 2 * r, 2, 1)
                        else:
                            display.drawPixel(bx - r, by + 1 - r, 1)
                            display.drawPixel(bx + BOX_W + r - 1, by + 1 - r, 1)
                            display.drawPixel(bx - r, by + 8 + r, 1)
                            display.drawPixel(bx + BOX_W + r - 1, by + 8 + r, 1)
                        if ripple_frame == 1:
                            display.drawPixel(bx - 2, by + 2, 1)
                            display.drawPixel(bx + BOX_W + 1, by + 2, 1)

                    display.fillRect(bx, by + 2, BOX_W, 7, 1)
                    display.drawPixel(bx, by + 2, 0)
                    display.drawPixel(bx + BOX_W - 1, by + 2, 0)
                    display.drawPixel(bx, by + 8, 0)
                    display.drawPixel(bx + BOX_W - 1, by + 8, 0)
                    display.drawPixel(bx + 5, by + 5, 0)
                    display.drawPixel(bx + 4, by + 5, 0)
                    display.drawPixel(bx + 6, by + 5, 0)
                    display.drawPixel(bx + 5, by + 4, 0)
                    display.drawPixel(bx + 5, by + 6, 0)
                else:
                    display.drawRoundRect(bx, by, BOX_W, 7, 1, 1)
                    display.drawFastHLine(bx + 2, by + 1, BOX_W - 4, 1)
                    display.drawFastHLine(bx + 1, by + 8, BOX_W - 2, 1)
                    display.drawPixel(bx, by + 7, 1)
                    display.drawPixel(bx + BOX_W - 1, by + 7, 1)
                    if is_macro:
                        display.drawPixel(bx + 2, by + 2, 1)
                        display.drawPixel(bx + 3, by + 3, 1)

    # 5. Tactical HUD Corner Reticles / Brackets
    display.drawFastHLine(0, 0, 8, 1)
    display.drawFastVLine(0, 0, 6, 1)
    display.drawFastHLine(119, 0, 9, 1)
    display.drawFastVLine(127, 0, 6, 1)
    display.drawFastHLine(0, 63, 8, 1)
    display.drawFastVLine(0, 57, 7, 1)
    display.drawFastHLine(119, 63, 9, 1)
    display.drawFastVLine(127, 57, 7, 1)


# -------------------------------------------------------------
# 4. Generate & Save PNGs to figures/
# -------------------------------------------------------------
def build_composite_gallery(images, titles, cols=2, scale=4, pad=20, card_gap=25):
    """Generates an aesthetic multi-card showcase gallery image."""
    n = len(images)
    rows = (n + cols - 1) // cols
    card_w = 128 * scale
    card_h = 64 * scale
    label_h = 24

    total_w = pad * 2 + cols * card_w + (cols - 1) * card_gap
    total_h = pad * 2 + rows * (card_h + label_h + 10) + (rows - 1) * card_gap

    gallery = Image.new("RGB", (total_w, total_h), (8, 12, 18))
    draw = ImageDraw.Draw(gallery)

    # Cyan top accent bar
    draw.rectangle([0, 0, total_w, 4], fill=(0, 242, 254))

    for idx, (img, title) in enumerate(zip(images, titles)):
        r = idx // cols
        c = idx % cols
        x = pad + c * (card_w + card_gap)
        y = pad + r * (card_h + label_h + card_gap + 10)

        # Title text (draw directly from glcdfont glyphs across full card width without clipping)
        cx = x
        for ch in title.upper():
            ascii_code = ord(ch)
            if ascii_code < 256:
                glyph_bytes = hex_vals[ascii_code * 5 : (ascii_code + 1) * 5]
                for col_idx in range(5):
                    line = glyph_bytes[col_idx]
                    for row_idx in range(8):
                        if line & (1 << row_idx):
                            px = cx + col_idx * 2
                            py = y + row_idx * 2
                            draw.rectangle([px, py, px + 1, py + 1], fill=(0, 242, 254))
            cx += 12  # 6px * 2 = 12px per character

        # Viewport border & image paste
        y_card = y + label_h
        gallery.paste(img, (x, y_card))
        draw.rectangle([x - 2, y_card - 2, x + card_w + 1, y_card + card_h + 1], outline=(0, 180, 230), width=2)

    return gallery


def main():
    disp = OLEDDisplay()

    # Destination directory: figures/ in repository root
    figures_dir = os.path.join(PROJECT_ROOT, "figures")
    os.makedirs(figures_dir, exist_ok=True)

    # Also mirror to brain artifact directory if accessible
    artifact_dir = r"C:\Users\devyn\.gemini\antigravity\brain\5718f2fc-a709-431c-bfa8-22edc30be32b"

    print(f"Rendering pixel-accurate OLED PNGs to: {figures_dir}")

    # ---------------------------------------------------------
    # Core States
    # ---------------------------------------------------------
    # 1. Cockpit Standby Screen (Default RT Sensitivity: 0.20mm)
    render_screen(disp, is_active=False, layer_name="NUMPAD", rt_sens=0.20, rt_enabled=True, pill_text="L0:RT")
    img_standby = disp.to_pil_image(scale=6)
    path_standby = os.path.join(figures_dir, "driftpad_oled_standby.png")
    img_standby.save(path_standby)
    print(f"  [OK] Standby screen: {path_standby}")

    # 2. Standard Actuated Screen (Key 'D' @ 1.85mm, A1 Plunge solid fill, redline flash)
    render_screen(disp, is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, redline_flash=True)
    img_actuated = disp.to_pil_image(scale=6)
    path_actuated = os.path.join(figures_dir, "driftpad_oled_actuated.png")
    img_actuated.save(path_actuated)
    print(f"  [OK] Actuated screen: {path_actuated}")

    # ---------------------------------------------------------
    # Edge Cases & A1 Animation Demonstrations
    # ---------------------------------------------------------
    # Edge Case 1: NRM pill (rt_enabled=False -> "L0:NRM" centered on measured width, no overflow at X=126/127)
    render_screen(disp, is_active=False, rt_enabled=False, pill_text="L0:NRM")
    img_nrm_pill = disp.to_pil_image(scale=6)
    path_nrm = os.path.join(figures_dir, "driftpad_oled_edge_nrm_pill.png")
    img_nrm_pill.save(path_nrm)
    print(f"  [OK] Edge Case: NRM pill centered: {path_nrm}")

    # Edge Case 2: 4-character label "HOME" (Navigation Layer 1, Key 1 @ 2.50mm)
    render_screen(disp, is_active=True, key_label="HOME", travel_mm=2.50, active_key_idx=1, layer_name="NAVIG", layer_idx=1, pill_text="L1:RT")
    img_home = disp.to_pil_image(scale=6)
    path_home = os.path.join(figures_dir, "driftpad_oled_edge_label_home.png")
    img_home.save(path_home)
    print(f"  [OK] Edge Case: 4-char label HOME: {path_home}")

    # Edge Case 3: 4-character label "PGUP" (Navigation Layer 1, Key 3 @ 3.20mm)
    render_screen(disp, is_active=True, key_label="PGUP", travel_mm=3.20, active_key_idx=3, layer_name="NAVIG", layer_idx=1, pill_text="L1:RT")
    img_pgup = disp.to_pil_image(scale=6)
    path_pgup = os.path.join(figures_dir, "driftpad_oled_edge_label_pgup.png")
    img_pgup.save(path_pgup)
    print(f"  [OK] Edge Case: 4-char label PGUP: {path_pgup}")

    # Edge Case 4: A1 Travel Plunge (Key 'D' traveling down @ 2.50mm, sinking 2px before trip)
    render_screen(disp, is_active=False, key_travels={7: 2.50})
    img_a1_plunge = disp.to_pil_image(scale=6)
    path_a1_plunge = os.path.join(figures_dir, "driftpad_oled_edge_a1_plunge.png")
    img_a1_plunge.save(path_a1_plunge)
    print(f"  [OK] Edge Case: A1 Travel Plunge (2.50mm): {path_a1_plunge}")

    # Edge Case 5: A1 Fast Tap (Actuate + release within 1 frame interval: latched solid frame)
    render_screen(disp, is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, redline_flash=True)
    img_a1_fast_tap = disp.to_pil_image(scale=6)
    path_a1_fast_tap = os.path.join(figures_dir, "driftpad_oled_edge_a1_fast_tap.png")
    img_a1_fast_tap.save(path_a1_fast_tap)
    print(f"  [OK] Edge Case: A1 Fast Tap (Latched Frame): {path_a1_fast_tap}")

    # Edge Case 6: A1 Release Overshoot (Spring rebound 1px above box: top = by - 1, inset = -1)
    render_screen(disp, is_active=False, overshoot_keys={7})
    img_a1_overshoot = disp.to_pil_image(scale=6)
    path_a1_overshoot = os.path.join(figures_dir, "driftpad_oled_edge_a1_overshoot.png")
    img_a1_overshoot.save(path_a1_overshoot)
    print(f"  [OK] Edge Case: A1 Release Overshoot (-1px): {path_a1_overshoot}")

    # Edge Case 7: Legacy Ripple frame 1 (Key 'D', r=1 halo + 2 sparks strictly within 3px gap)
    render_screen(disp, is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, ripple_frame=1, a1_mode=False)
    img_ripple1 = disp.to_pil_image(scale=6)
    path_r1 = os.path.join(figures_dir, "driftpad_oled_edge_ripple_frame1.png")
    img_ripple1.save(path_r1)
    print(f"  [OK] Edge Case: Ripple frame 1 (halo + sparks): {path_r1}")

    # Edge Case 8: Legacy Ripple frame 2 (Key 'D', r=1 halo, sparks dropped for frames >= 2)
    render_screen(disp, is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, ripple_frame=2, a1_mode=False)
    img_ripple2 = disp.to_pil_image(scale=6)
    path_r2 = os.path.join(figures_dir, "driftpad_oled_edge_ripple_frame2.png")
    img_ripple2.save(path_r2)
    print(f"  [OK] Edge Case: Ripple frame 2 (halo only): {path_r2}")

    # Edge Case 9: Legacy Ripple frame 3 (Key 'D', dissipated corner ticks, no sparks, halo capped at r=1)
    render_screen(disp, is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, ripple_frame=3, a1_mode=False)
    img_ripple3 = disp.to_pil_image(scale=6)
    path_r3 = os.path.join(figures_dir, "driftpad_oled_edge_ripple_frame3.png")
    img_ripple3.save(path_r3)
    print(f"  [OK] Edge Case: Ripple frame 3 (dissipated corners): {path_r3}")

    # Edge Case 10: Redline Shift Block resting / off-strobe (redline_flash=False)
    render_screen(disp, is_active=True, key_label="D", travel_mm=4.00, active_key_idx=7, redline_flash=False)
    img_redline_off = disp.to_pil_image(scale=6)
    path_redline_off = os.path.join(figures_dir, "driftpad_oled_edge_redline_outline.png")
    img_redline_off.save(path_redline_off)
    print(f"  [OK] Edge Case: Redline resting outline: {path_redline_off}")

    # ---------------------------------------------------------
    # Dual Showcase (Standby vs Actuated)
    # ---------------------------------------------------------
    card_w = 128 * 5
    card_h = 64 * 5
    gap = 40
    pad = 30
    header_h = 70
    footer_h = 40

    total_w = pad * 2 + card_w * 2 + gap
    total_h = pad * 2 + header_h + card_h + footer_h

    showcase = Image.new("RGB", (total_w, total_h), (10, 14, 20))
    draw = ImageDraw.Draw(showcase)
    draw.rectangle([0, 0, total_w, 6], fill=(0, 242, 254))

    render_screen(disp, is_active=False, layer_name="NUMPAD", rt_sens=0.20, rt_enabled=True, pill_text="L0:RT")
    img1 = disp.to_pil_image(scale=5)
    render_screen(disp, is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, redline_flash=True)
    img2 = disp.to_pil_image(scale=5)

    x1 = pad
    y_screen = pad + header_h
    showcase.paste(img1, (x1, y_screen))
    x2 = pad + card_w + gap
    showcase.paste(img2, (x2, y_screen))

    draw.rectangle([x1 - 2, y_screen - 2, x1 + card_w + 1, y_screen + card_h + 1], outline=(0, 200, 255), width=2)
    draw.rectangle([x2 - 2, y_screen - 2, x2 + card_w + 1, y_screen + card_h + 1], outline=(0, 200, 255), width=2)

    path_showcase = os.path.join(figures_dir, "driftpad_oled_showcase.png")
    showcase.save(path_showcase)
    print(f"  [OK] Dual showcase saved to: {path_showcase}")

    # Also save to project root
    showcase.save(os.path.join(PROJECT_ROOT, "driftpad_oled_showcase.png"))

    # ---------------------------------------------------------
    # Comprehensive Edge Cases Composite Gallery (8-card showcase)
    # ---------------------------------------------------------
    edge_configs = [
        ("NRM Pill (Zero Overlap)", dict(is_active=False, rt_enabled=False, pill_text="L0:NRM")),
        ("4-Char: HOME Key", dict(is_active=True, key_label="HOME", travel_mm=2.50, active_key_idx=1, layer_name="NAVIG", layer_idx=1, pill_text="L1:RT")),
        ("4-Char: PGUP Key", dict(is_active=True, key_label="PGUP", travel_mm=3.20, active_key_idx=3, layer_name="NAVIG", layer_idx=1, pill_text="L1:RT")),
        ("A1: Travel Plunge (2.5mm)", dict(is_active=False, key_travels={7: 2.50})),
        ("A1: Actuated Lock (Solid)", dict(is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7)),
        ("A1: Release Overshoot (-1px)", dict(is_active=False, overshoot_keys={7})),
        ("A1: Fast Tap (Latched Frame)", dict(is_active=True, key_label="D", travel_mm=1.85, active_key_idx=7, redline_flash=True)),
        ("A1: Fast Tap Rebound (-1px)", dict(is_active=False, overshoot_keys={7})),
    ]

    rendered_edge_imgs = []
    titles = []
    for title, cfg in edge_configs:
        render_screen(disp, **cfg)
        rendered_edge_imgs.append(disp.to_pil_image(scale=4))
        titles.append(title)

    edge_gallery = build_composite_gallery(rendered_edge_imgs, titles, cols=2, scale=4)
    path_gallery = os.path.join(figures_dir, "driftpad_oled_edge_showcase.png")
    edge_gallery.save(path_gallery)
    print(f"  [OK] Edge Cases composite gallery saved to: {path_gallery}")

    # ---------------------------------------------------------
    # Mirror artifacts to brain directory if present
    # ---------------------------------------------------------
    if os.path.isdir(artifact_dir):
        for name in [
            "driftpad_oled_standby.png",
            "driftpad_oled_actuated.png",
            "driftpad_oled_showcase.png",
            "driftpad_oled_edge_showcase.png",
            "driftpad_oled_edge_nrm_pill.png",
            "driftpad_oled_edge_label_home.png",
            "driftpad_oled_edge_label_pgup.png",
            "driftpad_oled_edge_a1_plunge.png",
            "driftpad_oled_edge_a1_fast_tap.png",
            "driftpad_oled_edge_a1_overshoot.png",
            "driftpad_oled_edge_ripple_frame1.png",
            "driftpad_oled_edge_ripple_frame2.png",
            "driftpad_oled_edge_ripple_frame3.png",
            "driftpad_oled_edge_redline_outline.png",
        ]:
            src = os.path.join(figures_dir, name)
            if os.path.exists(src):
                shutil.copy(src, os.path.join(artifact_dir, name))
        print("  [OK] Mirrored all figures to brain artifacts directory.")

    print("\n[SUCCESS] All requested OLED PNGs and edge cases rendered successfully.")


if __name__ == "__main__":
    main()
