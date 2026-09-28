#!/usr/bin/env python3
"""
timing_capture.py - Record a DriftPad's scan timing while you use it, and judge it.

Resets the pad's timing counters (TIMING RESET), samples TIMING every --interval seconds for
--seconds, and writes the samples plus a verdict to a JSON file. Run it once per scenario of the
hardware acceptance procedure (docs/hardware-acceptance.md), for example:

    python tools/timing_capture.py --label "idle, display on"            --seconds 60
    python tools/timing_capture.py --label "typing, configurator open"   --seconds 120
    python tools/timing_capture.py --label "OLED_SCAN and saves" --seconds 60 --allow-save-gaps

Verdict (defaults; change them only with a reason written in the acceptance record):
  * max_gap_us <= --max-gap-us (2000): no scan started more than 2 ms after the previous one;
  * no scan gap above 2 ms in the histogram (le_5000 .. gt_50000 all zero);
  * with --allow-save-gaps, gaps are accepted while a flash save ran (save_count > 0) as long as
    max_gap_us <= save_max_us + one scan period: the save itself is the pause, nothing else.
The timing fields are documented in docs/scheduling.md. Needs pyserial and a connected pad; the
serial layer is injectable (tests/test_release_tooling.py runs it against a fake pad).
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import driftpad_serial as ds   # noqa: E402

SCHEMA = "driftpad-timing-capture/1"
LONG_GAP_BUCKETS = ("le_5000", "le_10000", "le_50000", "gt_50000")   # every gap above 2 ms
KEPT = ("uptime_ms", "scans", "scan_hz", "max_gap_us", "missed_deadlines", "gap_hist_us", "scan_max_us",
        "scan_avg_us", "save_count", "save_max_us", "command_max_us", "telemetry_max_us", "publish_max_us",
        "display_request_max_us", "tx_drain_max_us", "tx_high_water", "tx_events_dropped",
        "tx_replies_rejected", "telemetry_dropped")


def judge(final: Dict[str, Any], max_gap_us: int, allow_save_gaps: bool) -> Dict[str, Any]:
    reasons: List[str] = []
    hist = final.get("gap_hist_us") or {}
    long_gaps = sum(int(hist.get(k, 0)) for k in LONG_GAP_BUCKETS)
    gap = int(final.get("max_gap_us", 0))
    saves = int(final.get("save_count", 0))
    if allow_save_gaps and saves > 0:
        limit = int(final.get("save_max_us", 0)) + int(final.get("period_us", 1000))
        if gap > limit:
            reasons.append(f"max_gap_us {gap} exceeds the longest save ({final.get('save_max_us')} us) plus one period")
    else:
        if gap > max_gap_us:
            reasons.append(f"max_gap_us {gap} > {max_gap_us}")
        if long_gaps:
            reasons.append(f"{long_gaps} scan gap(s) above 2 ms")
        if saves:
            reasons.append(f"{saves} flash save(s) ran during the capture (use --allow-save-gaps for that scenario)")
    for key in ("tx_replies_rejected",):
        if int(final.get(key, 0)):
            reasons.append(f"{key} = {final.get(key)} (a reply did not fit the TX queue: firmware bug guard)")
    return {"pass": not reasons, "reasons": reasons}


def capture(client: ds.DeviceClient, seconds: float, interval: float,
            sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    reset = client.request("TIMING RESET")
    if not reset.ok:
        raise RuntimeError(f"TIMING RESET failed: {reset.raw}")
    samples = []
    start = clock()
    while True:
        elapsed = clock() - start
        if elapsed >= seconds:
            break
        sleep(min(interval, seconds - elapsed))
        r = client.request("TIMING")
        if not r.ok:
            raise RuntimeError(f"TIMING failed: {r.raw}")
        samples.append({"t_s": round(clock() - start, 3), **{k: r.obj.get(k) for k in KEPT if k in r.obj}})
    final = client.request("TIMING")
    if not final.ok:
        raise RuntimeError(f"TIMING failed: {final.raw}")
    return {"samples": samples, "final": final.obj}


def main(argv: Optional[List[str]] = None, list_ports=ds.list_serial_ports, opener=ds.open_serial,
         sleep=time.sleep, clock=time.monotonic, out=print) -> int:
    ap = argparse.ArgumentParser(description="Record and judge a DriftPad's scan timing.")
    ap.add_argument("--port", help="the pad's serial port (default: the one DriftPad connected)")
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--label", required=True, help="what was done during the capture (goes into the record)")
    ap.add_argument("--out", help="JSON file (default timing-<timestamp>.json)")
    ap.add_argument("--max-gap-us", type=int, default=2000)
    ap.add_argument("--allow-save-gaps", action="store_true")
    args = ap.parse_args(argv)

    sel = ds.select_device(list_ports, opener, port=args.port, clock=clock, allow_legacy=False)
    if sel.chosen is None:
        out(f"No DriftPad to measure: {sel.error}")
        return 2
    ident = sel.chosen
    out(f"Measuring {ident.describe()}")
    out(f"Scenario: {args.label} ({args.seconds:g} s). Do it now.")
    client = ds.DeviceClient(opener(ident.port.device), clock)
    try:
        result = capture(client, args.seconds, args.interval, sleep, clock)
    except RuntimeError as e:
        out(str(e))
        return 1
    finally:
        client.close()
    verdict = judge(result["final"], args.max_gap_us, args.allow_save_gaps)
    record = {
        "schema": SCHEMA,
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "label": args.label,
        "device": {k: (ident.info or {}).get(k) for k in ("device", "hw", "fw", "build", "protocol")},
        "port": ident.port.device, "usb_serial": ident.port.serial_number,
        "seconds": args.seconds, "interval": args.interval,
        "thresholds": {"max_gap_us": args.max_gap_us, "allow_save_gaps": args.allow_save_gaps},
        **result, "verdict": verdict,
    }
    path = Path(args.out or f"timing-{time.strftime('%Y%m%d-%H%M%S')}.json")
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    f = result["final"]
    out(f"scans {f.get('scans')}, max gap {f.get('max_gap_us')} us, missed deadlines {f.get('missed_deadlines')}, "
        f"saves {f.get('save_count')} (max {f.get('save_max_us')} us)")
    out(("PASS" if verdict["pass"] else "FAIL: " + "; ".join(verdict["reasons"])) + f"  -> {path}")
    return 0 if verdict["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
