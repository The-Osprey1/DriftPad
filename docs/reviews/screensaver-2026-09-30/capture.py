"""Reproduce previews from the production OLED renderer; no device connection is used."""

import ctypes
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
sys.path.insert(0, str(ROOT / "tests"))
import oled_host as oh  # noqa: E402

SEED = 0xD12F7026
STEP_MS = 33
FRAMES = 120
NAMES = ["DRIFTPAD", "PLASMA", "TESSERACT", "DRIFT GRID", "MAG PULSE", "LAVA LAMP"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def native_image(frame):
    im = Image.new("RGB", (128, 64), (0, 0, 0))
    pixels = im.load()
    for y in range(64):
        for x in range(128):
            if oh.pixel(frame, x, y):
                pixels[x, y] = (255, 255, 255)
    assert im.getbbox(), "renderer produced a blank preview"
    return im


def contact_sheet(items, cols, filename):
    scale, pad, caption = 3, 16, 35
    w, h = 128 * scale, 64 * scale
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w + (cols + 1) * pad, rows * (h + caption) + (rows + 1) * pad), (18, 22, 29))
    draw = ImageDraw.Draw(sheet)
    for index, (im, title, timing) in enumerate(items):
        x = pad + index % cols * (w + pad)
        y = pad + index // cols * (h + caption + pad)
        draw.text((x, y), title, fill=(242, 245, 250))
        draw.text((x, y + 15), timing, fill=(178, 190, 203))
        sheet.paste(im.resize((w, h), Image.Resampling.NEAREST), (x, y + caption))
    sheet.save(OUT / filename)


def main():
    lib = oh.load()
    print("Production OLED host build finished", flush=True)
    lib.oled_clock_set_ms.argtypes = [ctypes.c_uint32]
    lib.oled_saver_start.argtypes = [ctypes.c_int, ctypes.c_uint32]
    lib.oled_saver_step.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    lib.oled_saver_state.argtypes = [ctypes.c_int]
    lib.oled_saver_state.restype = ctypes.c_int
    for name in ("oled_clock_set_ms", "oled_saver_start", "oled_saver_step"):
        getattr(lib, name).restype = None
    buf = ctypes.create_string_buffer(1024)
    records, gallery = [], []

    def record(filename, timestamp, title):
        im = native_image(bytes(buf.raw))
        im.save(OUT / filename)
        shown, incoming = (lib.oled_saver_state(i) for i in (0, 1))
        records.append({
            "file": filename,
            "elapsed_ms": timestamp,
            "shown": shown,
            "shown_label": NAMES[shown],
            "incoming": incoming,
            "incoming_label": NAMES[incoming] if incoming >= 0 else None,
            "shuffled": bool(lib.oled_saver_state(2)),
            "label_age_ms": lib.oled_saver_state(3),
            "sha256": digest(OUT / filename),
        })
        return im, title, f"{timestamp:,} ms | native 128 x 64; shown at 3x"

    for anim, name in enumerate(NAMES):
        lib.oled_clock_set_ms(0)
        lib.oled_saver_start(anim, SEED)
        for _ in range(FRAMES):
            lib.oled_saver_step(STEP_MS, buf)
        gallery.append(record(f"0{anim + 1}-{name.lower().replace(' ', '-')}.png", FRAMES * STEP_MS, name))
    contact_sheet(gallery, 3, "animation-gallery.png")

    lib.oled_clock_set_ms(0)
    lib.oled_saver_start(-1, SEED)
    now = 0
    transition = []
    # Render the exact dwell deadline as well as the visible captures. Otherwise a
    # 33 ms frame could start the wipe after 20,000 ms and shift its midpoint.
    for timestamp, phase in ((19999, "BEFORE WIPE"), (20000, None), (20750, "MIDPOINT"), (21500, "AFTER WIPE")):
        while now < timestamp:
            delta = min(STEP_MS, timestamp - now)
            lib.oled_saver_step(delta, buf)
            now += delta
        if phase is None:
            continue
        shown = NAMES[lib.oled_saver_state(0)]
        incoming_index = lib.oled_saver_state(1)
        target = NAMES[incoming_index] if incoming_index >= 0 else shown
        transition.append(record(f"transition-{phase.lower().replace(' ', '-')}.png", now, f"{phase}: {shown} / {target}"))
    assert records[-2]["label_age_ms"] == 0, "incoming label did not start at the wipe midpoint"
    assert records[-1]["incoming"] == -1, "wipe did not complete before the final capture"
    assert records[-1]["shown"] == records[-2]["incoming"], "completed wipe selected the wrong animation"
    assert records[-1]["label_age_ms"] == 750, "label age restarted at wipe completion"
    contact_sheet(transition, 3, "shuffle-transition.png")

    sources = ["firmware/src/oled.cpp", "firmware/src/screensaver_player.cpp", "firmware/include/screensaver_player.h", "tests/firmware_host/oled_frames.cpp"]
    metadata = {
        "captured_utc": datetime.now(timezone.utc).isoformat(),
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "scope": "Actual production OLED renderer and Player; real Adafruit GFX; stubbed panel and clock. Host framebuffer rendering only; no physical-screen validation.",
        "seed_hex": f"0x{SEED:08X}",
        "frame_interval_ms": STEP_MS,
        "fixed_preview_frames": FRAMES,
        "native_size": [128, 64],
        "contact_sheet_scale": 3,
        "host_library": Path(lib._name).name,
        "source_sha256": {path: digest(ROOT / path) for path in sources},
        "frames": records,
    }
    (OUT / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {len(records)} native previews and 2 contact sheets in {OUT}")


if __name__ == "__main__":
    main()
