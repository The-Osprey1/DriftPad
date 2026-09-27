/*
 * contract.js - protocol constants, setting limits and the label rule shared by every module.
 *
 * Classic script (Chrome blocks ES modules from file://). Everything hangs off window.DriftPad.
 * The live limits come from the device's INFO reply; the values here are the offline fallback and
 * must equal firmware/include/settings_limits.h (tests/test_configurator.py checks every name).
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};

    // Same names and values as firmware/include/settings_limits.h (centi-millimetres, cmm).
    const LIMITS_CMM = Object.freeze({
        ACTUATION_MIN_CMM: 25,
        ACTUATION_MAX_CMM: 380,
        ACTUATION_DEFAULT_CMM: 120,
        RT_SENS_MIN_CMM: 10,
        RT_SENS_MAX_CMM: 200,
        RT_SENS_DEFAULT_CMM: 20,
        UI_STEP_CMM: 5,
        ENCODER_ACTUATION_STEP_CMM: 10,
        ENCODER_RT_SENS_STEP_CMM: 5,
        NUM_LAYERS: 3,
        LABEL_MAX_LEN: 4,
        CODE_MAX: 255,
        PROTOCOL_VERSION: 2,
        LINE_MAX_LEN: 160,
        REQUEST_ID_MAX_LEN: 12,
        STREAM_HZ_DEFAULT: 30,
        STREAM_HZ_MAX: 60,
    });

    const NUM_KEYS = 16;
    const PROTOCOL_VERSION = LIMITS_CMM.PROTOCOL_VERSION;
    const NOMINAL_TRAVEL_MM = 4.0;

    function cmmToMm(cmm) { return cmm / 100; }
    function mmToCmm(mm) { return Math.round(Number(mm) * 100); }

    function deepFreeze(o) {
        Object.values(o).forEach(v => { if (v && typeof v === "object") deepFreeze(v); });
        return Object.freeze(o);
    }

    // Same shape as INFO's "limits" object.
    const FALLBACK_LIMITS = deepFreeze({
        actuation: {
            min: cmmToMm(LIMITS_CMM.ACTUATION_MIN_CMM),
            max: cmmToMm(LIMITS_CMM.ACTUATION_MAX_CMM),
            default: cmmToMm(LIMITS_CMM.ACTUATION_DEFAULT_CMM),
            step: cmmToMm(LIMITS_CMM.UI_STEP_CMM),
        },
        rt_sens: {
            min: cmmToMm(LIMITS_CMM.RT_SENS_MIN_CMM),
            max: cmmToMm(LIMITS_CMM.RT_SENS_MAX_CMM),
            default: cmmToMm(LIMITS_CMM.RT_SENS_DEFAULT_CMM),
            step: cmmToMm(LIMITS_CMM.UI_STEP_CMM),
        },
        layers: LIMITS_CMM.NUM_LAYERS,
        keys: NUM_KEYS,
        label_max: LIMITS_CMM.LABEL_MAX_LEN,
        code_max: LIMITS_CMM.CODE_MAX,
        line_max: LIMITS_CMM.LINE_MAX_LEN,
        stream_hz_max: LIMITS_CMM.STREAM_HZ_MAX,
    });

    // -----------------------------------------------------------------------------------------
    // Labels. Rule (tests/fixtures/label_vectors.json, firmware configNormalizeLabel()):
    // a-z uppercased; then 1..4 characters, each printable ASCII 0x21..0x7E except '"', '\' and
    // '@'. Anything else is rejected, never silently rewritten.
    // -----------------------------------------------------------------------------------------
    function labelCharAllowed(c) {
        return c >= 0x21 && c <= 0x7E && c !== 0x22 && c !== 0x5C && c !== 0x40;
    }

    // Returns the normalised label, or null when the input breaks the rule.
    function normalizeLabel(input) {
        if (typeof input !== "string") return null;
        let out = "";
        for (let i = 0; i < input.length; i++) {
            let c = input.charCodeAt(i);
            if (c >= 0x61 && c <= 0x7A) c -= 0x20;
            if (!labelCharAllowed(c)) return null;
            out += String.fromCharCode(c);
        }
        if (out.length < 1 || out.length > LIMITS_CMM.LABEL_MAX_LEN) return null;
        return out;
    }

    // Plain-language reason a label is rejected, or null when it is fine.
    function labelProblem(input) {
        if (typeof input !== "string" || input.length === 0) return "A label needs 1 to 4 characters.";
        for (let i = 0; i < input.length; i++) {
            const c = input.charCodeAt(i);
            if (c === 0x20) return "Spaces are not allowed in labels.";
            if (c === 0x22 || c === 0x5C || c === 0x40) {
                return `The character ${input[i]} is not allowed (quote, backslash and @ are reserved).`;
            }
            if (!(c >= 0x61 && c <= 0x7A) && !labelCharAllowed(c)) {
                return "Only plain printable ASCII characters are allowed (no accents, emoji or control characters).";
            }
        }
        if (input.length > LIMITS_CMM.LABEL_MAX_LEN) return `A label can have at most ${LIMITS_CMM.LABEL_MAX_LEN} characters.`;
        return null;
    }

    // -----------------------------------------------------------------------------------------
    // Millimetre values. The protocol prints exactly 2 decimals; more decimals are rejected
    // (bad_number), so the UI never sends them.
    // -----------------------------------------------------------------------------------------
    function formatMm(mm) {
        return (mmToCmm(mm) / 100).toFixed(2);
    }

    // Parses user-typed text such as "1.2" or "0.35"; null when it is not a plain number with at
    // most 2 decimals.
    function parseMm(text) {
        const s = String(text).trim();
        if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
        return mmToCmm(Number(s)) / 100;
    }

    // null when `mm` is inside `limit` ({min,max}), otherwise a message.
    function mmProblem(mm, limit) {
        if (typeof mm !== "number" || !Number.isFinite(mm)) return "Enter a number in millimetres.";
        const cmm = mmToCmm(mm);
        if (Math.abs(cmm - mm * 100) > 1e-6) return "Use at most 2 decimals.";
        if (cmm < mmToCmm(limit.min) || cmm > mmToCmm(limit.max)) {
            return `Must be between ${formatMm(limit.min)} and ${formatMm(limit.max)} mm.`;
        }
        return null;
    }

    function sameMm(a, b) {
        return typeof a === "number" && typeof b === "number" && mmToCmm(a) === mmToCmm(b);
    }

    // -----------------------------------------------------------------------------------------
    // Error codes (contract section 2) with plain-language explanations.
    // -----------------------------------------------------------------------------------------
    const ERROR_CODES = Object.freeze({
        unknown_command: "The device does not know this command.",
        bad_request: "The request was malformed.",
        bad_arguments: "Wrong number of arguments.",
        bad_number: "Not a valid number (at most 2 decimals).",
        out_of_range: "The value is outside the allowed range.",
        invalid_label: "The label breaks the label rule (1-4 printable characters, no spaces, quotes, backslash or @).",
        invalid_code: "That key code does not produce a key on this pad.",
        busy: "The device is busy (for example, calibration is running).",
        not_allowed: "Not allowed right now.",
        calibration_required: "Calibrate the pad first.",
        calibration_incomplete: "Not every key finished the calibration press.",
        keys_not_at_rest: "Some keys are not at rest. Take your hands off the pad.",
        line_too_long: "The command line was too long.",
        flash_error: "Writing flash failed. The previous saved copy is still valid.",
        flash_verify_failed: "Flash read-back did not match. The previous saved copy is still valid.",
        display_timeout: "The display did not answer in time.",
        unsupported: "This firmware does not support that.",
    });

    function errorText(code, msg) {
        const known = ERROR_CODES[code];
        if (known && msg && msg !== known) return `${known} (${msg})`;
        return known || msg || (code ? `Device error: ${code}` : "Device error");
    }

    const OUTPUT_REASONS = Object.freeze({
        enabled: "Keyboard output is on.",
        disabled_default: "Off: keyboard output starts disabled at power-up (standalone mode is off).",
        calibration_missing: "Off: the pad has not been calibrated yet.",
        calibration_invalid: "Off: the stored calibration failed its plausibility check. Calibrate again.",
        calibration_in_progress: "Off while calibration is running.",
        user_disabled: "Off: turned off from the configurator or the knob menu.",
        forced: "On, forced for bench testing although calibration is not valid.",
    });

    const CAL_STATES = Object.freeze({
        valid: "Valid: every key has a plausible rest point and press range.",
        missing: "Missing: the pad has never been calibrated (or it was cleared).",
        invalid: "Invalid: the stored calibration failed its plausibility check.",
        in_progress: "Calibration is running.",
    });

    const FEATURES = Object.freeze([
        "keymap", "layers", "rapid_trigger", "guided_calibration", "settings_ab", "telemetry",
        "timing", "raw", "sim", "display", "boot_output",
    ]);

    // Verbs the configurator sends, with the canonical "cmd" each reply must carry.
    const ALIASES = Object.freeze({ HELLO: "INFO", HID: "SET_HID", OUTPUT: "SET_HID" });

    // Acceptable reply "cmd" values for a request. Two-word commands (CAL START) may be reported
    // either as the verb or as VERB_SUB.
    function expectedCmds(verb, args) {
        const v = String(verb).toUpperCase();
        const canon = ALIASES[v] || v;
        const out = [canon];
        if (canon === "CAL" && args && args.length) out.push("CAL_" + String(args[0]).toUpperCase());
        return out;
    }

    const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,12}$/;

    DP.contract = Object.freeze({
        LIMITS_CMM,
        NUM_KEYS,
        PROTOCOL_VERSION,
        NOMINAL_TRAVEL_MM,
        FALLBACK_LIMITS,
        ERROR_CODES,
        OUTPUT_REASONS,
        CAL_STATES,
        FEATURES,
        REQUEST_ID_RE,
        cmmToMm,
        mmToCmm,
        normalizeLabel,
        labelProblem,
        formatMm,
        parseMm,
        mmProblem,
        sameMm,
        errorText,
        expectedCmds,
    });
})(typeof window !== "undefined" ? window : globalThis);
