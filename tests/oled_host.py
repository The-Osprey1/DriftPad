"""
oled_host.py - Builds and drives the real firmware/src/oled.cpp on the host.

The real Adafruit GFX library (from the PlatformIO libdeps of a firmware build) does the drawing
into a 128x64 framebuffer; the panel driver, Wire and core 1 are stubs (firmware_host/gfx_shim,
firmware_host/oled_frames.cpp). Used by tests/test_oled_frames.py and tools/render_oled_frames.py.
"""

import ctypes
import unittest

import host_build as hb

GFX_DIR = hb.FIRMWARE_DIR / ".pio" / "libdeps" / "pico" / "Adafruit GFX Library"
SHIM_DIR = hb.HOST_DIR / "gfx_shim"

SCENES = {"standby": 0, "travelling": 1, "actuated": 2, "actuated_ent": 3,
          "standby_no_cal": 4, "travelling_output_off": 5,
          "rt_backing_off": 6, "no_rt_backing_off": 7,
          "wide_label": 8, "wide_label_actuated": 9,
          "menu_rt": 10, "menu_actuation": 11, "menu_toggle": 12, "menu_layer": 13,
          "splash": 20, **{f"screensaver{i}": 30 + i for i in range(6)}}


def load():
    if not (GFX_DIR / "Adafruit_GFX.cpp").is_file():
        raise unittest.SkipTest(f"Adafruit GFX not found at {GFX_DIR} (run a PlatformIO build once)")
    sources = ([GFX_DIR / "Adafruit_GFX.cpp"] + hb.firmware_sources("display_link.cpp") +
               hb.host_sources("oled_frames.cpp", "host_clock.cpp", "arduino_host.cpp"))
    path = hb.build("oled_frames", sources,
                    [SHIM_DIR, hb.HOST_DIR, hb.FIRMWARE_INCLUDE, hb.FIRMWARE_SRC, GFX_DIR],
                    defines=["ARDUINO=100"])
    lib = ctypes.CDLL(str(path))
    lib.oled_scene.argtypes = [ctypes.c_int, ctypes.c_char_p]
    lib.oled_idle_step.argtypes = [ctypes.c_uint32, ctypes.c_int]
    return lib


def frame(lib, scene):
    """The framebuffer (1024 bytes, panel layout) of a scene name or id."""
    buf = ctypes.create_string_buffer(128 * 64 // 8)
    lib.oled_scene(SCENES.get(scene, scene), buf)
    return bytes(buf.raw)


def pixel(fb, x, y):
    return (fb[x + (y // 8) * 128] >> (y & 7)) & 1
