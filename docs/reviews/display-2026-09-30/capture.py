"""Capture the current firmware renderer for the display review, without device writes."""
import ctypes
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tests"))
import oled_host as oh
import host_build as hb

lib = ctypes.CDLL(str(hb.build("oled_review", [oh.GFX_DIR / "Adafruit_GFX.cpp",
    *hb.firmware_sources("display_link.cpp", "screensaver_player.cpp"), OUT / "renderer.cpp",
    *hb.host_sources("host_clock.cpp", "arduino_host.cpp")],
    [oh.SHIM_DIR, hb.HOST_DIR, hb.FIRMWARE_INCLUDE, hb.FIRMWARE_SRC, oh.GFX_DIR],
    defines=["ARDUINO=100"])))
lib.oled_scene.argtypes = [ctypes.c_int, ctypes.c_char_p]
lib.oled_review_menu.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p]
lib.oled_review_label.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p]
lib.oled_intro_frame.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
lib.oled_context_step.argtypes = [ctypes.c_int] * 4 + [ctypes.c_uint32, ctypes.c_char_p]
lib.oled_settings_step.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p]
lib.oled_manual_step.argtypes = [ctypes.c_int, ctypes.c_uint32]
lib.oled_screensaver_frame.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p]
captures = []


def call(fn, *args):
    buf = ctypes.create_string_buffer(1024)
    fn(*args, buf)
    return bytes(buf.raw)


def save(name, fb, state):
    number = len(captures) + 1
    path = OUT / f"{number:02}-{name}.png"
    im = Image.new("RGB", (128, 64), "black")
    for y in range(64):
        for x in range(128):
            if oh.pixel(fb, x, y):
                im.putpixel((x, y), (255, 255, 255))
    im.save(path)
    captures.append({"number": number, "name": name, "file": path.name,
                     "state": state, "framebuffer_sha256": hashlib.sha256(fb).hexdigest()})


save("boot-title", call(lib.oled_intro_frame, 4900), "Startup animation at 4.9 seconds")
for name in ("standby", "travelling", "actuated", "actuated_ent", "rt_backing_off",
             "menu_rt", "menu_actuation", "menu_toggle", "menu_layer", "standby_no_cal",
             "travelling_output_off"):
    save(name, oh.frame(lib, name), {"fixture_scene": name})
lib.oled_state_reset()
save("calibrating", call(lib.oled_context_step, 0, 0, 3, 0, 33), "Calibration running")
lib.oled_state_reset()
call(lib.oled_settings_step, 0, 5, 33)
save("unsaved", call(lib.oled_settings_step, 1, 5, 33), "Edited settings, saved sequence 5")
save("saved", call(lib.oled_settings_step, 0, 6, 33), "Save succeeded, sequence 6")
save("saved-expired", call(lib.oled_settings_step, 0, 6, 3000), "Save notice expired after three seconds")
save("wide-label", oh.frame(lib, "wide_label_actuated"), "Four-character stress fixture, WWWW")
lib.oled_manual_reset()
lib.oled_manual_step(1, 500)
lib.oled_manual_step(0, 300)
save("menu-at-entry", call(lib.oled_last_frame), "Manual RT page, entry wipe finished")
lib.oled_manual_step(0, 10000)
save("menu-after-10s", call(lib.oled_last_frame), "Same RT page, ten seconds without input")
save("menu-uncalibrated", call(lib.oled_review_menu, 1, 0), "RT menu while calibration is missing")
save("menu-unsaved", call(lib.oled_review_menu, 0, 1), "RT menu while settings are unsaved")
save("period-travelling", call(lib.oled_review_label, b".", 0), "Isolated period label at 0.7 mm, released")
save("period-actuated", call(lib.oled_review_label, b".", 1), "Isolated period label at 1.85 mm, actuated")
for anim, name in enumerate(("starfield", "plasma", "tesseract", "horizon", "magnetic-pulse", "lava")):
    save(f"screensaver-{name}", call(lib.oled_screensaver_frame, anim, 120),
         {"explicit_screensaver": anim, "frame": 120})


def sheet(name, items, cols=3):
    scale, pad, label_h = 4, 14, 28
    w, h = 128 * scale, 64 * scale
    rows = (len(items) + cols - 1) // cols
    im = Image.new("RGB", (cols * (w + pad) + pad, rows * (h + label_h + pad) + pad), (16, 20, 27))
    draw = ImageDraw.Draw(im)
    for i, item in enumerate(items):
        x = pad + (i % cols) * (w + pad)
        y = pad + (i // cols) * (h + label_h + pad)
        draw.text((x, y + 5), f"{item['number']:02}  {item['name']}", fill="white")
        with Image.open(OUT / item["file"]) as source:
            im.paste(source.resize((w, h), Image.Resampling.NEAREST), (x, y + label_h))
    im.save(OUT / name)


sheet("overview.png", captures[:12])
sheet("feedback-and-navigation.png", captures[12:21])
sheet("punctuation.png", captures[21:23], cols=2)
sheet("screensavers.png", captures[23:], cols=3)
sheet("review-highlights.png", [captures[i] for i in (1, 22, 6, 10, 13, 20)], cols=3)
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
meta = {"captured_utc": datetime.now(timezone.utc).isoformat(), "git_head": head,
        "renderer_sha256": hashlib.sha256((ROOT / "firmware/src/oled.cpp").read_bytes()).hexdigest(),
        "capture_method": "Actual oled.cpp and Adafruit GFX, host clock and stub panel",
        "physical_device_exercised": False,
        "fixture": "Synthetic Numpad legends and values; not the connected pad configuration",
        "native_resolution": [128, 64], "contact_sheet_scale": 4, "captures": captures}
(OUT / "captures.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
print(f"Captured {len(captures)} current firmware frames in {OUT}")
