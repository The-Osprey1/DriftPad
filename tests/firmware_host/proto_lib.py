"""
proto_lib.py - Builds and loads the host-compiled protocol core for the S3a test suites.

Compiles the production sources firmware/src/{json_writer,line_reader,tx_queue,protocol,timing}.cpp
with tests/firmware_host/proto_shim.cpp (C ABI + fakes) through tests/host_build.py. Only
firmware/include is on the include path, so the build also proves the protocol core needs no
Arduino headers.

Used by tests/test_protocol_core.py and tests/test_timing.py. Pure Python standard library.
"""

import ctypes
import sys
from pathlib import Path
from typing import Dict, Optional, Sequence

HOST_DIR = Path(__file__).resolve().parent
TESTS_DIR = HOST_DIR.parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import host_build  # noqa: E402

PROTO_SOURCES = ("json_writer.cpp", "line_reader.cpp", "tx_queue.cpp", "protocol.cpp", "timing.cpp")

_libs: Dict[str, ctypes.CDLL] = {}

vp = ctypes.c_void_p
i32 = ctypes.c_int32
u32 = ctypes.c_uint32
cint = ctypes.c_int
cstr = ctypes.c_char_p
cflt = ctypes.c_float
U32P = ctypes.POINTER(ctypes.c_uint32)
INTP = ctypes.POINTER(ctypes.c_int)

_SIGNATURES = {
    # JsonWriter
    "jw_create": ([cint], vp), "jw_destroy": ([vp], None), "jw_reset": ([vp], None),
    "jw_begin_object": ([vp], None), "jw_end_object": ([vp], None),
    "jw_begin_array": ([vp], None), "jw_end_array": ([vp], None),
    "jw_key": ([vp, cstr], None), "jw_str": ([vp, cstr], None), "jw_str_n": ([vp, cstr, cint], None),
    "jw_bool": ([vp, cint], None), "jw_i32": ([vp, i32], None), "jw_u32": ([vp, u32], None),
    "jw_mm": ([vp, i32], None), "jw_scaled": ([vp, i32, cint], None), "jw_fixed": ([vp, cflt, cint], None),
    "jw_null": ([vp], None), "jw_raw": ([vp, cstr], None),
    "jw_data": ([vp], cstr), "jw_len": ([vp], cint), "jw_ok": ([vp], cint), "jw_overflow": ([vp], cint),
    "jw_misuse": ([vp], cint), "jw_complete": ([vp], cint), "jw_depth": ([vp], cint),
    "jw_buffer_byte": ([vp, cint], cint),
    # LineReader
    "lr_create": ([], vp), "lr_destroy": ([vp], None), "lr_reset": ([vp], None),
    "lr_feed": ([vp, cint], cint), "lr_line": ([vp, ctypes.c_char_p, cint], cint),
    "lr_max_len": ([], cint), "lr_stats": ([vp, U32P], None),
    # Parsers
    "p_uint": ([cstr, u32, u32, U32P], cint), "p_cmm": ([cstr, cint, cint, U32P], cint),
    "p_bool": ([cstr, INTP], cint), "p_token": ([cstr, ctypes.c_char_p, cint], cint),
    "p_keyword": ([cstr, cstr], cint), "p_valid_id": ([cstr, cint], cint),
    "p_result_code": ([cint], cstr), "err_count": ([], cint), "err_code": ([cint], cstr),
    # TxQueue
    "tx_create": ([], vp), "tx_destroy": ([vp], None), "tx_capacity": ([], cint),
    "tx_max_reply_len": ([], cint), "tx_enqueue": ([vp, cstr, cint, cint], cint),
    "tx_has_room": ([vp], cint), "tx_used": ([vp], cint), "tx_free": ([vp], cint),
    "tx_mid_line": ([vp], cint), "tx_clear": ([vp], None), "tx_reset_stats": ([vp], None),
    "tx_drain": ([vp, cint, cint, cint], cint), "tx_take_output": ([vp, ctypes.c_char_p, cint], cint),
    "tx_output_len": ([vp], cint), "tx_sink_violations": ([vp], u32), "tx_sink_writes": ([vp], u32),
    "tx_stats": ([vp, U32P], None),
    # Session (dispatcher + scheduler)
    "ss_create": ([], vp), "ss_destroy": ([vp], None), "ss_set_clock_us": ([u32], None),
    "ss_rx_push": ([vp, cstr, cint], None), "ss_rx_pending": ([vp], cint),
    "ss_step": ([vp, u32, cint], cint), "ss_service": ([vp, u32], None),
    "ss_handle": ([vp, cstr, cint, u32], None), "ss_drain": ([vp, cint, cint], cint),
    "ss_take_output": ([vp, ctypes.c_char_p, cint], cint), "ss_output_len": ([vp], cint),
    "ss_sink_violations": ([vp], u32), "ss_set_defer_mode": ([vp, cint], None),
    "ss_deferred_pending": ([vp], cint), "ss_handler_calls": ([vp], u32),
    "ss_has_room": ([vp], cint), "ss_tx_used": ([vp], cint), "ss_tx_stats": ([vp, U32P], None),
    "ss_stats": ([vp, U32P], None), "ss_find": ([vp, cstr, ctypes.c_char_p, cint], cint),
    "ss_table_valid": ([vp], cint), "ss_bad_table_valid": ([cint], cint),
    "ss_command_op": ([vp, U32P], None), "ss_scan": ([vp, u32], None),
    "ss_event": ([vp, cstr, cint], cint), "ss_event_with_status": ([vp], cint),
    "ss_event_unclosed": ([vp], cint), "ss_event_malformed": ([vp], u32),
    # Timing
    "tm_create": ([u32], vp), "tm_create_no_clock": ([u32], vp), "tm_destroy": ([vp], None),
    "tm_set_clock": ([u32], None), "tm_now": ([vp], u32),
    "tm_scan_begin": ([vp, u32], None), "tm_scan_end": ([vp, u32], None),
    "tm_scan_begin_clock": ([vp], None), "tm_scan_end_clock": ([vp], None),
    "tm_record_op": ([vp, cint, u32], None), "tm_scoped": ([vp, cint, u32], None),
    "tm_reset": ([vp], None), "tm_op_count": ([], cint), "tm_op_name": ([cint], cstr),
    "tm_gap_buckets": ([], cint), "tm_gap_limit": ([cint], u32),
    "tm_get": ([vp, U32P], None), "tm_op": ([vp, cint, U32P], None),
    "tm_json": ([vp, u32, cint, ctypes.c_char_p, cint], cint),
    "tm_scan_rate_json": ([vp, cint, ctypes.c_char_p, cint], cint),
    # build_info.h
    "bi_fw_version": ([], cstr), "bi_build_id": ([], cstr), "bi_build_date": ([], cstr),
    "bi_protocol": ([], cint), "bi_protocol_macro": ([], cint), "bi_fw_version_macro": ([], cstr),
    "bi_device": ([], cstr), "bi_hardware": ([], cstr),
}


def load(defines: Sequence[str] = (), variant: str = "proto_core") -> ctypes.CDLL:
    """Builds (cached) and loads the protocol core. Raises unittest.SkipTest without a compiler."""
    key = variant + "|" + "|".join(defines)
    lib = _libs.get(key)
    if lib is not None:
        return lib
    sources = host_build.firmware_sources(*PROTO_SOURCES) + host_build.host_sources("proto_shim.cpp")
    path = host_build.build(variant, sources, include_dirs=[host_build.FIRMWARE_INCLUDE],
                            defines=list(defines))
    lib = ctypes.CDLL(str(path))
    for name, (args, res) in _SIGNATURES.items():
        fn = getattr(lib, name)
        fn.argtypes = args
        fn.restype = res
    _libs[key] = lib
    return lib


def u32_array(n: int):
    return (ctypes.c_uint32 * n)()


def take_text(fn, handle, cap: int = 1 << 20) -> bytes:
    """Calls a *_take_output / *_json style function and returns the bytes it produced."""
    buf = ctypes.create_string_buffer(cap)
    n = fn(handle, buf, cap)
    return buf.raw[:n]
