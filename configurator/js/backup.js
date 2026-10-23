/*
 * backup.js - versioned backup and restore of the user settings.
 *
 * Format (format_version 1):
 *   {"format":"driftpad-backup","format_version":1,"created":"<ISO>",
 *    "source":{"fw","protocol","build"},
 *    "settings":{"actuation_mm","rt_sens_mm","rt_enabled","active_layer","boot_output"},
 *    "layers":[3][16]{"code","label"}}
 * Calibration is specific to one pad's sensors and magnets, so it is never part of a backup.
 *
 * Also accepted for import: the keymap-only export of the old keymap editor
 * ({"device":"DriftPad","version":1,"layers":[...]}), restored as keymaps only.
 *
 * restore() sends each value, then reads the whole configuration back with a fresh GET_CONFIG
 * and compares every field. The result lists exactly what did not end up on the device. Nothing
 * is saved to flash; Save stays an explicit step.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};
    const C = DP.contract;
    const { checkLayers } = DP.draft;

    const FORMAT = "driftpad-backup";
    const FORMAT_VERSION = 1;

    function create(session) {
        if (!session.isConnected || !session.confirmed) throw new Error("Connect a DriftPad first: a backup is taken from the device.");
        const c = session.confirmed;
        return {
            format: FORMAT,
            format_version: FORMAT_VERSION,
            created: new Date().toISOString(),
            source: { fw: session.info.fw, protocol: session.info.protocol, build: session.info.build },
            settings: {
                actuation_mm: c.actuation,
                rt_sens_mm: c.rt_sens,
                rt_enabled: c.rt_enabled,
                active_layer: c.active_layer,
                boot_output: !!c.boot_output,
            },
            layers: c.layers.map(l => l.map(k => ({ code: k.code, label: k.label }))),
        };
    }

    // Parses and validates backup text against `limits` (the device's, or the built-in fallback).
    // Returns {kind:"full"|"keymap", settings, layers, problems:[], warnings:[]}; problems non-empty
    // means nothing may be restored.
    function parse(text, limits) {
        const problems = [];
        const warnings = [];
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return { kind: null, settings: null, layers: null, problems: ["The file is not valid JSON."], warnings };
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return { kind: null, settings: null, layers: null, problems: ["The file does not contain a DriftPad backup."], warnings };
        }
        const legacy = data.device === "DriftPad" && data.version === 1 && Array.isArray(data.layers) && !("format" in data);
        if (!legacy) {
            if (data.format !== FORMAT) problems.push(`Unknown file format ${JSON.stringify(data.format)} (expected "${FORMAT}").`);
            else if (data.format_version !== FORMAT_VERSION) {
                problems.push(`Backup format version ${JSON.stringify(data.format_version)} is not supported (this configurator reads version ${FORMAT_VERSION}).`);
            }
            if (problems.length) return { kind: null, settings: null, layers: null, problems, warnings };
        }
        const lay = checkLayers(data.layers, { strict: !legacy });
        problems.push(...lay.problems);
        warnings.push(...lay.warnings);
        if (legacy) {
            warnings.push("Keymap-only file from the old keymap editor: only the keymaps will be restored.");
            return { kind: "keymap", settings: null, layers: lay.layers, problems, warnings };
        }
        const s = data.settings;
        let settings = null;
        if (!s || typeof s !== "object") {
            problems.push("settings is missing.");
        } else {
            settings = {};
            for (const [field, key, lim] of [["actuation", "actuation_mm", limits.actuation], ["rt_sens", "rt_sens_mm", limits.rt_sens]]) {
                const v = s[key];
                const p = C.mmProblem(v, lim);
                if (p) problems.push(`settings.${key}: ${p}`);
                else settings[field] = C.mmToCmm(v) / 100;
            }
            if (typeof s.rt_enabled !== "boolean") problems.push("settings.rt_enabled must be true or false.");
            else settings.rt_enabled = s.rt_enabled;
            if (!Number.isInteger(s.active_layer) || s.active_layer < 0 || s.active_layer >= limits.layers) {
                problems.push(`settings.active_layer must be 0 to ${limits.layers - 1}.`);
            } else settings.active_layer = s.active_layer;
            if (s.boot_output !== undefined) {
                if (typeof s.boot_output !== "boolean") problems.push("settings.boot_output must be true or false.");
                else settings.boot_output = s.boot_output;
            }
        }
        if (data.source && typeof data.source === "object" && data.source.protocol !== undefined &&
            data.source.protocol !== C.PROTOCOL_VERSION) {
            warnings.push(`The backup was made with protocol ${data.source.protocol}; values are checked against this device's limits.`);
        }
        return { kind: "full", settings: problems.length ? null : settings, layers: problems.length ? null : lay.layers, problems, warnings };
    }

    // Applies a parsed backup. Resolves with {applied:[], failed:[{what,error}], mismatched:[{what,expected,actual}]}.
    async function restore(session, parsed, onProgress = () => {}) {
        if (!parsed || parsed.problems.length) throw new Error("This backup has problems and cannot be restored.");
        if (!session.isConnected) throw new Error("Not connected");
        return session.runOp("restore", async () => {
            const result = { applied: [], failed: [], mismatched: [] };
            const steps = [];
            if (parsed.settings) {
                for (const field of ["actuation", "rt_sens", "rt_enabled", "active_layer", "boot_output"]) {
                    if (parsed.settings[field] === undefined) continue;
                    if (field === "boot_output" && !session.hasFeature("boot_output")) continue;
                    steps.push({ what: field, run: () => session.setSetting(field, parsed.settings[field]) });
                }
            }
            for (let l = 0; l < parsed.layers.length; l++) {
                for (let k = 0; k < parsed.layers[l].length; k++) {
                    const key = parsed.layers[l][k];
                    steps.push({ what: `layer ${l} key ${k}`, run: () => session.setKey(l, k, key.code, key.label) });
                }
            }
            for (let i = 0; i < steps.length; i++) {
                onProgress(i, steps.length, steps[i].what);
                try {
                    await steps[i].run();
                    result.applied.push(steps[i].what);
                } catch (err) {
                    result.failed.push({ what: steps[i].what, error: err.message });
                    if (!session.isConnected) break;
                }
            }
            // Fresh readback: only what the device reports now counts
            const cfg = await session.refreshConfig();
            const check = (what, expected, actual) => {
                const same = typeof expected === "number" ? C.sameMm(expected, actual) : expected === actual;
                if (!same) result.mismatched.push({ what, expected, actual });
            };
            if (parsed.settings) {
                for (const field of ["actuation", "rt_sens", "rt_enabled", "active_layer"]) {
                    if (parsed.settings[field] !== undefined) check(field, parsed.settings[field], cfg[field]);
                }
                if (parsed.settings.boot_output !== undefined && session.hasFeature("boot_output")) {
                    check("boot_output", parsed.settings.boot_output, cfg.boot_output);
                }
            }
            for (let l = 0; l < parsed.layers.length; l++) {
                for (let k = 0; k < parsed.layers[l].length; k++) {
                    const want = parsed.layers[l][k];
                    const got = cfg.layers[l][k];
                    if (want.code !== got.code || want.label !== got.label) {
                        result.mismatched.push({ what: `layer ${l} key ${k}`, expected: want, actual: got });
                    }
                }
            }
            onProgress(steps.length, steps.length, "done");
            return result;
        });
    }

    DP.backup = Object.freeze({ FORMAT, FORMAT_VERSION, create, parse, restore });
})(typeof window !== "undefined" ? window : globalThis);
