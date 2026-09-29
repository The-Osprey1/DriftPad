#!/usr/bin/env python3
"""
flash.py - Update one DriftPad with one checked build, then prove it runs that build.

  1. Check the image (tools/firmware_image.py): valid RP2040 UF2, never writes the settings sectors,
     and is exactly the build described by build_manifest.json. Nothing is touched otherwise.
  2. Find the pad: serial ports with the Raspberry Pi USB id are asked INFO (tools/driftpad_serial.py).
     Exactly one DriftPad, or the one given with --port; several are never guessed between. With no
     DriftPad on serial, a single board already in bootloader mode (RPI-RP2 drive) is used.
  3. Show what changes and refuse to lose work: unsaved settings on the pad need --discard-unsaved,
     an older firmware needs --allow-downgrade. Ask before flashing (skip with --yes).
  4. Reboot it into the bootloader (BOOTSEL over serial), copy the UF2 to the drive that appears.
  5. Wait for the pad to come back (same USB serial number) and read INFO: firmware version, build id
     and protocol must equal the manifest's, and the saved settings and calibration state must be
     the ones it had before. Anything else is reported as a failed update.

Usage (from the repository root):
    python tools/flash.py [--port PORT] [--build] [--yes] [--discard-unsaved] [--allow-downgrade]
                          [--allow-dirty] [--uf2 PATH] [--drive PATH]

Default image: firmware/.pio/build/pico/firmware.uf2 with its firmware.elf and build_manifest.json.
--build runs `pio run` first; otherwise the existing build is flashed as it is (qualify it first:
tools/qualify_release.py). Exit status: 0 updated and verified, 1 failed, 2 refused before changing
anything.

Needs pyserial for real ports. Everything that touches the machine goes through `Env`, so
tests/test_flash_tool.py runs the whole procedure against fake pads and drives.
"""

import argparse
import os
import re
import shutil
import string
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, List, Optional, Tuple

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import driftpad_serial as ds      # noqa: E402
import firmware_image as fimg     # noqa: E402

REPO = TOOLS.parent
BUILD_DIR = REPO / "firmware" / ".pio" / "build" / "pico"
DRIVE_LABEL = "RPI-RP2"
DRIVE_TIMEOUT_S = 15.0
RETURN_TIMEOUT_S = 25.0
POLL_S = 0.25

OK, FAILED, REFUSED = 0, 1, 2


def bootloader_drives() -> List[Path]:
    """Mounted RP2040 bootloader drives (INFO_UF2.TXT names the board)."""
    if os.name == "nt":
        mounts = [Path(f"{letter}:\\") for letter in string.ascii_uppercase[2:]]
    else:
        user = os.environ.get("USER", "")
        mounts = [Path("/Volumes") / DRIVE_LABEL, Path("/media") / user / DRIVE_LABEL,
                  Path("/run/media") / user / DRIVE_LABEL]
    found = []
    for m in mounts:
        try:
            info = m / "INFO_UF2.TXT"
            if info.is_file() and "RP2" in info.read_text(errors="ignore"):
                found.append(m)
        except OSError:
            continue
    return found


def run_pio_build(out: Callable[[str], None]) -> bool:
    for cmd in (["pio", "run"], [sys.executable, "-m", "platformio", "run"]):
        try:
            result = subprocess.run(cmd, cwd=REPO / "firmware")
        except FileNotFoundError:
            continue
        return result.returncode == 0
    out("PlatformIO not found.")
    return False


@dataclass
class Env:
    """Everything flash() does to the machine. Tests replace these."""
    list_ports: Callable[[], List[ds.PortInfo]] = ds.list_serial_ports
    opener: Callable[[str], Any] = ds.open_serial
    drives: Callable[[], List[Path]] = bootloader_drives
    copy: Callable[[Path, Path], Any] = shutil.copyfile
    build: Callable[[Callable[[str], None]], bool] = run_pio_build
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    ask: Callable[[str], str] = input
    out: Callable[[str], None] = print
    log: List[str] = field(default_factory=list)

    def say(self, text: str) -> None:
        self.log.append(text)
        self.out(text)


def version_key(v: Optional[str]):
    """Orders "2.1.0-beta.1" < "2.1.0" < "2.1.1" (pre-releases before their release)."""
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", v or "")
    if not m:
        return None
    pre = m.group(4)
    pre_key = (1,) if pre is None else (0,) + tuple(int(p) if p.isdigit() else p for p in pre.split("."))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), pre_key)


def _settings(ident: Optional[ds.Identity]) -> dict:
    return ((ident.info or {}).get("settings") or {}) if ident else {}


def _calibration(ident: Optional[ds.Identity]) -> dict:
    return ((ident.info or {}).get("calibration") or {}) if ident else {}


def _wait(env: Env, timeout: float, probe: Callable[[], Any]):
    deadline = env.clock() + timeout
    while True:
        found = probe()
        if found:
            return found
        if env.clock() >= deadline:
            return None
        env.sleep(POLL_S)


def _reboot_to_bootloader(env: Env, ident: ds.Identity) -> Optional[str]:
    """Sends BOOTSEL; returns an error text, or None once the command went out."""
    try:
        link = env.opener(ident.port.device)
    except Exception as e:
        return f"cannot open {ident.port.device} ({e})"
    client = ds.DeviceClient(link, env.clock)
    try:
        if ident.kind == ds.LEGACY:
            client.send_line("BOOTSEL")          # protocol 1: no ids, the reply may be lost in the reboot
        else:
            reply = client.request("BOOTSEL", timeout=2.0)
            if reply.obj is not None and reply.obj.get("status") != "ok":
                return f"the pad refused BOOTSEL: {reply.obj.get('code')} {reply.obj.get('msg', '')}".strip()
    except Exception as e:
        return f"BOOTSEL failed on {ident.port.device} ({e})"
    finally:
        client.close()
    return None


def _find_returned_pad(env: Env, before: Optional[ds.Identity],
                       others: Tuple[Tuple[Optional[str], str], ...] = ()) -> Optional[ds.Identity]:
    """The pad that came back. With no earlier identity (a board flashed from the bootloader), pads that
    were already answering before the copy, `others` as (serial, device), are never the one."""
    serial = before.port.serial_number if before else None
    ports = ds.candidate_ports(env.list_ports())
    ports = [p for p in ports if not any((s and s == p.serial_number) or (not s and d == p.device) for s, d in others)]
    if serial:
        ports = [p for p in ports if p.serial_number == serial]
    elif before is not None:
        ports = [p for p in ports if p.device == before.port.device] or ports
    idents = [ds.identify_port(p, env.opener, env.clock) for p in ports]
    pads = [i for i in idents if i.kind == ds.DRIFTPAD]
    return pads[0] if len(pads) == 1 else None


def flash(args: argparse.Namespace, env: Env) -> int:
    uf2 = Path(args.uf2)
    build_dir = uf2.parent

    if args.build:
        env.say("Building the firmware (pio run)...")
        if not env.build(env.say):
            env.say("The build failed; nothing was flashed.")
            return REFUSED

    # 1. The image
    checked = fimg.check_image(uf2, build_dir / "firmware.elf", build_dir / "build_manifest.json",
                               allow_dirty=args.allow_dirty)
    for w in checked.warnings:
        env.say(f"warning: {w}")
    if not checked.ok:
        env.say("The image cannot be flashed:")
        for p in checked.problems:
            env.say(f"  - {p}")
        return REFUSED
    m = checked.manifest
    env.say(f"Image: fw {m['fw_version']} build {m['build_id']} (protocol {m['protocol']}), "
            f"{checked.image.blocks} blocks up to {checked.image.end:#010x}; settings sectors from "
            f"{checked.code_end:#010x} are left alone.")

    # 2. The pad
    before: Optional[ds.Identity] = None
    drive: Optional[Path] = Path(args.drive) if args.drive else None
    if drive is None:
        sel = ds.select_device(env.list_ports, env.opener, port=args.port, clock=env.clock)
        for ident in sel.identities:
            env.say(f"  {ident.describe()}")
        if sel.chosen is not None:
            before = sel.chosen
        elif args.port:
            env.say(f"No DriftPad on {args.port}: {sel.error}")
            return REFUSED
        else:
            drives = env.drives()
            if len(drives) == 1 and not any(i.is_driftpad for i in sel.identities):
                drive = drives[0]
                env.say(f"No DriftPad answers on serial; using the board in bootloader mode at {drive} "
                        "(it cannot be identified before flashing).")
            elif len(drives) > 1:
                env.say(f"{len(drives)} boards are in bootloader mode ({', '.join(map(str, drives))}); "
                        "choose one with --drive.")
                return REFUSED
            else:
                env.say(f"Nothing to flash: {sel.error}.")
                return REFUSED

    # 3. What changes, and what would be lost
    if before is not None:
        env.say(f"Pad: {before.describe()}")
        if before.kind == ds.DRIFTPAD:
            if _settings(before).get("dirty"):
                if not args.discard_unsaved:
                    env.say("The pad has settings changes that are not saved; the update restarts it and they "
                            "would be lost. Save them in the configurator first, or pass --discard-unsaved.")
                    return REFUSED
                env.say("warning: unsaved settings on the pad will be lost (--discard-unsaved).")
            old, new = version_key(before.fw), version_key(m["fw_version"])
            if old and new and new < old and not args.allow_downgrade:
                env.say(f"This would downgrade fw {before.fw} to {m['fw_version']}. Settings saved by the newer "
                        "firmware stay in flash but may not be readable by the older one. Pass --allow-downgrade "
                        "to do it anyway.")
                return REFUSED
        else:
            env.say("The pad runs legacy firmware (protocol 1): its settings are migrated read-only on first boot.")
    if not args.yes:
        answer = env.ask(f"Flash fw {m['fw_version']} build {m['build_id']}? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            env.say("Nothing was flashed.")
            return REFUSED

    # 4. Bootloader and copy
    if drive is None:
        known = set(map(str, env.drives()))
        err = _reboot_to_bootloader(env, before)
        if err:
            env.say(f"{err}. Nothing was flashed.")
            return FAILED
        env.say(f"Waiting for the {DRIVE_LABEL} drive...")
        new_drives = _wait(env, DRIVE_TIMEOUT_S, lambda: [d for d in env.drives() if str(d) not in known])
        if not new_drives:
            env.say(f"The pad did not appear as {DRIVE_LABEL}. Nothing was flashed; hold BOOTSEL while plugging "
                    "it in and run this again.")
            return FAILED
        if len(new_drives) > 1:
            env.say("Several bootloader drives appeared at once; not guessing. Nothing was flashed.")
            return FAILED
        drive = new_drives[0]
    others = tuple((p.serial_number, p.device) for p in ds.candidate_ports(env.list_ports())) if before is None else ()
    env.say(f"Copying {uf2.name} to {drive}...")
    try:
        env.copy(uf2, Path(drive) / uf2.name)
    except OSError as e:
        env.say(f"Copying failed ({e}). The board is still in bootloader mode; run this again.")
        return FAILED

    # 5. Verify
    env.say("Waiting for the pad to restart...")
    after = _wait(env, RETURN_TIMEOUT_S, lambda: _find_returned_pad(env, before, others))
    if after is None:
        env.say("The pad did not come back as a protocol-2 DriftPad. Check that it enumerates (Device Manager / "
                "lsusb); if it is in bootloader mode again the image did not start.")
        return FAILED
    env.say(f"Pad now: {after.describe()}")
    problems = []
    for key, got in (("fw_version", after.fw), ("build_id", after.build), ("protocol", after.protocol)):
        if got != m[key]:
            problems.append(f"{key}: the pad reports {got!r}, the image is {m[key]!r}")
    if before is not None and before.kind == ds.DRIFTPAD:
        bs, as_ = _settings(before), _settings(after)
        if (bs.get("source"), bs.get("seq")) != (as_.get("source"), as_.get("seq")):
            problems.append(f"saved settings changed across the update: {bs.get('source')} #{bs.get('seq')} before, "
                            f"{as_.get('source')} #{as_.get('seq')} after")
        bc, ac = _calibration(before).get("state"), _calibration(after).get("state")
        if bc != ac:
            problems.append(f"calibration was {bc!r} before the update and is {ac!r} after")
    if problems:
        env.say("UPDATE NOT VERIFIED:")
        for p in problems:
            env.say(f"  - {p}")
        return FAILED
    env.say(f"Updated and verified: fw {after.fw} build {after.build} on {after.port.device}.")
    return OK


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
    ap.add_argument("--port", help="the pad's serial port (default: the one DriftPad connected)")
    ap.add_argument("--uf2", default=str(BUILD_DIR / "firmware.uf2"),
                    help="image to flash; firmware.elf and build_manifest.json must sit next to it")
    ap.add_argument("--drive", help="a board already in bootloader mode (its RPI-RP2 drive)")
    ap.add_argument("--build", action="store_true", help="run `pio run` first")
    ap.add_argument("--yes", action="store_true", help="do not ask before flashing")
    ap.add_argument("--discard-unsaved", action="store_true", help="flash although the pad has unsaved settings")
    ap.add_argument("--allow-downgrade", action="store_true", help="flash an older firmware version")
    ap.add_argument("--allow-dirty", action="store_true", help="flash a build made from uncommitted changes")
    return ap.parse_args(argv)


def main(argv: Optional[List[str]] = None, env: Optional[Env] = None) -> int:
    return flash(parse_args(argv), env or Env())


if __name__ == "__main__":
    sys.exit(main())
