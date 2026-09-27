"""
test_config_schema.py - The real firmware's GET_CONFIG reply satisfies the documented schema.

Scope: TC-14 is the host-compiled firmware's GET_CONFIG reply; the adversarial test shows the
validator TC-14 relies on does reject malformed payloads (so TC-14 cannot pass vacuously).

Moved elsewhere (these used to live here):
  - configurator offline and default-keymap checks: tests/test_contract_consistency.py
  - backup/restore round trip: configurator/tests/session_tests.js, on the real backup.js
    (the "profile" format the old checks validated was never produced by the configurator)

Pure Python 3 standard library.
"""

import json
import sys
import unittest
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))


# ============================================================================
# Serial Protocol & Profile Validators
# ============================================================================

def label_ok(label: Any) -> bool:
    """A label as the firmware stores it (tests/fixtures/label_vectors.json, already normalised)."""
    return (isinstance(label, str) and 1 <= len(label) <= 4 and
            all(0x21 <= ord(c) <= 0x7E and c not in '"\@' and not ("a" <= c <= "z") for c in label))


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

    for flag in ("rt_enabled", "boot_output", "dirty"):
        if not isinstance(payload.get(flag), bool):
            return False, f"Invalid {flag} flag: {payload.get(flag)!r}"

    seq = payload.get("settings_seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
        return False, f"Invalid settings_seq: {seq!r}"

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
            if not label_ok(label):
                return False, f"Key L{l_idx}:K{k_idx} has invalid label: {label!r} (label rule: 1-4 of 0x21..0x7E except \" \ @, no lower case)"

    return True, None


class TestConfigSchema(unittest.TestCase):
    """GET_CONFIG schema: the real firmware's reply, and the validator's own rejections."""

    def test_tc14_real_get_config_payload_matches_schema(self):
        """TC-14: the GET_CONFIG reply of the real firmware (whole image on the host) satisfies the
        schema validator; the protocol itself is covered by tests/test_protocol_device.py."""
        import device_host as dh
        device = dh.Device(dh.current_device())
        payload = device.config()
        valid, err = validate_get_config_payload(payload)
        self.assertTrue(valid, f"firmware GET_CONFIG does not match the schema: {err}")

    def test_get_config_payload_adversarial_rejection(self):
        """Verifies validate_get_config_payload rejects booleans in numeric fields and out-of-range actuation."""
        valid_cfg = {
            "type": "config",
            "actuation": 1.20,
            "rt_sens": 0.20,
            "rt_enabled": True,
            "boot_output": False,
            "dirty": False,
            "settings_seq": 3,
            "active_layer": 0,
            "layers": [
                [{"idx": i, "code": 65 + i, "label": f"K{i}"} for i in range(16)]
                for _ in range(3)
            ]
        }

        self.assertEqual(validate_get_config_payload(valid_cfg), (True, None), "the template itself is valid")

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

        # 5. Labels that break the rule, and missing persistence fields
        for bad_label in ("", "ABCDE", "a", "A B", 'A"', "A\\", "@", "É"):
            cfg = json.loads(json.dumps(valid_cfg))
            cfg["layers"][1][2]["label"] = bad_label
            self.assertFalse(validate_get_config_payload(cfg)[0], f"label {bad_label!r} must be rejected")
        for field in ("boot_output", "dirty", "settings_seq"):
            cfg = dict(valid_cfg)
            del cfg[field]
            self.assertFalse(validate_get_config_payload(cfg)[0], f"missing {field} must be rejected")


if __name__ == "__main__":
    unittest.main(verbosity=2)
