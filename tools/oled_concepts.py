#!/usr/bin/env python3
"""
oled_concepts.py - Design options for the DriftPad OLED (layouts + key-press animations).

Renders with the same GLCD font / GFX primitives as render_oled_png.py, driven by a
simulated input timeline run through the real rapid-trigger rules (ACT 1.20mm, RT 0.20mm,
4.0mm travel). Every text draw is bounds-checked against the region it belongs to, and
the script exits non-zero if anything overflows.

Output: docs/oled_concepts/  (GIFs, stills, contact sheet)
Run from the repo root:  python tools/oled_concepts.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_oled_png as R  # noqa: E402  (loads glcdfont.c relative to repo root)
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

OUT = os.path.join("docs", "oled_concepts")
LABELS = ["ESC", "7", "8", "9", "M1", "4", "5", "6", "M2", "1", "2", "3", "M3", "M4", "0", "ENT"]
ACT, RT, TOT = 1.20, 0.20, 4.0
N_FRAMES = 64
FRAME_MS = 33          # firmware RENDER_INTERVAL_MS
GIF_MS = 66            # GIFs play at half speed so the frames are readable
SCALE = 4

violations = []


# -------------------------------------------------------------
# Display with a few extra primitives (all have direct GFX equivalents)
# -------------------------------------------------------------
class D(R.OLEDDisplay):
    def xorPixel(self, x, y):                       # SSD1306_INVERSE
        if 0 <= x < self.width and 0 <= y < self.height:
            self.fb[y][x] ^= 1

    def xorRect(self, x, y, w, h):
        for j in range(h):
            for i in range(w):
                self.xorPixel(x + i, y + j)

    def fillRoundRect2(self, x, y, w, h, col=1):   # fillRoundRect(x, y, w, h, 2, col)
        self.fillRect(x, y, w, h, col)
        bg = 1 - col
        for px, py in ((x, y), (x + 1, y), (x, y + 1),
                       (x + w - 1, y), (x + w - 2, y), (x + w - 1, y + 1),
                       (x, y + h - 1), (x + 1, y + h - 1), (x, y + h - 2),
                       (x + w - 1, y + h - 1), (x + w - 2, y + h - 1), (x + w - 1, y + h - 2)):
            self.drawPixel(px, py, bg)

    def text(self, s, x, y, box, size=1, col=1, bg=None, xor=False):
        """Draw text, recording a violation if the ink leaves `box` (x0, y0, x1, y1 inclusive)."""
        w, h = tw(s, size), 7 * size
        x0, y0, x1, y1 = box
        if x < x0 or y < y0 or x + w - 1 > x1 or y + h - 1 > y1:
            violations.append(f"'{s}' at ({x},{y}) size {size} spans x{x}..{x + w - 1} y{y}..{y + h - 1}, box {box}")
        if xor:
            for px, py in glyph_pixels(s, x, y, size):
                self.xorPixel(px, py)
        else:
            self.printText(s, x, y, size, col, bg)


def tw(s, size=1):
    return len(s) * 6 * size - size


def glyph_pixels(s, x, y, size=1):
    for i, ch in enumerate(s):
        g = R.hex_vals[ord(ch) * 5:(ord(ch) + 1) * 5]
        for cx in range(5):
            for ry in range(8):
                if (g[cx] >> ry) & 1:
                    for dx in range(size):
                        for dy in range(size):
                            yield x + i * 6 * size + cx * size + dx, y + ry * size + dy


def line_pts(x0, y0, x1, y1):
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
    err = dx - dy
    while True:
        yield x0, y0
        if x0 == x1 and y0 == y1:
            return
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy


# -------------------------------------------------------------
# Input simulation with real rapid-trigger state machine
# -------------------------------------------------------------
def build_timeline():
    tr = [[0.0] * 16 for _ in range(N_FRAMES)]

    def ramp(k, f0, f1, a, b):
        for f in range(f0, f1 + 1):
            tr[f][k] = a + (b - a) * (f - f0) / max(1, f1 - f0)

    def seq(k, f0, vals):
        for i, v in enumerate(vals):
            tr[f0 + i][k] = v

    ramp(6, 2, 7, 0.0, 2.6); ramp(6, 7, 13, 2.6, 2.6); ramp(6, 13, 17, 2.6, 0.0)       # "5": normal press
    ramp(9, 20, 23, 0.0, 1.8)                                                           # "1": RT taps
    seq(9, 24, [1.6, 1.45, 1.65, 1.9, 1.7, 1.5, 1.75, 1.95, 1.6, 1.85, 1.85, 1.7])
    ramp(9, 36, 40, 1.7, 0.0)
    ramp(15, 44, 48, 0.0, 4.0); ramp(15, 48, 54, 4.0, 4.0); ramp(15, 54, 57, 4.0, 0.0)  # "ENT": bottom-out
    ramp(1, 46, 48, 0.0, 2.2); ramp(1, 48, 52, 2.2, 2.2); ramp(1, 52, 54, 2.2, 0.0)     # "7": simultaneous

    frames = []
    pressed, ext = [False] * 16, [0.0] * 16
    since_p, since_r = [99] * 16, [99] * 16
    last_key, prev_t = -1, [0.0] * 16
    for f in range(N_FRAMES):
        st = []
        for k in range(16):
            t = tr[f][k]
            since_p[k] += 1
            since_r[k] += 1
            if not pressed[k]:
                ext[k] = min(ext[k], t)
                if t >= ACT and t >= ext[k] + RT:
                    pressed[k], ext[k], since_p[k] = True, t, 0
            else:
                ext[k] = max(ext[k], t)
                if t <= ext[k] - RT:
                    pressed[k], ext[k], since_r[k] = False, t, 0
            if t > 0.10 and prev_t[k] <= 0.10:
                last_key = k
            prev_t[k] = t
            st.append(dict(t=t, p=pressed[k], sp=since_p[k], sr=since_r[k], label=LABELS[k]))
        lk = last_key if last_key >= 0 and (st[last_key]["p"] or st[last_key]["t"] > 0.10) else -1
        frames.append(dict(keys=st, last=lk))
    return frames


# -------------------------------------------------------------
# Press animations - drop-in for the current right-hand grid
# (GRID 69,15  BOX 11x9  GAP 3). Nothing draws more than 1px outside
# its own box, so no animation can touch a neighbouring key.
# -------------------------------------------------------------
BX, BY, BW, BH, GX, GY = 69, 15, 11, 9, 3, 3


def anim_plunge(d, bx, by, k):
    """A1 PLUNGE: cap top sinks with analog travel; solid on actuation; 1-frame overshoot on release."""
    inset = min(3, int(k["t"] / TOT * 4 + 0.5))
    if k["sr"] == 0:
        inset = -1
    top = by + inset
    if k["p"]:
        d.fillRoundRect2(bx, top, BW, BH - inset)
    else:
        d.drawRoundRect(bx, top, BW, BH - inset, 1)
        if inset <= 0:
            d.drawFastHLine(bx + 2, top + 1, BW - 4)        # specular line only when fully up
    d.drawFastHLine(bx + 1, by + BH, BW - 2)                # fixed switch-plate lip (1px below box)


def anim_depth_ring(d, bx, by, k):
    """A2 DEPTH + RING: fill level = travel, ring in the gap = actuated. RT taps show as ring flicker."""
    d.drawRoundRect(bx, by, BW, BH, 1)
    fh = int(k["t"] / TOT * (BH - 2) + 0.5)
    if fh:
        d.fillRect(bx + 1, by + BH - 1 - fh, BW - 2, fh)
    ay = by + BH - 1 - int(ACT / TOT * (BH - 2) + 0.5)      # actuation notch on both sides
    d.xorPixel(bx, ay)
    d.xorPixel(bx + BW - 1, ay)
    if k["p"]:
        d.drawRoundRect(bx - 1, by - 1, BW + 2, BH + 2, 2)


def anim_brackets(d, bx, by, k):
    """A3 BRACKETS: idle keys are corner ticks only (quiet screen); travel pulls ticks inward; press fills."""
    if k["p"]:
        d.fillRoundRect2(bx, by, BW, BH)
        if k["sp"] == 0:                                    # snap flash: invert for one frame
            d.xorRect(bx + 2, by + 2, BW - 4, BH - 4)
        return
    i = min(2, int(k["t"] / ACT * 2))                       # 0..2 px inward before actuation
    x0, y0, x1, y1 = bx + i, by + i, bx + BW - 1 - i, by + BH - 1 - i
    for cx, cy, sx, sy in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        d.drawFastHLine(min(cx, cx + sx * 2), cy, 3)
        d.drawFastVLine(cx, min(cy, cy + sy * 2), 3)


def anim_afterglow(d, bx, by, k):
    """A4 AFTERGLOW: solid while held, then a dithered fade over 4 frames after release."""
    if k["p"]:
        d.fillRoundRect2(bx, by, BW, BH)
        return
    d.drawRoundRect(bx, by, BW, BH, 1)
    if k["sr"] < 4:
        step = (2, 2, 3, 4)[k["sr"]]                        # 50% -> 50% -> 33% -> 25%
        for y in range(by + 1, by + BH - 1):
            for x in range(bx + 1, bx + BW - 1):
                if (x + y * (1 if step == 2 else 2)) % step == 0:
                    d.drawPixel(x, y)
    elif k["t"] > 0.10:                                     # pre-travel underline
        w = max(1, int(k["t"] / ACT * (BW - 4)))
        d.drawFastHLine(bx + 2, by + BH - 2, min(w, BW - 4))


def anim_safe_halo(d, bx, by, k):
    """A5 SAFE HALO: Gemini's current keycap, halo limited to r=1 for 2 frames, no sparks."""
    if k["p"]:
        if k["sp"] <= 1:
            d.drawRoundRect(bx - 1, by, BW + 2, 10, 2)
        d.fillRect(bx, by + 2, BW, 7)
        for px, py in ((bx, by + 2), (bx + BW - 1, by + 2), (bx, by + 8), (bx + BW - 1, by + 8),
                       (bx + 5, by + 5), (bx + 4, by + 5), (bx + 6, by + 5), (bx + 5, by + 4), (bx + 5, by + 6)):
            d.drawPixel(px, py, 0)
    else:
        d.drawRoundRect(bx, by, BW, 7, 1)
        d.drawFastHLine(bx + 2, by + 1, BW - 4)
        d.drawFastHLine(bx + 1, by + 8, BW - 2)
        d.drawPixel(bx, by + 7)
        d.drawPixel(bx + BW - 1, by + 7)
        if k["t"] > 0.15:
            fh = min(5, int(k["t"] / 2.0 * 5))
            if fh:
                d.fillRect(bx + 1, by + 6 - fh, BW - 2, fh)


ANIMS = [
    ("A1", "Plunge", anim_plunge),
    ("A2", "Depth + Ring", anim_depth_ring),
    ("A3", "Brackets", anim_brackets),
    ("A4", "Afterglow", anim_afterglow),
    ("A5", "Safe Halo (minimal fix)", anim_safe_halo),
]


def render_anim_frame(d, fr, fn):
    """Current firmware screen, with the right-hand grid swapped for animation `fn`."""
    lk = fr["last"]
    if lk >= 0:
        k = fr["keys"][lk]
        R.render_screen(d, is_active=True, key_label=k["label"], travel_mm=k["t"], active_key_idx=-1, ripple_frame=0)
        if not k["p"]:
            d.fillRect(6, 13, 53, 8, 0)
            d.printText("STROKE:RT", 6, 13)
    else:
        R.render_screen(d, is_active=False)
    d.fillRect(67, 12, 60, 51, 0)
    d.drawFastHLine(64, 13, 5)
    d.drawFastHLine(64, 61, 5)
    for i in range(16):
        bx = BX + (i % 4) * (BW + GX)
        by = BY + (i // 4) * (BH + GY)
        fn(d, bx, by, fr["keys"][i])


# -------------------------------------------------------------
# Full-screen layout concepts
# -------------------------------------------------------------
def layout_keymap(d, fr):
    """L1 KEYMAP: full-width grid showing the real legends. Fill rises with travel; label XORs over it."""
    d.clear()
    d.fillRoundRect2(0, 0, 41, 9)
    d.text("NUMPAD", 3, 1, (0, 0, 40, 8), col=0)
    # live travel bar for last active key (0..4mm) with actuation tick
    d.drawRect(45, 1, 41, 7)
    lk = fr["last"]
    t = fr["keys"][lk]["t"] if lk >= 0 else 0.0
    fw = int(t / TOT * 39 + 0.5)
    if fw:
        d.fillRect(46, 2, fw, 5)
    ax = 46 + int(ACT / TOT * 39 + 0.5)
    d.drawPixel(ax, 0)
    d.drawPixel(ax, 8)
    d.text("RT.20", 128 - tw("RT.20"), 1, (89, 0, 127, 8))
    KW, KH = 31, 12
    for i, k in enumerate(fr["keys"]):
        x = (i % 4) * (KW + 1)
        y = 11 + (i // 4) * (KH + 1)
        if k["p"]:
            d.fillRoundRect2(x, y, KW, KH)
        else:
            d.drawRoundRect(x, y, KW, KH, 2)
            fh = int(k["t"] / TOT * (KH - 2) + 0.5)
            if fh:
                d.fillRect(x + 1, y + KH - 1 - fh, KW - 2, fh)
        lx = x + (KW - tw(k["label"])) // 2
        d.text(k["label"], lx, y + 3, (x + 1, y + 1, x + KW - 2, y + KH - 2), xor=True)


def layout_spectrum(d, fr):
    """L2 SPECTRUM: left = focused key; right = 16 live travel bars. Dithered bar = moving, solid = actuated."""
    d.clear()
    L = (0, 0, 66, 63)
    d.text("L0 NUMPAD", 0, 0, L)
    for y in range(0, 64, 3):
        d.drawPixel(68, y)
    lk = fr["last"]
    if lk >= 0:
        k = fr["keys"][lk]
        size = 3 if len(k["label"]) <= 2 else 2
        d.text(k["label"], (67 - tw(k["label"], size)) // 2, 14 if size == 3 else 17, L, size=size)
        s = f"{k['t']:.2f}mm"
        d.text(s, (67 - tw(s)) // 2, 40, L)
        chip = "ACTUATED" if k["p"] else "RELEASED"
        cx = (67 - tw(chip)) // 2
        if k["p"]:
            d.fillRoundRect2(cx - 3, 51, tw(chip) + 6, 11)
            d.text(chip, cx, 53, L, col=0)
        else:
            d.drawRoundRect(cx - 3, 51, tw(chip) + 6, 11, 2)
            d.text(chip, cx, 53, L)
    else:
        d.text("ACT 1.20mm", 3, 18, L)
        d.text("RT  0.20mm", 3, 29, L)
        cx = (67 - tw("READY")) // 2
        d.drawRoundRect(cx - 3, 51, tw("READY") + 6, 11, 2)
        d.text("READY", cx, 53, L)
    # bars: 4 groups (rows) of 4, bar 2px, gap 1, group gap 3 -> x 72..124
    top, base = 4, 56
    span = base - top
    ay = base - int(ACT / TOT * span + 0.5)
    for x in range(72, 125, 2):
        d.drawPixel(x, ay)
    for i, k in enumerate(fr["keys"]):
        x = 72 + (i // 4) * 14 + (i % 4) * 3
        h = int(k["t"] / TOT * span + 0.5)
        if h:
            if k["p"]:
                d.fillRect(x, base - h, 2, h)
            else:
                for yy in range(base - h, base):
                    d.drawPixel(x + (yy & 1), yy)
                d.drawFastHLine(x, base - h, 2)
        d.drawPixel(x, base + 2)
        d.drawPixel(x + 1, base + 2)
    d.drawFastHLine(72, base + 1, 53)


def layout_tach(d, fr):
    """L3 TACH: motorsport gauge for the focused key; the shaded arc past the shift mark is the actuation zone."""
    d.clear()
    L = (0, 0, 62, 63)
    d.text("L0", 0, 0, L)
    d.drawRoundRect(88, 0, 40, 10, 2)
    d.text("RT ON", 88 + (40 - tw("RT ON")) // 2, 1, (89, 0, 126, 9))
    for y in range(12, 64, 3):
        d.drawPixel(64, y)
    d.drawFastHLine(0, 10, 128)
    cx, cy, r = 31, 62, 27
    act_a = 180 - ACT / TOT * 180
    for a10 in range(0, 1801, 5):
        a = a10 / 10
        ra = math.radians(a)
        d.drawPixel(round(cx + r * math.cos(ra)), round(cy - r * math.sin(ra)))
        if a <= act_a:                                      # thick "redline" band = actuation zone
            for rr in (r - 1, r - 2):
                d.drawPixel(round(cx + rr * math.cos(ra)), round(cy - rr * math.sin(ra)))
    for mm in range(5):
        ra = math.radians(180 - mm / TOT * 180)
        for rr in (r + 2, r + 3):
            d.drawPixel(round(cx + rr * math.cos(ra)), round(cy - rr * math.sin(ra)))
    lk = fr["last"]
    k = fr["keys"][lk] if lk >= 0 else None
    t = k["t"] if k else 0.0
    ra = math.radians(180 - t / TOT * 180)
    nx, ny = round(cx + (r - 4) * math.cos(ra)), round(cy - (r - 4) * math.sin(ra))
    ix, iy = round(cx + 16 * math.cos(ra)), round(cy - 16 * math.sin(ra))
    for px, py in line_pts(ix, iy, nx, ny):
        d.drawPixel(px, py)
    readout = f"{t:.2f}"
    d.text(readout, cx - tw(readout) // 2 + 1, 50, L)
    label = k["label"] if k else "READY"
    size = 2 if len(label) <= 4 else 1
    d.text(label, 32 + 0 - tw(label, size) // 2, 13 if size == 2 else 17, (0, 11, 62, 30), size=size)
    if k and k["p"] and (k["sp"] % 2 == 0):                 # shift-light strobe on actuation
        d.fillRect(4, 13, 4, 12)
        d.fillRect(55, 13, 4, 12)
    # mini grid with legends-free keys
    for i, kk in enumerate(fr["keys"]):
        x = 68 + (i % 4) * 15
        y = 13 + (i // 4) * 13
        if kk["p"]:
            d.fillRoundRect2(x, y, 13, 11)
        else:
            d.drawRoundRect(x, y, 13, 11, 2)
            fh = int(kk["t"] / TOT * 9 + 0.5)
            if fh:
                d.fillRect(x + 1, y + 10 - fh, 11, fh)


LAYOUTS = [
    ("L1", "Keymap", layout_keymap),
    ("L2", "Spectrum", layout_spectrum),
    ("L3", "Tach", layout_tach),
]


# -------------------------------------------------------------
# Output
# -------------------------------------------------------------
def save_gif(path, imgs):
    imgs[0].save(path, save_all=True, append_images=imgs[1:], duration=GIF_MS, loop=0, optimize=False)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def main():
    os.makedirs(OUT, exist_ok=True)
    frames = build_timeline()
    d = D()
    STILL_ACTIVE = 29            # "1" mid rapid-trigger burst, actuated
    STILL_BOTTOM = 49            # "ENT" bottomed out + "7" held

    stills = {}
    for code, name, fn in LAYOUTS:
        imgs = []
        for f, fr in enumerate(frames):
            fn(d, fr)
            img = d.to_pil_image(SCALE)
            imgs.append(img)
            if f in (0, STILL_ACTIVE, STILL_BOTTOM):
                stills[(code, f)] = img
        save_gif(os.path.join(OUT, f"{code}_{name.lower().replace(' ', '_')}.gif"), imgs)

    strips = {}
    STRIP_FRAMES = [2, 4, 5, 6, 8, 13, 14, 15, 16, 17, 18, 19]   # key "5" (index 6): press -> hold -> release
    kx, ky = BX + 2 * (BW + GX), BY + 1 * (BH + GY)
    for code, name, fn in ANIMS:
        imgs = []
        for f, fr in enumerate(frames):
            render_anim_frame(d, fr, fn)
            img = d.to_pil_image(SCALE)
            imgs.append(img)
            if f == STILL_ACTIVE:
                stills[(code, f)] = img
        save_gif(os.path.join(OUT, f"{code}_{name.split(' (')[0].lower().replace(' + ', '_').replace(' ', '_')}.gif"), imgs)
        crops = []
        for f in STRIP_FRAMES:
            render_anim_frame(d, frames[f], fn)
            full = d.to_pil_image(6)
            crops.append(full.crop(((kx - 5) * 6, (ky - 4) * 6, (kx + BW + 5) * 6, (ky + BH + 4) * 6)))
        strips[code] = crops

    # ---- contact sheet ----
    pad, gap, cap = 28, 24, 30
    sw, sh = 128 * SCALE, 64 * SCALE
    f_title, f_cap, f_small = font(30), font(18), font(15)
    sheet_w = pad * 2 + sw * 3 + gap * 2
    lay_h = cap + (cap + sh) * 3 + gap * 2 + 40
    strip_w = strips["A1"][0].width
    strip_h = strips["A1"][0].height
    anim_rows_h = len(ANIMS) * (strip_h + cap + 16)
    sheet_h = pad + 60 + lay_h + 60 + anim_rows_h + pad
    sheet = Image.new("RGB", (sheet_w, sheet_h), (14, 17, 22))
    g = ImageDraw.Draw(sheet)
    g.text((pad, pad), "DriftPad OLED - design options", fill=(235, 240, 245), font=f_title)
    y = pad + 60
    g.text((pad, y), "LAYOUTS    columns: standby  |  rapid-trigger tap on '1'  |  'ENT' bottomed + '7' held",
           fill=(140, 200, 230), font=f_cap)
    y += cap + 10
    for code, name, _ in LAYOUTS:
        g.text((pad, y), f"{code}  {name}", fill=(255, 190, 60), font=f_cap)
        y += cap - 4
        for c, f in enumerate((0, STILL_ACTIVE, STILL_BOTTOM)):
            x = pad + c * (sw + gap)
            sheet.paste(stills[(code, f)], (x, y))
            g.rectangle([x - 1, y - 1, x + sw, y + sh], outline=(60, 70, 85))
        y += sh + gap
    y += 20
    g.text((pad, y), f"KEY-PRESS ANIMATIONS (drop-in for current grid)    key '5' frames {STRIP_FRAMES}  @ {FRAME_MS}ms",
           fill=(140, 200, 230), font=f_cap)
    y += cap + 14
    for code, name, _ in ANIMS:
        g.text((pad, y), f"{code}  {name}", fill=(255, 190, 60), font=f_cap)
        y += cap - 4
        for i, crop in enumerate(strips[code]):
            sheet.paste(crop, (pad + i * (strip_w + 6), y))
        y += strip_h + 20
    sheet.save(os.path.join(OUT, "contact_sheet.png"))

    print(f"Wrote {len(os.listdir(OUT))} files to {OUT}")
    if violations:
        print("TEXT OVERFLOWS:")
        for v in sorted(set(violations)):
            print("  " + v)
        sys.exit(1)
    print("Text bounds check: 0 overflows")


if __name__ == "__main__":
    main()
