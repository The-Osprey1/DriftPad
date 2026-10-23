#!/usr/bin/env python3
"""
save_stress.py - Keep a DriftPad saving settings, for the power-cut acceptance item (HW-20).

Alternates the actuation point between two values and saves after every change, printing each
save the pad confirmed. Cut the pad's USB power at any moment; the tool stops when the port goes
away and prints the last confirmed save. After power returns, the pad must hold either that
value or the one that was being saved (docs/hardware-acceptance.md, HW-20); `--verify` checks
exactly that on a pad that has come back.

    python tools/save_stress.py [--port PORT] [--count N]     run saves (0 = until the port goes away)
    python tools/save_stress.py --verify LOGFILE [--port PORT] check a pad after the power returned
    python tools/save_stress.py --command SLEEP [--port PORT]  send one command, print the reply

Every run appends JSON lines to --log (default save_stress.log). Needs pyserial and a pad; the
serial layer is injectable (tests/test_release_tooling.py).
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import List, Optional

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import driftpad_serial as ds   # noqa: E402

VALUES = ("1.50", "2.50")


def _log(path: Path, entry: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def run_saves(client: ds.DeviceClient, count: int, log: Path, out=print, clock=time.time) -> Optional[dict]:
    last = None
    n = 0
    while count == 0 or n < count:
        value = VALUES[n % 2]
        try:
            _log(log, {"t": clock(), "event": "saving", "actuation": value})
            r = client.request(f"SET_ACTUATION {value}")
            if not r.ok:
                out(f"SET_ACTUATION {value} failed: {r.raw}")
                break
            r = client.request("SAVE", timeout=5.0)
        except Exception as e:     # the port vanished (power cut)
            out(f"port gone: {e}")
            break
        if r.obj is None:
            out("no reply to SAVE (power cut?)")
            break
        if not r.ok:
            out(f"SAVE failed: {r.obj.get('code')} {r.obj.get('msg', '')}")
            break
        last = {"t": clock(), "event": "saved", "actuation": value, "slot": r.obj.get("slot"), "seq": r.obj.get("seq")}
        _log(log, last)
        n += 1
        out(f"save #{n}: actuation {value} mm -> {last['slot']} seq {last['seq']}")
    if last:
        out(f"last confirmed save: actuation {last['actuation']} mm, {last['slot']} seq {last['seq']}")
    return last


def verify(client: ds.DeviceClient, log: Path, out=print) -> bool:
    entries = [json.loads(l) for l in Path(log).read_text(encoding="utf-8").splitlines() if l.strip()]
    saved = [e for e in entries if e.get("event") == "saved"]
    saving = [e for e in entries if e.get("event") == "saving"]
    allowed = set()
    if saved:
        allowed.add(float(saved[-1]["actuation"]))
    if saving:
        allowed.add(float(saving[-1]["actuation"]))
    cfg = client.request("GET_CONFIG")
    info = client.request("INFO")
    if not (cfg.ok and info.ok):
        out("the pad did not answer GET_CONFIG / INFO")
        return False
    got = cfg.obj.get("actuation")
    settings = info.obj.get("settings") or {}
    ok = got in allowed if allowed else True
    out(f"actuation now {got} mm (allowed: {sorted(allowed)}), settings from {settings.get('source')} "
        f"seq {settings.get('seq')}, load_errors {settings.get('load_errors')}")
    out("PASS" if ok else "FAIL: the pad holds neither the last confirmed nor the interrupted save")
    return ok


def main(argv: Optional[List[str]] = None, list_ports=ds.list_serial_ports, opener=ds.open_serial, out=print) -> int:
    ap = argparse.ArgumentParser(description="Save settings repeatedly for power-cut testing.")
    ap.add_argument("--port")
    ap.add_argument("--count", type=int, default=0)
    ap.add_argument("--log", type=Path, default=Path("save_stress.log"))
    ap.add_argument("--verify", type=Path, metavar="LOGFILE")
    ap.add_argument("--command")
    args = ap.parse_args(argv)

    sel = ds.select_device(list_ports, opener, port=args.port, allow_legacy=False)
    if sel.chosen is None:
        out(f"No DriftPad: {sel.error}")
        return 2
    client = ds.DeviceClient(opener(sel.chosen.port.device))
    try:
        if args.command:
            r = client.request(args.command)
            out(r.raw or "no reply")
            return 0 if r.ok else 1
        if args.verify:
            return 0 if verify(client, args.verify, out) else 1
        out(f"Saving on {sel.chosen.describe()}; cut the power whenever you like.")
        last = run_saves(client, args.count, args.log, out)
        return 0 if last else 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
