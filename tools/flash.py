#!/usr/bin/env python3
"""
flash.py - Build the firmware and flash it to a connected DriftPad

Works without picotool or a USB driver: it sends BOOTSEL over serial so the Pico
reboots into its bootloader, then copies firmware.uf2 onto the RPI-RP2 drive that
appears. If the board is already in BOOTSEL mode (held the button while plugging
in), the serial step is skipped.

Usage (from the repo root):
    python tools/flash.py [PORT] [--no-build]

PORT defaults to COM3. --no-build flashes the existing firmware.uf2 as is.
"""

import os
import shutil
import string
import subprocess
import sys
import time
from pathlib import Path

import serial

REPO = Path(__file__).resolve().parent.parent
FIRMWARE_DIR = REPO / "firmware"
UF2 = FIRMWARE_DIR / ".pio" / "build" / "pico" / "firmware.uf2"
BAUD = 115200
DRIVE_LABEL = "RPI-RP2"


def build():
    print("Building firmware...")
    for cmd in (["pio", "run"], [sys.executable, "-m", "platformio", "run"]):
        try:
            result = subprocess.run(cmd, cwd=FIRMWARE_DIR)
        except FileNotFoundError:
            continue
        if result.returncode != 0:
            sys.exit("Build failed.")
        return
    sys.exit("PlatformIO not found. Install it, or pass --no-build to flash the existing firmware.uf2.")


def candidate_mounts():
    """Places the RPI-RP2 bootloader drive can show up on each OS."""
    if os.name == "nt":
        return [Path(f"{letter}:\\") for letter in string.ascii_uppercase]
    user = os.environ.get("USER", "")
    return [
        Path("/Volumes") / DRIVE_LABEL,
        Path("/media") / user / DRIVE_LABEL,
        Path("/run/media") / user / DRIVE_LABEL,
    ]


def find_bootloader_drive():
    # INFO_UF2.TXT on the drive names the board, which tells it apart from other USB sticks
    for mount in candidate_mounts():
        info = mount / "INFO_UF2.TXT"
        try:
            if info.is_file() and "RP2" in info.read_text(errors="ignore"):
                return mount
        except OSError:
            continue
    return None


def wait_for(check, timeout_s, what):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        found = check()
        if found:
            return found
        time.sleep(0.25)
    sys.exit(f"Timed out waiting for {what}.")


def port_available(port):
    try:
        serial.Serial(port, BAUD, timeout=0.2).close()
        return True
    except serial.SerialException:
        return False


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = args[0] if args else "COM3"

    if "--no-build" not in sys.argv:
        build()
    if not UF2.is_file():
        sys.exit(f"{UF2} not found. Build the firmware first.")

    drive = find_bootloader_drive()
    if drive is None:
        print(f"Rebooting DriftPad on {port} into BOOTSEL...")
        try:
            with serial.Serial(port, BAUD, timeout=1) as s:
                s.write(b"BOOTSEL\n")
                s.flush()
        except serial.SerialException as e:
            sys.exit(f"Could not open {port} ({e}). Pass the right port, or hold BOOTSEL while plugging in.")
        drive = wait_for(find_bootloader_drive, 10, f"the {DRIVE_LABEL} drive")

    print(f"Copying {UF2.name} to {drive}...")
    shutil.copyfile(UF2, drive / UF2.name)

    wait_for(lambda: port_available(port), 15, f"DriftPad to come back on {port}")
    print(f"Flashed. DriftPad is running the new firmware on {port}.")


if __name__ == "__main__":
    main()
