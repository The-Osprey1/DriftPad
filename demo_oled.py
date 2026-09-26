#!/usr/bin/env python3
"""
demo_oled.py - DriftPad OLED Live Showcase Script

Runs an interactive animation on the physical OLED display via COM3:
1. "Breathing" analog travel bar gauge
2. 4x4 Key Matrix ripple/snake patterns
3. Rapid Trigger rapid turnaround demonstration
"""

import sys
import time
import math
import serial

PORT = "COM3"
BAUD = 115200

def run_demo(port=PORT):
    print(f"Connecting to DriftPad on {port}...")
    try:
        s = serial.Serial(port, BAUD, timeout=1)
    except Exception as e:
        print(f"Error opening {port}: {e}")
        return

    time.sleep(0.2)
    s.reset_input_buffer()

    print(">>> Stage 1: Analog Gauge Sine Wave Sweep (Breathing Bar)...")
    for step in range(80):
        t = step * 0.12
        travel = 2.0 + 1.8 * math.sin(t)
        s.write(f"SIM 0 {travel:.2f}\n".encode())
        time.sleep(0.035)

    print(">>> Stage 2: 4x4 Matrix Cascade / Diagonal Wave...")
    for cycle in range(2):
        for d in range(7):
            keys = [r * 4 + (d - r) for r in range(4) if 0 <= (d - r) < 4]
            for k in keys:
                s.write(f"SIM {k} 2.80\n".encode())
            time.sleep(0.10)
            for k in keys:
                s.write(f"SIM {k} 0.00\n".encode())

    print(">>> Stage 3: Rapid Trigger High-Frequency Actuation Flutter...")
    for _ in range(12):
        s.write(b"SIM 5 2.20\n")  # Actuate
        time.sleep(0.05)
        s.write(b"SIM 5 1.95\n")  # RT Release (-0.25mm)
        time.sleep(0.05)
        s.write(b"SIM 5 2.20\n")  # RT Re-press (+0.25mm)
        time.sleep(0.05)

    print(">>> Stage 4: Reset all keys to resting position...")
    for k in range(16):
        s.write(f"SIM {k} 0.00\n".encode())
    time.sleep(0.1)

    s.close()
    print("Demo showcase complete! Display is in active Ready state.")

if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else PORT
    run_demo(p)
