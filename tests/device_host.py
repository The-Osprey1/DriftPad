"""
device_host.py - Runs whole DriftPad firmware images on the host and talks to them over the fake
USB serial port.

Two builds share the fakes in tests/firmware_host/ (clock, Serial, EEPROM sector, mux, TinyUSB):
  prefix_device()  - the pre-fix firmware (main.cpp, config.cpp, hall.cpp of commit e2031e2), used
                     only to show that regression scenarios expose real defects
  current_device() - the current firmware (main.cpp and every module it links; the OLED is a stub)

Pure Python standard library + a host C++ compiler (tests/host_build.py).
"""

import ctypes
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import host_build as hb

COMMON_FAKES = ["host_clock.cpp", "arduino_host.cpp", "eeprom_fake.cpp", "mux_fake.cpp", "usb_fake.cpp"]

_libs: Dict[str, ctypes.CDLL] = {}

_COMMON_SIGS = {
    "serial_fake_feed": ([ctypes.c_char_p, ctypes.c_int], None),
    "serial_fake_take": ([ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
    "serial_fake_rx_pending": ([], ctypes.c_int),
    "serial_fake_set_dtr": ([ctypes.c_int], None),
    "serial_fake_set_tx_space": ([ctypes.c_int], None),
    "serial_fake_writes_when_full": ([], ctypes.c_uint32),
    "rp2040_fake_bootloader_requests": ([], ctypes.c_int),
    "eeprom_fake_sector": ([], ctypes.POINTER(ctypes.c_uint8)),
    "eeprom_fake_commits": ([], ctypes.c_uint32),
    "eeprom_fake_erase": ([], None),
    "mux_fake_set": ([ctypes.c_uint8, ctypes.c_uint16], None),
    "mux_fake_set_all": ([ctypes.c_uint16], None),
    "host_clock_advance_us": ([ctypes.c_uint64], None),
    "host_clock_now_us": ([], ctypes.c_uint64),
}


def _bind(lib: ctypes.CDLL, sigs) -> None:
    for name, (args, res) in sigs.items():
        fn = getattr(lib, name)
        fn.argtypes = args
        fn.restype = res


def prefix_device() -> ctypes.CDLL:
    if "prefix" in _libs:
        return _libs["prefix"]
    hb.require_compiler()
    libs = hb.keyboard_library_sources()
    rel = ["firmware/src/main.cpp", "firmware/src/config.cpp", "firmware/src/hall.cpp",
           "firmware/include/hall.h", "firmware/include/config.h", "firmware/include/oled.h"]
    root = hb.revision_files(hb.PREFIX_REVISION, rel)
    sources = [root / "firmware" / "src" / n for n in ("main.cpp", "config.cpp", "hall.cpp")] + \
        hb.firmware_sources("encoder.cpp") + \
        hb.host_sources(*COMMON_FAKES, "usb_fake_default_cb.cpp", "prefix_oled_stub.cpp", "prefix_device.cpp") + libs
    path = hb.build("device_prefix", sources, hb.keyboard_include_dirs(root / "firmware" / "include"))
    lib = ctypes.CDLL(str(path))
    _bind(lib, _COMMON_SIGS)
    f, i = ctypes.c_float, ctypes.c_int
    _bind(lib, {
        "pd_boot": ([], None), "pd_loop": ([i], None),
        "pd_engine_actuation": ([], f), "pd_engine_rt_sens": ([], f), "pd_engine_rt_enabled": ([], i),
        "pd_active_layer": ([], i), "pd_stored_actuation": ([], f), "pd_key_code": ([i, i], i),
        "pd_key_label": ([i, i, ctypes.c_char_p], None),
        "pd_is_pressed": ([i], i), "pd_set_travel": ([i, f], None),
        "eeprom_fake_cut_next_commit": ([ctypes.c_int32], None), "eeprom_fake_power_on": ([], None),
    })
    lib.boot = lib.pd_boot
    lib.run = lib.pd_loop
    lib.engine_actuation = lib.pd_engine_actuation
    lib.engine_rt_sens = lib.pd_engine_rt_sens
    lib.engine_rt_enabled = lib.pd_engine_rt_enabled
    lib.active_layer = lib.pd_active_layer
    lib.is_pressed = lib.pd_is_pressed
    lib.set_travel = lib.pd_set_travel
    lib.arm_power_cut = lib.eeprom_fake_cut_next_commit
    lib.power_on = lib.eeprom_fake_power_on
    lib.reset_flash = lib.eeprom_fake_erase
    lib.flash_writes = lib.eeprom_fake_commits     # sector erase+program cycles

    def write_legacy_image(image: bytes, _lib=lib):
        sector = _lib.eeprom_fake_sector()
        for n, b in enumerate(image):
            sector[n] = b
    lib.write_legacy_image = write_legacy_image
    lib.revision = "prefix"
    _libs["prefix"] = lib
    return lib


CURRENT_FIRMWARE = [
    "main.cpp", "commands.cpp", "config.cpp", "config_persist_ab.cpp", "settings_store.cpp", "hall.cpp", "encoder.cpp",
    "encoder_menu.cpp", "keycodes.cpp", "keyboard_output.cpp", "keyboard_output_hal_device.cpp",
    "calibration.cpp", "protocol.cpp", "line_reader.cpp", "json_writer.cpp", "tx_queue.cpp", "timing.cpp",
    "display_link.cpp", "display_publish.cpp",
]


def current_device() -> ctypes.CDLL:
    return _whole_image("current", hb.FIRMWARE_SRC / "main.cpp")


def device_with_main_from(revision: str, shim_header: Path) -> ctypes.CDLL:
    """The current firmware with main.cpp (the scheduler loop) as it was at `revision`, to show a
    scheduling defect on the loop that had it. `shim_header` is force-included to declare what
    that main.cpp still calls and the current headers no longer provide."""
    root = hb.revision_files(revision, ["firmware/src/main.cpp"])
    return _whole_image(f"main@{revision}", root / "firmware" / "src" / "main.cpp",
                        extra_flags=("-include", str(shim_header)))


def _whole_image(key: str, main_source: Path, extra_flags=()) -> ctypes.CDLL:
    if key in _libs:
        return _libs[key]
    hb.require_compiler()
    modules = [n for n in CURRENT_FIRMWARE if n != "main.cpp"]
    sources = [main_source] + hb.firmware_sources(*modules) + \
        hb.host_sources(*COMMON_FAKES, "fake_flash.cpp", "oled_stub.cpp", "vdev_harness.cpp") + hb.keyboard_library_sources()
    name = "device_current" if key == "current" else "device_" + "".join(c if c.isalnum() else "_" for c in key)
    path = hb.build(name, sources, hb.keyboard_include_dirs(), extra_flags=extra_flags)
    lib = ctypes.CDLL(str(path))
    _bind(lib, _COMMON_SIGS)
    f, i = ctypes.c_float, ctypes.c_int
    _bind(lib, {
        "vd_boot": ([], None), "vd_loop": ([i], None), "vd_set_travel": ([i, f], None),
        "vd_engine_actuation": ([], f), "vd_engine_rt_sens": ([], f), "vd_engine_rt_enabled": ([], i),
        "vd_active_layer": ([], i), "vd_engine_code": ([i], i), "vd_dirty": ([], i),
        "vd_output_enabled": ([], i), "vd_is_pressed": ([i], i), "vd_encoder_apply": ([i, i], i),
        "oled_stub_wakes": ([], ctypes.c_uint32), "oled_stub_page": ([], i), "oled_stub_stall": ([i], None),
        "vd_display_snapshot": ([ctypes.c_void_p], i), "vd_display_stats": ([ctypes.c_void_p], None),
        "pin_fake_set": ([i, i], None),
        "vd_normalize_label": ([ctypes.c_char_p, ctypes.c_char_p], i),
        "vd_cal_key_plausible": ([i, i, i], i),
        "usbfake_host_state": ([ctypes.POINTER(ctypes.c_uint8)], None),
        "ff_reset": ([], None), "ff_power_on": ([], None), "ff_cut_after_program_bytes": ([ctypes.c_int32], None),
        "ff_cut_during_next_erase": ([ctypes.c_int32], None), "ff_fail_program": ([ctypes.c_int32, ctypes.c_int32], None),
        "ff_read_flip": ([i, i, i], None), "ff_flip_bits": ([i, i, i], None),
        "ff_sector": ([i], ctypes.POINTER(ctypes.c_uint8)), "ff_legacy": ([], ctypes.POINTER(ctypes.c_uint8)),
        "ff_erase_count": ([i], ctypes.c_uint32), "ff_program_bytes": ([], ctypes.c_uint32),
    })
    lib.boot = lib.vd_boot
    lib.run = lib.vd_loop
    lib.engine_actuation = lib.vd_engine_actuation
    lib.engine_rt_sens = lib.vd_engine_rt_sens
    lib.engine_rt_enabled = lib.vd_engine_rt_enabled
    lib.active_layer = lib.vd_active_layer
    lib.is_pressed = lib.vd_is_pressed
    lib.set_travel = lib.vd_set_travel
    lib.arm_power_cut = lib.ff_cut_after_program_bytes
    lib.power_on = lib.ff_power_on
    lib.reset_flash = lib.ff_reset
    lib.flash_writes = lambda _lib=lib: _lib.ff_erase_count(0) + _lib.ff_erase_count(1)   # sector erase+program cycles

    def write_legacy_image(image: bytes, _lib=lib):
        sector = _lib.ff_legacy()
        for n, b in enumerate(image):
            sector[n] = b
    lib.write_legacy_image = write_legacy_image
    lib.revision = key
    _libs[key] = lib
    return lib


class Device:
    """A booted firmware image with a line-oriented view of its serial port."""

    def __init__(self, lib: ctypes.CDLL, boot: bool = True):
        self.lib = lib
        self._partial = b""
        self.transcript: List[str] = []   # every line the device sent, in order
        if boot:
            self.boot()

    def boot(self) -> None:
        self.lib.boot()
        self.run(50)
        self.drain()

    def run(self, iterations: int) -> None:
        self.lib.run(iterations)

    def drain(self) -> List[str]:
        buf = ctypes.create_string_buffer(1 << 16)
        chunks = []
        while True:
            n = self.lib.serial_fake_take(buf, len(buf))
            if n <= 0:
                break
            chunks.append(buf.raw[:n])
        data = self._partial + b"".join(chunks)
        *lines, self._partial = data.split(b"\n")
        out = [l.decode("utf-8", "replace").rstrip("\r") for l in lines]
        self.transcript.extend(out)
        return out

    def send_raw(self, data: bytes) -> None:
        self.lib.serial_fake_feed(data, len(data))

    def exchange(self, line: str, iterations: int = 400) -> List[str]:
        """Sends one request line, runs the firmware, returns every line it sent meanwhile."""
        self.send_raw(line.encode("latin-1") + b"\n")
        self.run(iterations)
        return self.drain()

    @staticmethod
    def json_lines(lines: List[str]) -> List[dict]:
        out = []
        for l in lines:
            l = l.strip()
            if l.startswith("{"):
                try:
                    out.append(json.loads(l))
                except json.JSONDecodeError:
                    pass
        return out

    def replies(self, line: str, iterations: int = 400) -> List[dict]:
        """JSON lines that answer a request: lines with "status" (events and logs have none).
        The pre-fix firmware's typed replies (pong, config, status) carried no "status" field and
        it sent no events unless streaming, so for it every JSON line counts."""
        got = self.json_lines(self.exchange(line, iterations))
        if getattr(self.lib, "revision", "") == "prefix":
            return got
        return [j for j in got if "status" in j]

    def config(self) -> dict:
        for j in self.replies("GET_CONFIG"):
            if j.get("type") == "config":
                return j
        raise AssertionError("no config reply")
