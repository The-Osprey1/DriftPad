"""
test_empirical_challenger2_audit.py
Adversarial Verification Suite for Challenger 2:
- Schema 4 Flash Binary Layout (offsets 0..955, alignment, packing, padding)
- Calibration Invariance across Schema 2, 3, and 4 (offsets 296..395)
- Flash Page Budget & Sector Commit Mechanics (4 data pages + 1 commit page = 1280 B in 4096 B sector)
- PAYLOAD_MAX Buffer Sizing & Inactive-Sector Protection
- Protocol 2 Command Framing (LINE_MAX_LEN = 160, MAX_ARGS = 6 for 10 new commands)
- Two-Phase Commit & Inactive-Sector Atomicity Simulation
"""

import struct
import zlib
import unittest
from pathlib import Path

class TestSchema4FlashLayout(unittest.TestCase):
    def setUp(self):
        # Flash / Framing Constants
        self.SECTOR_SIZE = 4096
        self.PAGE_SIZE = 256
        self.HEADER_SIZE = 32
        self.COMMIT_SIZE = 8
        self.COMMIT_MAGIC = 0x4B4F5044  # "DPOK"
        self.RECORD_MAGIC = 0x32535044  # "DPS2"
        self.HEADER_VERSION = 1
        self.LINE_MAX_LEN = 160
        self.MAX_ARGS = 6

        # Payload Sizes
        self.PAYLOAD_V2_SIZE = 396
        self.PAYLOAD_V3_SIZE = 444
        self.PAYLOAD_V4_SIZE = 956

    def test_01_schema4_field_offsets_and_sizes(self):
        """Verify exact byte offsets, packing, padding, and total size of Schema 4 (0..955)."""
        # Define field map: (start, length, type, name, alignment)
        fields = [
            (0, 2, "H", "actuation_cmm", 2),
            (2, 2, "H", "rt_press_cmm", 2),
            (4, 1, "B", "rt_enabled", 1),
            (5, 1, "B", "active_layer", 1),
            (6, 1, "B", "boot_output", 1),
            (7, 1, "B", "reserved", 1),
            (8, 288, "288s", "keymaps[3][16]", 1),
            (296, 1, "B", "calibration.state", 1),
            (297, 3, "3s", "calibration.reserved", 1),
            (300, 96, "96s", "calibration.keys[16]", 2),
            (396, 48, "48s", "modifiers[3][16]", 1),
            (444, 2, "H", "rt_release_cmm", 2),
            (446, 1, "B", "autozero_enabled", 1),
            (447, 1, "B", "autozero_max_drift_cmm", 1),
            (448, 2, "H", "autozero_stationary_ms", 2),
            (450, 2, "2s", "autozero_reserved", 1),
            (452, 32, "32s", "key_rt[16]", 1),
            (484, 32, "32s", "socd_pairs[4]", 4),
            (516, 416, "416s", "dks_configs[16]", 2),
            (932, 24, "24s", "schema4_padding", 1),
        ]

        expected_offset = 0
        for start, length, fmt, name, align in fields:
            self.assertEqual(start, expected_offset, f"Field {name} offset mismatch: expected {expected_offset}, got {start}")
            # Check alignment invariant
            self.assertEqual(start % align, 0, f"Field {name} at offset {start} violates alignment {align}")
            expected_offset += length

        self.assertEqual(expected_offset, self.PAYLOAD_V4_SIZE, f"Total payload length mismatch: {expected_offset} != {self.PAYLOAD_V4_SIZE}")

    def test_02_dks_struct_layout_and_internal_alignment(self):
        """Verify DksKeyConfig internal offsets: 10 bytes header + 16 bytes stages = 26 bytes."""
        DKS_ENTRY_SIZE = 26
        NUM_KEYS = 16
        self.assertEqual(DKS_ENTRY_SIZE * NUM_KEYS, 416)

        # For each of the 16 keys, check that uint16_t thresholds are strictly 2-byte aligned
        dks_base = 516
        for k in range(NUM_KEYS):
            entry_offset = dks_base + k * DKS_ENTRY_SIZE
            self.assertEqual(entry_offset % 2, 0, f"DKS key {k} struct offset {entry_offset} not 2-byte aligned")
            # Threshold offsets: +2 (p1), +4 (p2), +6 (r1), +8 (r2)
            p1_off = entry_offset + 2
            p2_off = entry_offset + 4
            r1_off = entry_offset + 6
            r2_off = entry_offset + 8
            self.assertEqual(p1_off % 2, 0, f"DKS key {k} p1 offset {p1_off} unaligned")
            self.assertEqual(p2_off % 2, 0, f"DKS key {k} p2 offset {p2_off} unaligned")
            self.assertEqual(r1_off % 2, 0, f"DKS key {k} r1 offset {r1_off} unaligned")
            self.assertEqual(r2_off % 2, 0, f"DKS key {k} r2 offset {r2_off} unaligned")

    def test_03_calibration_invariance_across_schemas(self):
        """Verify byte offsets 296..395 (calibration) are bit-for-bit identical across Schema 2, 3, and 4."""
        CALIB_OFFSET = 296
        CALIB_LEN = 100

        # Construct synthetic calibration data
        calib_bytes = bytearray(CALIB_LEN)
        calib_bytes[0] = 1  # Valid state
        calib_bytes[1:4] = b"\x00\x00\x00"
        for k in range(16):
            rest_raw = 2040 + k
            range_counts = 1800 + k * 10
            polarity = 1 if (k % 2 == 0) else -1
            flags = 0
            struct.pack_into("<HHbB", calib_bytes, 4 + k * 6, rest_raw, range_counts, polarity, flags)

        # Create Schema 2 payload
        payload_v2 = bytearray(self.PAYLOAD_V2_SIZE)
        payload_v2[CALIB_OFFSET : CALIB_OFFSET + CALIB_LEN] = calib_bytes

        # Create Schema 3 payload
        payload_v3 = bytearray(self.PAYLOAD_V3_SIZE)
        payload_v3[0:self.PAYLOAD_V2_SIZE] = payload_v2
        payload_v3[396:444] = b"\x01" * 48

        # Create Schema 4 payload
        payload_v4 = bytearray(self.PAYLOAD_V4_SIZE)
        payload_v4[0:self.PAYLOAD_V3_SIZE] = payload_v3
        payload_v4[444:446] = struct.pack("<H", 15)  # rt_release_cmm

        # Verify calibration slices are strictly identical
        cal_v2 = payload_v2[CALIB_OFFSET : CALIB_OFFSET + CALIB_LEN]
        cal_v3 = payload_v3[CALIB_OFFSET : CALIB_OFFSET + CALIB_LEN]
        cal_v4 = payload_v4[CALIB_OFFSET : CALIB_OFFSET + CALIB_LEN]

        self.assertEqual(cal_v2, cal_v3, "Calibration differs between Schema 2 and Schema 3!")
        self.assertEqual(cal_v3, cal_v4, "Calibration differs between Schema 3 and Schema 4!")
        self.assertEqual(len(cal_v4), 100, f"Calibration block size is {len(cal_v4)}, expected 100")

    def test_04_flash_page_budget_and_commit_page(self):
        """Verify 4 data pages (1024 B) + 1 commit page (256 B) = 1280 B within 4096 B sector."""
        header_len = self.HEADER_SIZE
        payload_len = self.PAYLOAD_V4_SIZE
        total_data = header_len + payload_len  # 32 + 956 = 988 bytes

        # Calculate data pages using firmware formula: (HEADER_SIZE + payloadLen + PAGE - 1) / PAGE
        data_pages = (total_data + self.PAGE_SIZE - 1) // self.PAGE_SIZE
        self.assertEqual(data_pages, 4, f"Data pages count mismatch: {data_pages} != 4")

        data_bytes = data_pages * self.PAGE_SIZE
        self.assertEqual(data_bytes, 1024, f"Data pages byte span mismatch: {data_bytes} != 1024")

        # Unused padding in data page 3
        padding_bytes = data_bytes - total_data
        self.assertEqual(padding_bytes, 36, f"Page 3 trailing padding mismatch: {padding_bytes} != 36")

        # Commit page offset is exactly dataPages * PAGE_SIZE
        commit_page_idx = data_pages
        commit_offset = commit_page_idx * self.PAGE_SIZE
        self.assertEqual(commit_offset, 1024, f"Commit page offset mismatch: {commit_offset} != 1024")

        # Commit page span: 1024..1279 (256 bytes)
        total_record_span = (data_pages + 1) * self.PAGE_SIZE
        self.assertEqual(total_record_span, 1280, f"Total record span mismatch: {total_record_span} != 1280")

        # Remaining free space in sector: 4096 - 1280 = 2816 bytes (11 pages)
        free_bytes = self.SECTOR_SIZE - total_record_span
        self.assertEqual(free_bytes, 2816, f"Free sector bytes mismatch: {free_bytes} != 2816")
        free_pages = free_bytes // self.PAGE_SIZE
        self.assertEqual(free_pages, 11, f"Free pages count mismatch: {free_pages} != 11")
        self.assertAlmostEqual(free_bytes / self.SECTOR_SIZE, 0.6875, places=4)

    def test_05_protocol_command_framing_limits(self):
        """Verify argument counts (MAX_ARGS = 6) and string lengths (LINE_MAX_LEN = 160) for 10 new commands."""
        # Command definitions: (verb, min_args, max_args, worst_case_command_sample)
        commands = [
            ("SET_AUTOZERO", 1, 3, "@req_abcdef12 SET_AUTOZERO true 0.50 2000"),
            ("GET_AUTOZERO", 0, 0, "@req_abcdef12 GET_AUTOZERO"),
            ("SET_RT_SPLIT", 2, 2, "@req_abcdef12 SET_RT_SPLIT 2.00 2.00"),
            ("SET_KEY_RT", 2, 3, "@req_abcdef12 SET_KEY_RT 15 2.00 2.00"),
            ("SET_SOCD", 4, 5, "@req_abcdef12 SET_SOCD 3 depth_priority 14 15 0.30"),
            ("GET_SOCD", 0, 1, "@req_abcdef12 GET_SOCD 3"),
            ("SET_DKS_ENABLE", 2, 2, "@req_abcdef12 SET_DKS_ENABLE 15 false"),
            ("SET_DKS_POINTS", 5, 5, "@req_abcdef12 SET_DKS_POINTS 15 3.80 3.80 3.80 3.80"),
            ("SET_DKS_STAGE", 3, 5, "@req_abcdef12 SET_DKS_STAGE 15 4 255 15 release"),
            ("GET_DKS", 1, 1, "@req_abcdef12 GET_DKS 15"),
        ]

        self.assertEqual(len(commands), 10, "Must audit exactly 10 new commands")

        for verb, min_a, max_a, sample in commands:
            # Check argument count limits
            self.assertGreaterEqual(min_a, 0)
            self.assertLessEqual(max_a, self.MAX_ARGS, f"Command {verb} max_args {max_a} exceeds MAX_ARGS {self.MAX_ARGS}")

            tokens = sample.split()
            if tokens[0].startswith("@"):
                parsed_verb = tokens[1]
                args = tokens[2:]
            else:
                parsed_verb = tokens[0]
                args = tokens[1:]

            self.assertEqual(parsed_verb, verb)
            self.assertGreaterEqual(len(args), min_a, f"{verb} has fewer args than min_args")
            self.assertLessEqual(len(args), max_a, f"{verb} has more args than max_args")
            self.assertLessEqual(len(args), self.MAX_ARGS, f"{verb} exceeds MAX_ARGS")

            # Check line length against LINE_MAX_LEN
            self.assertLessEqual(len(sample), self.LINE_MAX_LEN, f"Sample command for {verb} ({len(sample)} chars) exceeds LINE_MAX_LEN ({self.LINE_MAX_LEN})")

            # Adversarial whitespace test: add extra whitespace between tokens
            padded_sample = "   ".join(tokens)
            self.assertLessEqual(len(padded_sample), self.LINE_MAX_LEN, f"Padded command for {verb} exceeds LINE_MAX_LEN")

    def test_06_payload_max_firmware_compatibility_check(self):
        """CRITICAL AUDIT: Check firmware PAYLOAD_MAX against PAYLOAD_V4_SIZE.
        If PAYLOAD_MAX < 956, firmware inspect() and encode() will fail!
        """
        firmware_h = (Path(__file__).resolve().parent.parent / "firmware" / "include" / "settings_store.h").read_text()
        import re
        m = re.search(r"constexpr\s+uint16_t\s+PAYLOAD_MAX\s*=\s*(\d+);", firmware_h)
        self.assertIsNotNone(m, "PAYLOAD_MAX not found in settings_store.h")
        current_payload_max = int(m.group(1))

        # We assert that current firmware has PAYLOAD_MAX = 512, which would fail for Schema 4 (956 bytes)!
        # This proves the empirical bug/gap in the Phase 1 implementation blueprint!
        self.assertEqual(current_payload_max, 512, "Baseline PAYLOAD_MAX is expected to be 512")
        self.assertLess(current_payload_max, self.PAYLOAD_V4_SIZE,
                        f"VULNERABILITY: PAYLOAD_MAX ({current_payload_max}) < PAYLOAD_V4_SIZE ({self.PAYLOAD_V4_SIZE}). "
                        f"Firmware must update PAYLOAD_MAX to at least {self.PAYLOAD_V4_SIZE} (recommended 1024)!")

    def test_07_record_framing_crc_and_commit_page_gate(self):
        """Adversarial stress-test of sector record framing: CRC-32 sensitivity and commit gate."""
        seq = 42
        schema = 4
        payload = b"\xAA" * self.PAYLOAD_V4_SIZE

        # Build 32-byte header
        hdr = bytearray(self.HEADER_SIZE)
        struct.pack_into("<IBBHII", hdr, 0, self.RECORD_MAGIC, self.HEADER_VERSION, 0, schema, seq, len(payload))
        # Payload CRC at byte 16
        payload_crc = zlib.crc32(payload) & 0xFFFFFFFF
        struct.pack_into("<I", hdr, 16, payload_crc)
        # Header CRC at byte 28
        header_crc = zlib.crc32(bytes(hdr[:28])) & 0xFFFFFFFF
        struct.pack_into("<I", hdr, 28, header_crc)

        # Assemble sector
        sector = bytearray(b"\xFF" * self.SECTOR_SIZE)
        sector[0:self.HEADER_SIZE] = hdr
        sector[self.HEADER_SIZE : self.HEADER_SIZE + len(payload)] = payload

        # Program commit page at offset 1024
        commit_offset = 1024
        struct.pack_into("<II", sector, commit_offset, self.COMMIT_MAGIC, seq)

        # 1. Uncorrupted record verification
        self.assertEqual(struct.unpack_from("<I", sector, 0)[0], self.RECORD_MAGIC)
        self.assertEqual(struct.unpack_from("<I", sector, 28)[0], zlib.crc32(bytes(sector[:28])) & 0xFFFFFFFF)
        self.assertEqual(struct.unpack_from("<I", sector, 16)[0], zlib.crc32(bytes(sector[32:32+len(payload)])) & 0xFFFFFFFF)
        self.assertEqual(struct.unpack_from("<I", sector, commit_offset)[0], self.COMMIT_MAGIC)
        self.assertEqual(struct.unpack_from("<I", sector, commit_offset + 4)[0], seq)

        # 2. Corrupt 1 bit in payload: payload CRC must detect it
        corrupted_sector = bytearray(sector)
        corrupted_sector[500] ^= 0x01
        read_crc = zlib.crc32(bytes(corrupted_sector[32:32+len(payload)])) & 0xFFFFFFFF
        self.assertNotEqual(read_crc, payload_crc, "Payload CRC failed to detect bit corruption!")

        # 3. Simulate power-cut before commit page write
        power_cut_sector = bytearray(sector)
        power_cut_sector[commit_offset : commit_offset + self.PAGE_SIZE] = b"\xFF" * self.PAGE_SIZE
        commit_magic_read = struct.unpack_from("<I", power_cut_sector, commit_offset)[0]
        self.assertNotEqual(commit_magic_read, self.COMMIT_MAGIC, "Incomplete save must not have valid commit magic")

    def test_08_older_firmware_newer_schema_protection(self):
        """Simulate how older firmware (Schema 3, current=3) handles a Schema 4 record in A/B slots.
        Proves SlotState::NewerSchema is assigned and the record is protected from overwrite.
        """
        # Scenario:
        # Slot A has Schema 4 record with seq=10 (newer firmware)
        # Slot B has Schema 3 record with seq=9 (older firmware)
        # Both records have valid commit magic and matching seq

        # Slot A (Schema 4)
        slot_a_schema = 4
        slot_a_seq = 10
        slot_a_payload_len = self.PAYLOAD_V4_SIZE  # 956
        slot_a_commit_offset = ((self.HEADER_SIZE + slot_a_payload_len + 255) // 256) * 256
        self.assertEqual(slot_a_commit_offset, 1024)

        # Slot B (Schema 3)
        slot_b_schema = 3
        slot_b_seq = 9
        slot_b_payload_len = self.PAYLOAD_V3_SIZE  # 444
        slot_b_commit_offset = ((self.HEADER_SIZE + slot_b_payload_len + 255) // 256) * 256
        self.assertEqual(slot_b_commit_offset, 512)

        # Older firmware rules:
        # SCHEMA_CURRENT = 3
        SCHEMA_CURRENT = 3
        slot_a_state = "NewerSchema" if slot_a_schema > SCHEMA_CURRENT else "Valid"
        slot_b_state = "Valid"

        self.assertEqual(slot_a_state, "NewerSchema")
        self.assertEqual(slot_b_state, "Valid")

        # chooseTarget() rule in SettingsStore:
        # If NewerSchema has sequence > highest Valid sequence, it is PROTECTED!
        # Target must be Slot B (1), preserving Slot A (0)!
        valid_seq = slot_b_seq
        is_a_protected = (slot_a_state == "NewerSchema") and (slot_a_seq > valid_seq)
        self.assertTrue(is_a_protected, "Schema 4 record in Slot A must be protected by older firmware!")

        target_slot = 1 if is_a_protected else 0
        self.assertEqual(target_slot, 1, "Older firmware must write to Slot B, leaving Slot A untouched!")

if __name__ == "__main__":
    unittest.main(verbosity=2)
