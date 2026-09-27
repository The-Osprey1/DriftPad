"""
test_config_schema.py - WebSerial Configuration Protocol, 3-Layer Schema, and Zero-CDN Verification.

Authoritative References:
- ORIGINAL_REQUEST.md: Requirements R2 (Web Configurator Expansion), Acceptance Criteria
- spec_verification_harness.md: Section 8 (Web Configurator Verification), TC-14, TC-15
- PROJECT.md: Milestone M1 Test Suite Harness

Pure Python 3 standard library: zero external pip dependencies.
"""

import json
import re
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional


# ============================================================================
# Serial Protocol & Profile Validators
# ============================================================================

def validate_get_config_payload(payload: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Validates that a GET_CONFIG JSON response conforms to the firmware protocol schema.
    """
    if not isinstance(payload, dict):
        return False, "Payload must be a JSON object"

    if payload.get("type") != "config":
        return False, f"Expected 'type': 'config', got {payload.get('type')}"

    actuation = payload.get("actuation")
    if isinstance(actuation, bool) or not isinstance(actuation, (int, float)) or not (0.25 <= actuation <= 3.80):
        return False, f"Invalid actuation point: {actuation} (must be in [0.25, 3.80] mm)"

    rt_sens = payload.get("rt_sens")
    if isinstance(rt_sens, bool) or not isinstance(rt_sens, (int, float)) or not (0.10 <= rt_sens <= 2.00):
        return False, f"Invalid RT sensitivity: {rt_sens} (must be in [0.10, 2.00] mm)"

    if not isinstance(payload.get("rt_enabled"), bool):
        return False, f"Invalid rt_enabled flag: {payload.get('rt_enabled')}"

    active_layer = payload.get("active_layer")
    if isinstance(active_layer, bool) or not isinstance(active_layer, int) or not (0 <= active_layer <= 2):
        return False, f"Invalid active_layer: {active_layer} (must be 0, 1, or 2)"

    layers = payload.get("layers")
    if not isinstance(layers, list) or len(layers) != 3:
        return False, f"Expected exactly 3 layers, got {len(layers) if isinstance(layers, list) else type(layers)}"

    for l_idx, layer in enumerate(layers):
        if not isinstance(layer, list) or len(layer) != 16:
            return False, f"Layer {l_idx} must contain exactly 16 keys (got {len(layer) if isinstance(layer, list) else type(layer)})"
        for k_idx, key in enumerate(layer):
            if not isinstance(key, dict):
                return False, f"Key L{l_idx}:K{k_idx} is not an object"
            idx_val = key.get("idx")
            if isinstance(idx_val, bool) or idx_val != k_idx:
                return False, f"Key L{l_idx}:K{k_idx} has mismatched idx: {key.get('idx')}"
            code = key.get("code")
            if isinstance(code, bool) or not isinstance(code, int) or not (0 <= code <= 255):
                return False, f"Key L{l_idx}:K{k_idx} has invalid HID code: {code}"
            label = key.get("label")
            if not isinstance(label, str) or len(label) > 4:
                return False, f"Key L{l_idx}:K{k_idx} has invalid label: '{label}' (must be string <= 4 chars)"

    return True, None


def validate_profile_json(data: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Validates complete exported DriftPadProfile against authoritative JSON schema.
    """
    if not isinstance(data, dict):
        return False, "Root must be an object"

    required_root = ["version", "generator", "exported_at", "settings"]
    for req in required_root:
        if req not in data:
            return False, f"Missing required root field: '{req}'"

    if data["version"] != 1:
        return False, f"Unsupported profile version: {data['version']} (expected 1)"

    if not isinstance(data["generator"], str) or len(data["generator"]) == 0:
        return False, "Field 'generator' must be a non-empty string"

    if not isinstance(data["exported_at"], str):
        return False, "Field 'exported_at' must be an ISO8601 string"

    settings = data["settings"]
    if not isinstance(settings, dict):
        return False, "Field 'settings' must be an object"

    # Reuse GET_CONFIG validator for settings payload
    settings_copy = dict(settings)
    settings_copy["type"] = "config"
    return validate_get_config_payload(settings_copy)


class MockSerialCommandParser:
    """
    Parser modeling the RP2040 firmware USB CDC Serial command parser (main.cpp).
    """

    def __init__(self):
        self.actuation_point_mm: float = 1.20
        self.rt_sens_mm: float = 0.20
        self.rt_enabled: bool = True
        self.active_layer: int = 0
        self.layers: List[List[Dict[str, Any]]] = [
            [{"idx": i, "code": 65 + i, "label": f"K{i}"} for i in range(16)]
            for _ in range(3)
        ]

    def execute_command(self, cmd_line: str) -> Dict[str, Any]:
        line = cmd_line.strip()
        if not line:
            return {"status": "error", "msg": "Empty command"}

        tokens = line.split()
        verb = tokens[0].upper()

        if verb == "PING":
            return {"status": "pong"}

        elif verb == "GET_CONFIG":
            return {
                "type": "config",
                "actuation": self.actuation_point_mm,
                "rt_sens": self.rt_sens_mm,
                "rt_enabled": self.rt_enabled,
                "active_layer": self.active_layer,
                "layers": self.layers
            }

        elif verb == "SET_ACTUATION":
            if len(tokens) < 2:
                return {"status": "error", "msg": "Missing value"}
            try:
                val = float(tokens[1])
            except ValueError:
                return {"status": "error", "msg": "Invalid float"}
            if not (0.25 <= val <= 3.80):
                return {"status": "error", "msg": "Actuation out of range [0.25, 3.80]"}
            self.actuation_point_mm = val
            return {"status": "ok", "msg": f"Actuation set to {val:.2f} mm"}

        elif verb == "SET_RT_SENS":
            if len(tokens) < 2:
                return {"status": "error", "msg": "Missing value"}
            try:
                val = float(tokens[1])
            except ValueError:
                return {"status": "error", "msg": "Invalid float"}
            if not (0.10 <= val <= 2.00):
                return {"status": "error", "msg": "RT sensitivity out of range [0.10, 2.00]"}
            self.rt_sens_mm = val
            return {"status": "ok", "msg": f"RT sensitivity set to {val:.2f} mm"}

        elif verb == "SET_RT_ENABLE":
            if len(tokens) < 2:
                return {"status": "error", "msg": "Missing value"}
            val = tokens[1]
            if val not in ("0", "1"):
                return {"status": "error", "msg": "Value must be 0 or 1"}
            self.rt_enabled = (val == "1")
            return {"status": "ok", "msg": f"Rapid Trigger {'ENABLED' if self.rt_enabled else 'DISABLED'}"}

        elif verb == "SET_LAYER":
            if len(tokens) < 2:
                return {"status": "error", "msg": "Missing value"}
            try:
                val = int(tokens[1])
            except ValueError:
                return {"status": "error", "msg": "Invalid layer index"}
            if not (0 <= val <= 2):
                return {"status": "error", "msg": "Layer must be 0, 1, or 2"}
            self.active_layer = val
            return {"status": "ok", "msg": f"Active layer set to {val}"}

        elif verb == "SET_KEY":
            if len(tokens) < 5:
                return {"status": "error", "msg": "Usage: SET_KEY <layer> <key> <code> <label>"}
            try:
                layer = int(tokens[1])
                key = int(tokens[2])
                code = int(tokens[3])
                label = tokens[4][:4].upper()
            except ValueError:
                return {"status": "error", "msg": "Invalid parameters"}

            if not (0 <= layer <= 2) or not (0 <= key <= 15) or not (0 <= code <= 255):
                return {"status": "error", "msg": "Parameter out of range"}

            self.layers[layer][key] = {"idx": key, "code": code, "label": label}
            return {"status": "ok", "msg": f"Key L{layer}:K{key} updated"}

        elif verb == "SIM":
            if len(tokens) < 3:
                return {"status": "error", "msg": "Usage: SIM <key> <mm>"}
            try:
                key = int(tokens[1])
                mm = float(tokens[2])
            except ValueError:
                return {"status": "error", "msg": "Invalid SIM parameters"}
            if not (0 <= key <= 15) or not (0.0 <= mm <= 4.0):
                return {"status": "error", "msg": "SIM parameter out of range"}
            return {"status": "ok", "msg": f"Injected {mm:.2f}mm on key {key}"}

        elif verb in ("SAVE", "RESET"):
            return {"status": "ok", "msg": f"Command {verb} executed"}

        elif verb == "STREAM":
            if len(tokens) < 2 or tokens[1] not in ("0", "1"):
                return {"status": "error", "msg": "Usage: STREAM <0|1>"}
            return {"status": "ok", "msg": f"Telemetry streaming {'enabled' if tokens[1] == '1' else 'disabled'}"}

        else:
            return {"status": "error", "msg": f"Unknown command: {verb}"}


# ============================================================================
# Test Suite: TestConfigSchema
# ============================================================================

class TestConfigSchema(unittest.TestCase):
    """
    Validates WebSerial configuration format, profile JSON backup/restore,
    and checks that configurator/index.html has zero external CDN dependencies.
    """

    @classmethod
    def setUpClass(cls):
        cls.root_dir = Path(__file__).resolve().parent.parent
        cls.configurator_path = cls.root_dir / "configurator" / "index.html"

    def test_offline_zero_external_dependencies(self):
        """Verifies configurator/index.html operates 100% offline with zero external CDN dependencies."""
        self._assert_offline(self.configurator_path)

    def test_keymap_editor_offline(self):
        """Verifies configurator/keymap.html operates 100% offline with zero external CDN dependencies."""
        self._assert_offline(self.configurator_path.with_name("keymap.html"))

    def test_keymap_editor_defaults_match_firmware(self):
        """The keymap editor's default Layer 0 must match setDefaultKeymaps() in config.cpp."""
        editor = self.configurator_path.with_name("keymap.html").read_text(encoding="utf-8")
        firmware = (self.root_dir / "firmware" / "src" / "config.cpp").read_text(encoding="utf-8")
        l0_block = firmware.split("const LayerKey l0", 1)[1].split("};", 1)[0]
        fw_labels = re.findall(r'\{\s*[^,]+,\s*"([^"]*)"\s*\}', l0_block)
        editor_block = editor.split("const DEFAULTS = [", 1)[1].split("]],", 1)[0] + "]"
        editor_labels = re.findall(r'\[[^,\[\]]+,"([^"]*)"\]', editor_block)
        self.assertEqual(len(fw_labels), 16)
        self.assertEqual(editor_labels, fw_labels)

    def _assert_offline(self, path):
        self.assertTrue(path.is_file(), f"Missing configurator at {path}")
        html_content = path.read_text(encoding="utf-8")

        # Scan for external URLs in src, href, @import, url(...)
        src_href_matches = re.findall(
            r'(?:src|href)\s*=\s*["\'](https?://[^"\']+|//[^"\']+)["\']',
            html_content,
            re.IGNORECASE
        )
        css_url_matches = re.findall(
            r'url\(\s*["\']?(https?://[^)"\']+|//[^)"\']+)["\']?\s*\)',
            html_content,
            re.IGNORECASE
        )
        import_matches = re.findall(
            r'@import\s+["\'](https?://[^"\']+|//[^"\']+)["\']',
            html_content,
            re.IGNORECASE
        )

        all_external = src_href_matches + css_url_matches + import_matches
        self.assertEqual(
            len(all_external), 0,
            f"Found external network dependencies in {path.name}:\n" + "\n".join(all_external)
        )

    def test_tc14_webserial_protocol_commands(self):
        """TC-14: Validates WebSerial line-oriented command parser and parameter validation."""
        parser = MockSerialCommandParser()

        # 1. PING
        res = parser.execute_command("PING\n")
        self.assertEqual(res.get("status"), "pong")

        # 2. GET_CONFIG
        cfg = parser.execute_command("GET_CONFIG")
        valid, err = validate_get_config_payload(cfg)
        self.assertTrue(valid, f"GET_CONFIG payload invalid: {err}")

        # 3. SET_ACTUATION valid & invalid
        res = parser.execute_command("SET_ACTUATION 1.75")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(parser.actuation_point_mm, 1.75)

        res_err = parser.execute_command("SET_ACTUATION 4.50")  # > 3.80mm
        self.assertEqual(res_err["status"], "error")

        res_err2 = parser.execute_command("SET_ACTUATION 0.20")  # < 0.25mm (below deadzone buffer)
        self.assertEqual(res_err2["status"], "error")

        # 4. SET_RT_SENS valid & invalid
        res = parser.execute_command("SET_RT_SENS 0.12")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(parser.rt_sens_mm, 0.12)

        res_err = parser.execute_command("SET_RT_SENS 0.05")  # < 0.10mm floor
        self.assertEqual(res_err["status"], "error")

        res_err2 = parser.execute_command("SET_RT_SENS 2.50")  # > 2.00mm
        self.assertEqual(res_err2["status"], "error")

        # 5. SET_RT_ENABLE
        res = parser.execute_command("SET_RT_ENABLE 0")
        self.assertEqual(res["status"], "ok")
        self.assertFalse(parser.rt_enabled)
        res = parser.execute_command("SET_RT_ENABLE 1")
        self.assertEqual(res["status"], "ok")
        self.assertTrue(parser.rt_enabled)

        # 6. SET_LAYER
        res = parser.execute_command("SET_LAYER 2")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(parser.active_layer, 2)

        res_err = parser.execute_command("SET_LAYER 3")
        self.assertEqual(res_err["status"], "error")

        # 7. SET_KEY
        res = parser.execute_command("SET_KEY 1 5 119 W")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(parser.layers[1][5]["code"], 119)
        self.assertEqual(parser.layers[1][5]["label"], "W")

        # 8. SIM
        res = parser.execute_command("SIM 0 2.45")
        self.assertEqual(res["status"], "ok")

        # 9. STREAM
        res = parser.execute_command("STREAM 1")
        self.assertEqual(res["status"], "ok")

        # 10. SAVE and RESET
        self.assertEqual(parser.execute_command("SAVE")["status"], "ok")
        self.assertEqual(parser.execute_command("RESET")["status"], "ok")

    def test_tc15_profile_json_backup_restore_roundtrip(self):
        """TC-15: 3-layer export and restore round-trip schema test with 100% parameter fidelity."""
        # 1. Construct a rich 3-layer custom profile
        custom_layers = []
        for l in range(3):
            keys = []
            for k in range(16):
                keys.append({
                    "idx": k,
                    "code": 100 + l * 20 + k,
                    "label": f"L{l}K{k}"[:4]
                })
            custom_layers.append(keys)

        original_profile = {
            "version": 1,
            "generator": "DriftPad Configurator v2.0",
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "settings": {
                "actuation": 2.15,
                "rt_sens": 0.12,
                "rt_enabled": True,
                "active_layer": 2,
                "layers": custom_layers
            }
        }

        # 2. Validate original profile against schema
        valid, err = validate_profile_json(original_profile)
        self.assertTrue(valid, f"Original profile failed schema validation: {err}")

        # 3. Export to JSON string
        json_str = json.dumps(original_profile, indent=2)

        # 4. Simulate restore / parse back from JSON
        restored_profile = json.loads(json_str)

        # 5. Validate restored profile against schema
        valid, err = validate_profile_json(restored_profile)
        self.assertTrue(valid, f"Restored profile failed schema validation: {err}")

        # 6. Assert exact deep equality between source and restored settings
        orig_s = original_profile["settings"]
        rest_s = restored_profile["settings"]
        self.assertEqual(orig_s["actuation"], rest_s["actuation"])
        self.assertEqual(orig_s["rt_sens"], rest_s["rt_sens"])
        self.assertEqual(orig_s["rt_enabled"], rest_s["rt_enabled"])
        self.assertEqual(orig_s["active_layer"], rest_s["active_layer"])

        for l in range(3):
            for k in range(16):
                self.assertEqual(orig_s["layers"][l][k]["idx"], rest_s["layers"][l][k]["idx"])
                self.assertEqual(orig_s["layers"][l][k]["code"], rest_s["layers"][l][k]["code"])
                self.assertEqual(orig_s["layers"][l][k]["label"], rest_s["layers"][l][k]["label"])

    def test_profile_schema_adversarial_rejection(self):
        """Verifies schema validator rejects malformed, incomplete, or corrupted profile payloads."""
        valid_template = {
            "version": 1,
            "generator": "Test",
            "exported_at": "2026-09-25T00:00:00Z",
            "settings": {
                "actuation": 1.20,
                "rt_sens": 0.20,
                "rt_enabled": True,
                "active_layer": 0,
                "layers": [
                    [{"idx": i, "code": i, "label": f"K{i}"} for i in range(16)]
                    for _ in range(3)
                ]
            }
        }

        # Case A: Missing version
        bad_a = dict(valid_template)
        del bad_a["version"]
        valid, _ = validate_profile_json(bad_a)
        self.assertFalse(valid)

        # Case B: Unsupported version
        bad_b = dict(valid_template)
        bad_b["version"] = 99
        valid, _ = validate_profile_json(bad_b)
        self.assertFalse(valid)

        # Case C: Actuation point out of range (>3.8mm)
        bad_c = json.loads(json.dumps(valid_template))
        bad_c["settings"]["actuation"] = 5.00
        valid, _ = validate_profile_json(bad_c)
        self.assertFalse(valid)

        # Case D: Only 2 layers provided instead of 3
        bad_d = json.loads(json.dumps(valid_template))
        bad_d["settings"]["layers"] = bad_d["settings"]["layers"][:2]
        valid, _ = validate_profile_json(bad_d)
        self.assertFalse(valid)

        # Case E: Key label too long (>4 chars)
        bad_e = json.loads(json.dumps(valid_template))
        bad_e["settings"]["layers"][0][0]["label"] = "TOOLONG"
        valid, _ = validate_profile_json(bad_e)
        self.assertFalse(valid)

        # Case F: Key missing in layer (15 keys instead of 16)
        bad_f = json.loads(json.dumps(valid_template))
        bad_f["settings"]["layers"][0] = bad_f["settings"]["layers"][0][:15]
        valid, _ = validate_profile_json(bad_f)
        self.assertFalse(valid)

        # Case G: Actuation point below minimum (<0.25mm, e.g. 0.20mm)
        bad_g = json.loads(json.dumps(valid_template))
        bad_g["settings"]["actuation"] = 0.20
        valid, err_g = validate_profile_json(bad_g)
        self.assertFalse(valid, "Actuation point < 0.25mm must be rejected to respect top deadzone")

        # Case H: Boolean actuation rejected (bool inherits from int in Python)
        bad_h = json.loads(json.dumps(valid_template))
        bad_h["settings"]["actuation"] = True
        valid, err_h = validate_profile_json(bad_h)
        self.assertFalse(valid, "Boolean actuation must be rejected")

        # Case I: Boolean active_layer rejected
        bad_i = json.loads(json.dumps(valid_template))
        bad_i["settings"]["active_layer"] = True
        valid, err_i = validate_profile_json(bad_i)
        self.assertFalse(valid, "Boolean active_layer must be rejected")

    def test_get_config_payload_adversarial_rejection(self):
        """Verifies validate_get_config_payload rejects booleans in numeric fields and out-of-range actuation."""
        valid_cfg = {
            "type": "config",
            "actuation": 1.20,
            "rt_sens": 0.20,
            "rt_enabled": True,
            "active_layer": 0,
            "layers": [
                [{"idx": i, "code": 65 + i, "label": f"K{i}"} for i in range(16)]
                for _ in range(3)
            ]
        }

        # 1. Reject boolean actuation
        cfg_bool_act = dict(valid_cfg)
        cfg_bool_act["actuation"] = True
        valid, _ = validate_get_config_payload(cfg_bool_act)
        self.assertFalse(valid, "Boolean actuation must be rejected")

        # 2. Reject actuation < 0.25mm
        cfg_sub_act = dict(valid_cfg)
        cfg_sub_act["actuation"] = 0.15
        valid, _ = validate_get_config_payload(cfg_sub_act)
        self.assertFalse(valid, "Actuation < 0.25mm must be rejected")

        # 3. Reject boolean active_layer
        cfg_bool_layer = dict(valid_cfg)
        cfg_bool_layer["active_layer"] = True
        valid, _ = validate_get_config_payload(cfg_bool_layer)
        self.assertFalse(valid, "Boolean active_layer must be rejected")

        # 4. Reject boolean key code
        cfg_bool_code = json.loads(json.dumps(valid_cfg))
        cfg_bool_code["layers"][0][0]["code"] = True
        valid, _ = validate_get_config_payload(cfg_bool_code)
        self.assertFalse(valid, "Boolean key code must be rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)
