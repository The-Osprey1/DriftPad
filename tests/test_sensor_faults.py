"""Sustained rail faults and safe recovery through the real firmware and USB output stack."""
import ctypes
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import device_host as dh
from test_persistence_device import calibrate

CHANNELS = [10, 9, 6, 4, 11, 8, 7, 5, 12, 14, 0, 2, 13, 15, 1, 3]


class TestSensorFaults(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib = dh.current_device()

    def setUp(self):
        self.lib.reset_flash()
        self.lib.mux_fake_set_all(2048)
        self.d = dh.Device(self.lib)
        calibrate(self.d)
        self.one("SET_HID 1")

    def one(self, command):
        replies = self.d.replies(command)
        self.assertEqual(len(replies), 1, replies)
        self.assertEqual(replies[0]["status"], "ok", replies)
        return replies[0]

    def scans(self, n):
        self.d.run(n * 10)

    def raw(self, key, value):
        self.lib.mux_fake_set(CHANNELS[key], value)

    def host(self):
        buf = (ctypes.c_uint8 * 7)()
        self.lib.usbfake_host_state(buf)
        return tuple(buf)

    def test_isolated_rail_samples_cannot_actuate_or_accumulate_a_fault(self):
        for value in (0, 4095):
            for _ in range(12):
                self.raw(1, value)
                self.scans(1)
                self.assertFalse(self.lib.is_pressed(1))
                self.raw(1, 2048)
                self.scans(1)
            self.assertEqual(self.lib.vd_fault_mask(), 0)
            self.assertEqual(self.host(), (0,) * 7)

    def test_sustained_rail_releases_only_the_affected_host_key_and_reports_it(self):
        for value in (0, 4095):
            with self.subTest(rail=value):
                self.lib.set_travel(1, 3.0)
                self.lib.set_travel(2, 3.0)
                self.scans(30)
                self.assertEqual(len([v for v in self.host()[1:] if v]), 2)
                self.raw(1, value)
                self.scans(7)
                self.assertEqual(self.lib.vd_fault_mask(), 0)
                self.scans(1)
                self.assertEqual(self.lib.vd_fault_mask(), 1 << 1)
                self.assertFalse(self.lib.is_pressed(1))
                self.scans(5)
                self.assertEqual(len([v for v in self.host()[1:] if v]), 1)
                self.assertEqual(self.one("INFO")["calibration"]["faults"], [1])
                self.raw(1, 2048)
                self.lib.set_travel(2, 0.0)
                self.scans(120)
                self.assertEqual(self.lib.vd_fault_mask(), 0)

    def test_recovery_requires_consecutive_rest_samples_and_a_fresh_press(self):
        self.raw(1, 0)
        self.scans(8)
        self.assertEqual(self.lib.vd_fault_mask(), 1 << 1)
        self.lib.set_travel(1, 3.0)
        self.scans(200)
        self.assertEqual(self.lib.vd_fault_mask(), 1 << 1, "held key cannot recover")
        self.assertEqual(self.host(), (0,) * 7)
        self.raw(1, 2048)
        self.scans(99)
        self.assertEqual(self.lib.vd_fault_mask(), 1 << 1)
        self.raw(1, 4095)
        self.scans(1)
        self.raw(1, 2048)
        self.scans(99)
        self.assertEqual(self.lib.vd_fault_mask(), 1 << 1, "rail spike resets recovery")
        self.scans(1)
        self.assertEqual(self.lib.vd_fault_mask(), 0)
        self.scans(10)
        self.assertEqual(self.host(), (0,) * 7)
        self.lib.set_travel(1, 3.0)
        self.scans(30)
        self.assertTrue(any(self.host()[1:]), "fresh press after recovery works")

    def test_boot_fault_cannot_recover_at_an_incorrect_rest_point(self):
        self.one("SAVE")
        self.raw(1, 0)
        self.d = dh.Device(self.lib)
        self.assertEqual(self.lib.vd_fault_mask(), 1 << 1)
        self.raw(1, 2800)
        self.scans(200)
        self.assertEqual(self.lib.vd_fault_mask(), 1 << 1)
        self.raw(1, 2048)
        self.scans(100)
        self.assertEqual(self.lib.vd_fault_mask(), 0)

    def test_negative_polarity_recovers_and_healthy_output_remains_usable(self):
        self.one("CAL START")
        self.scans(700)
        for key in range(16):
            self.raw(key, 1148)
            self.scans(8)
            self.raw(key, 2048)
            self.scans(8)
        self.one("CAL FINISH")
        self.one("SET_HID 1")
        self.raw(1, 1148)
        self.scans(30)
        self.assertTrue(any(self.host()[1:]))
        self.raw(1, 4095)
        self.scans(15)
        self.assertEqual(self.host(), (0,) * 7)
        self.raw(1, 2048)
        self.scans(110)
        self.assertEqual(self.lib.vd_fault_mask(), 0)
        self.raw(1, 1148)
        self.scans(30)
        self.assertTrue(any(self.host()[1:]))
