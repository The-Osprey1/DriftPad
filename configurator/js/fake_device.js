/*
 * fake_device.js - an in-browser DriftPad speaking serial protocol v2, plus a fake SerialPort.
 *
 * Used by the configurator tests (configurator/tests/) and by the simulated device mode
 * (index.html?simulate=1). It follows the contract (section 2) independently of the configurator
 * modules: its own line framing, id parsing, argument checks, label rule and code table, so a bug in
 * protocol.js or contract.js is not mirrored here.
 *
 * Modes: "v2" (default), "v1" (legacy firmware replies, no ids), "foreign" (answers INFO as some
 * other device), "v3" (a DriftPad with a newer protocol), "silent" (never answers), "chatter"
 * (prints unrelated text).
 *
 * Fault injection lives in `device.faults` (see the constructor) and `port.faults`.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};

    const FW_VERSION = "2.1.0-beta.1";
    const NUM_KEYS = 16;
    const LINE_MAX = 160;
    const ACT = { min: 25, max: 380, def: 120 };
    const RT = { min: 10, max: 200, def: 20 };
    const REST_PHASE_MS = 500;

    const DEFAULT_ROWS = [
        [[0xB1, "ESC"], [55, "7"], [56, "8"], [57, "9"], [0xF0, "M1"], [52, "4"], [53, "5"], [54, "6"],
         [0xF1, "M2"], [49, "1"], [50, "2"], [51, "3"], [0xF2, "M3"], [0xF3, "M4"], [48, "0"], [0xB0, "ENT"]],
        [[0xB1, "ESC"], [0xD2, "HOME"], [0xDA, "UP"], [0xD3, "PGUP"], [0xB3, "TAB"], [0xD8, "LEFT"], [0xD9, "DOWN"], [0xD7, "RGHT"],
         [0xD1, "INS"], [0xD5, "END"], [0xD9, "DOWN"], [0xD6, "PGDN"], [0xB2, "BSPC"], [0xD4, "DEL"], [32, "SPCE"], [0xB0, "ENT"]],
        [[0xB1, "ESC"], [49, "1"], [50, "2"], [51, "3"], [0xB3, "TAB"], [113, "Q"], [119, "W"], [101, "E"],
         [0x81, "SHFT"], [97, "A"], [115, "S"], [100, "D"], [0x80, "CTRL"], [114, "R"], [32, "SPCE"], [102, "F"]],
    ];

    // Firmware-side label rule, written independently of contract.js.
    function fwLabel(s) {
        const up = String(s).replace(/[a-z]/g, c => c.toUpperCase());
        return /^[!#-?A-[\]-~]{1,4}$/.test(up) ? up : null;
    }

    // Firmware-side code check (KeyboardLayout_en_US unmapped entries, usage 0).
    function fwCodeOk(code) {
        if (code === 0) return true;
        if (code < 128) return code === 8 || code === 9 || code === 10 || (code >= 32 && code <= 126);
        return code !== 136 && code <= 255;
    }

    const MM = "\u0000MM";
    function mm(cmm) { return MM + (cmm / 100).toFixed(2); }
    function toJson(obj) {
        return JSON.stringify(obj).replace(/"\\u0000MM([0-9.]+)"/g, "$1");
    }

    function parseMmArg(s) {
        if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
        return Math.round(Number(s) * 100);
    }

    function parseIntArg(s) {
        return /^\d{1,3}$/.test(s) ? Number(s) : null;
    }

    function maskToList(mask) {
        const out = [];
        for (let i = 0; i < NUM_KEYS; i++) if (mask & (1 << i)) out.push(i);
        return out;
    }

    class FakeDevice {
        constructor(opts = {}) {
            this.mode = opts.mode || "v2";
            this.fw = opts.fw || FW_VERSION;
            this.build = opts.build || "0123456789ab-dirty";
            this.autoCalibrate = !!opts.autoCalibrate;   // simulated mode: keys "pressed" automatically
            this.t0 = Date.now();
            this.port = null;
            this.received = [];      // every complete line received (after framing)
            this.sent = [];          // every line emitted
            this.timers = new Set();
            this.rx = "";
            this.rxLastCR = false;
            this.rxDiscard = false;
            this.faults = {
                delayMs: {},          // VERB -> reply delay in ms
                drop: {},             // VERB -> number of replies to swallow (Infinity: all)
                strayLines: {},       // VERB -> raw lines emitted just before the real reply
                labelOverride: null,  // (label) -> label actually stored and reported
                corruptKey: null,     // {layer,key}: stored code differs from the reply (read-back mismatch)
                saveError: null,      // "flash_error" | "flash_verify_failed"
                savePersistedFalse: false,
                unplugOn: null,       // VERB: the device disappears when this command arrives
                restFailKeys: [],     // CAL START rest phase fails for these keys
            };
            this.state = this._factory();
            this.calibration = { state: opts.calibration || "valid", keys_valid: opts.calibration === "missing" ? 0 : 16 };
            this.flash = this._snapshot();
            this.seq = 12;
            this.slot = "slot_a";
            const valid = this.calibration.state === "valid";
            this.output = this.state.bootOutput && valid
                ? { enabled: true, reason: "enabled" }
                : { enabled: false, reason: valid ? "disabled_default" : "calibration_" + this.calibration.state };
            this.streaming = false;
            this.streamHz = 30;
            this.streamTimer = null;
            this.telemetryFrames = 0;
            this.travelCmm = new Array(NUM_KEYS).fill(0);
            this.simMask = 0;
            this.cal = null;
            this.fullscreen = false;
            this.timing = this._timingZero();
        }

        _factory() {
            return {
                actuationCmm: ACT.def,
                rtSensCmm: RT.def,
                rtEnabled: true,
                activeLayer: 0,
                bootOutput: false,
                layers: DEFAULT_ROWS.map(l => l.map(([code, label]) => ({ code, label }))),
            };
        }

        _snapshot() {
            return JSON.parse(JSON.stringify({ state: this.state, calibration: this.calibration }));
        }

        get dirty() {
            return JSON.stringify({ state: this.state, calibration: this.calibration }) !== JSON.stringify(this.flash);
        }

        _timingZero() {
            return { scans: 0, missed: 0, max_gap_us: 0 };
        }

        // ----------------------------------------------------------------------- wiring
        attach(port) { this.port = port; }
        detach(port) {
            if (!port || this.port === port) this.port = null;
            this._stopStream();
        }

        destroy() {
            this._stopStream();
            for (const t of this.timers) clearTimeout(t);
            this.timers.clear();
            this.port = null;
        }

        _later(ms, fn) {
            const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
            this.timers.add(t);
            return t;
        }

        emitRaw(line) {
            this.sent.push(line);
            if (this.port) this.port._deliver(line + "\r\n");
        }

        // ----------------------------------------------------------------------- framing
        receive(text) {
            for (const ch of text) {
                if (ch === "\n" || ch === "\r") {
                    const skip = ch === "\n" && this.rxLastCR && this.rx === "" && !this.rxDiscard;
                    this.rxLastCR = ch === "\r";
                    if (skip) continue;
                    const line = this.rx;
                    const discarded = this.rxDiscard;
                    this.rx = "";
                    this.rxDiscard = false;
                    if (discarded) {
                        this.received.push("<line too long>");
                        this._send({ status: "error", cmd: "", code: "line_too_long", msg: `line longer than ${LINE_MAX} bytes discarded` });
                    } else if (line.length) {
                        this.received.push(line);
                        this._line(line);
                    }
                    continue;
                }
                this.rxLastCR = false;
                if (this.rxDiscard) continue;
                this.rx += ch;
                if (this.rx.length > LINE_MAX) {
                    this.rx = "";
                    this.rxDiscard = true;
                }
            }
        }

        // Verbs received so far, without ids and arguments.
        verbs() {
            return this.received.map(l => l.replace(/^@\S+\s+/, "").split(/\s+/)[0].toUpperCase());
        }

        _line(line) {
            switch (this.mode) {
                case "silent": return;
                case "chatter": this._later(1, () => this.emitRaw("Hello from a serial gadget")); return;
                case "v1": this._lineV1(line); return;
                default: this._lineV2(line);
            }
        }

        _send(obj, delay) {
            const text = toJson(obj);
            if (delay) this._later(delay, () => this.emitRaw(text));
            else this.emitRaw(text);
        }

        // ----------------------------------------------------------------------- legacy v1
        _lineV1(raw) {
            const line = raw.trim();
            const up = line.toUpperCase();
            if (up === "PING") return this.emitRaw('{"type":"pong"}');
            if (up === "GET_CONFIG") {
                const s = this.state;
                return this.emitRaw(toJson({
                    type: "config", actuation: mm(s.actuationCmm), rt_sens: mm(s.rtSensCmm), rt_enabled: s.rtEnabled,
                    active_layer: s.activeLayer,
                    layers: s.layers.map(l => l.map((k, i) => ({ idx: i, code: k.code, label: k.label }))),
                }));
            }
            if (up.startsWith("STREAM ")) return this.emitRaw(`{"status":"ok","streaming":${line.slice(7).trim() !== "0"}}`);
            if (up.startsWith("SET_")) return this.emitRaw('{"status":"ok","msg":"ok"}');
            this.emitRaw('{"status":"error","msg":"Unknown command"}');
        }

        // ----------------------------------------------------------------------- protocol v2
        _lineV2(line) {
            const tokens = line.trim().split(/ +/);
            let id = null;
            if (tokens[0].startsWith("@")) {
                id = tokens.shift().slice(1);
                if (!/^[A-Za-z0-9_-]{1,12}$/.test(id)) {
                    this._send({ status: "error", cmd: "", code: "bad_request", msg: "bad request id" });
                    return;
                }
                if (!tokens.length) {
                    this._send({ status: "error", id, cmd: "", code: "bad_request", msg: "missing command" });
                    return;
                }
            }
            let verb = tokens.shift().toUpperCase();
            if (verb === "HELLO") verb = "INFO";
            if (verb === "HID" || verb === "OUTPUT") verb = "SET_HID";
            const args = tokens;
            const f = this.faults;

            if (f.unplugOn === verb) {
                f.unplugOn = null;
                if (this.port) this.port.unplug();
                return;
            }
            if (f.drop[verb]) {
                f.drop[verb]--;
                return;
            }

            let reply;
            try {
                reply = this._exec(verb, args);
            } catch (e) {
                reply = { error: "bad_request", msg: String(e.message || e) };
            }
            if (reply === null) return;   // deferred / no reply (never used for accepted lines)
            const out = { status: reply.error ? "error" : "ok" };
            if (id !== null) out.id = id;
            out.cmd = reply.cmd || verb;
            if (reply.error) {
                out.code = reply.error;
                out.msg = reply.msg || reply.error;
                Object.assign(out, reply.extra || {});
            } else {
                Object.assign(out, reply);
                delete out.after;
            }
            const stray = f.strayLines[verb];
            const delay = f.delayMs[verb] || 0;
            const emit = () => {
                if (stray) stray.forEach(s => this.emitRaw(typeof s === "function" ? s(id) : s));
                this._send(out);
                if (reply.after) reply.after();
            };
            if (delay) this._later(delay, emit);
            else emit();
        }

        _argCount(args, min, max) {
            if (args.length < min || args.length > max) {
                return { error: "bad_arguments", msg: `expected ${min === max ? min : min + ".." + max} arguments` };
            }
            return null;
        }

        _applied(extra) {
            return Object.assign(extra, { applied: true, persisted: false, dirty: this.dirty });
        }

        _calBusy() {
            return this.cal && (this.cal.phase === "rest" || this.cal.phase === "travel");
        }

        _exec(verb, args) {
            const s = this.state;
            let bad;
            switch (verb) {
                case "PING":
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    return { type: "pong" };
                case "INFO":
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    return this._info();
                case "GET_CONFIG":
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    return this._config();
                case "STATUS":
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    return this._status();
                case "STREAM": {
                    if ((bad = this._argCount(args, 1, 2))) return bad;
                    if (args[0] !== "0" && args[0] !== "1") return { error: "bad_number", msg: "0 or 1" };
                    let hz = this.streamHz;
                    if (args.length === 2) {
                        hz = parseIntArg(args[1]);
                        if (hz === null) return { error: "bad_number" };
                        if (hz < 1 || hz > 60) return { error: "out_of_range", msg: "1..60 Hz" };
                    }
                    this.streamHz = hz;
                    if (args[0] === "1") this._startStream(); else this._stopStream();
                    return { streaming: this.streaming, hz: this.streamHz };
                }
                case "SET_ACTUATION":
                case "SET_RT_SENS": {
                    if ((bad = this._argCount(args, 1, 1))) return bad;
                    const cmm = parseMmArg(args[0]);
                    if (cmm === null) return { error: "bad_number", msg: "millimetres with at most 2 decimals" };
                    const lim = verb === "SET_ACTUATION" ? ACT : RT;
                    if (cmm < lim.min || cmm > lim.max) {
                        return { error: "out_of_range", msg: `${(lim.min / 100).toFixed(2)}..${(lim.max / 100).toFixed(2)} mm`,
                                 extra: { min: mm(lim.min), max: mm(lim.max) } };
                    }
                    if (verb === "SET_ACTUATION") { s.actuationCmm = cmm; return this._applied({ actuation: mm(cmm) }); }
                    s.rtSensCmm = cmm;
                    return this._applied({ rt_sens: mm(cmm) });
                }
                case "SET_RT_ENABLE":
                    if ((bad = this._argCount(args, 1, 1))) return bad;
                    if (args[0] !== "0" && args[0] !== "1") return { error: "bad_number" };
                    s.rtEnabled = args[0] === "1";
                    return this._applied({ rt_enabled: s.rtEnabled });
                case "SET_LAYER": {
                    if ((bad = this._argCount(args, 1, 1))) return bad;
                    const l = parseIntArg(args[0]);
                    if (l === null) return { error: "bad_number" };
                    if (l > 2) return { error: "out_of_range", msg: "layer 0..2" };
                    s.activeLayer = l;
                    return this._applied({ active_layer: l });
                }
                case "SET_KEY": {
                    if ((bad = this._argCount(args, 3, 4))) return bad;
                    const [l, k, code] = args.slice(0, 3).map(parseIntArg);
                    if (l === null || k === null || code === null) return { error: "bad_number" };
                    if (l > 2 || k > 15 || code > 255) return { error: "out_of_range" };
                    if (!fwCodeOk(code)) return { error: "invalid_code", msg: `code ${code} produces no key` };
                    let label = s.layers[l][k].label;
                    if (args.length === 4) {
                        label = fwLabel(args[3]);
                        if (label === null) return { error: "invalid_label" };
                        if (this.faults.labelOverride) label = this.faults.labelOverride(label);
                    }
                    const stored = { code, label };
                    const ck = this.faults.corruptKey;
                    if (ck && ck.layer === l && ck.key === k) stored.code = code === 4 ? 5 : 4;   // silently wrong
                    s.layers[l][k] = stored;
                    return this._applied({ layer: l, key: k, code, label });
                }
                case "SET_BOOT_OUTPUT":
                    if ((bad = this._argCount(args, 1, 1))) return bad;
                    if (args[0] !== "0" && args[0] !== "1") return { error: "bad_number" };
                    s.bootOutput = args[0] === "1";
                    return this._applied({ boot_output: s.bootOutput });
                case "SET_HID": {
                    if ((bad = this._argCount(args, 1, 2))) return bad;
                    if (args[0] !== "0" && args[0] !== "1") return { error: "bad_number" };
                    if (args.length === 2 && args[1].toUpperCase() !== "FORCE") return { error: "bad_request", msg: "expected FORCE" };
                    if (this._calBusy()) return { error: "busy", msg: "calibration running" };
                    if (args[0] === "0") {
                        this.output = { enabled: false, reason: "user_disabled" };
                    } else if (this.calibration.state === "valid") {
                        this.output = { enabled: true, reason: "enabled" };
                    } else if (args.length === 2) {
                        this.output = { enabled: true, reason: "forced" };
                    } else {
                        return { error: "calibration_required", msg: "calibrate first (or FORCE)" };
                    }
                    return { output: this._outputObj() };
                }
                case "SAVE": {
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    if (this._calBusy()) return { error: "busy" };
                    if (this.faults.saveError) return { error: this.faults.saveError, msg: "flash write failed", extra: { persisted: false, dirty: this.dirty } };
                    if (this.faults.savePersistedFalse) return { persisted: false, dirty: this.dirty, slot: this.slot, seq: this.seq, duration_ms: 3 };
                    this.slot = this.slot === "slot_a" ? "slot_b" : "slot_a";
                    this.seq++;
                    this.flash = this._snapshot();
                    return { persisted: true, dirty: false, slot: this.slot, seq: this.seq, duration_ms: 48 };
                }
                case "REVERT": {
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    if (this._calBusy()) return { error: "busy" };
                    const snap = JSON.parse(JSON.stringify(this.flash));
                    this.state = snap.state;
                    this.calibration = snap.calibration;
                    return { applied: true, persisted: true, dirty: this.dirty };
                }
                case "RESET": {
                    if ((bad = this._argCount(args, 0, 1))) return bad;
                    if (args.length && args[0].toUpperCase() !== "ALL") return { error: "bad_request", msg: "expected ALL" };
                    if (this._calBusy()) return { error: "busy" };
                    this.state = this._factory();
                    if (args.length) {
                        this.calibration = { state: "missing", keys_valid: 0 };
                        this.output = { enabled: false, reason: "calibration_missing" };
                    }
                    return { applied: true, persisted: false, dirty: this.dirty };
                }
                case "CALIBRATE":
                    if ((bad = this._argCount(args, 0, 0))) return bad;
                    if (this.travelCmm.some(t => t > 20)) return { error: "keys_not_at_rest", extra: { keys: maskToList(this._pressedMask()) } };
                    return this._applied({});
                case "CAL":
                    if ((bad = this._argCount(args, 1, 1))) return bad;
                    return this._cal(args[0].toUpperCase());
                case "SIM": {
                    if ((bad = this._argCount(args, 1, 2))) return bad;
                    if (args.length === 1) {
                        if (args[0].toUpperCase() !== "OFF") return { error: "bad_arguments" };
                        this.simMask = 0;
                        this.travelCmm.fill(0);
                        return { type: "sim_event", sim_mask: 0 };
                    }
                    const k = parseIntArg(args[0]);
                    if (k === null || k > 15) return { error: "out_of_range" };
                    if (args[1].toUpperCase() === "OFF") {
                        this.simMask &= ~(1 << k);
                        this.travelCmm[k] = 0;
                        return { type: "sim_event", key: k, travel: mm(0), pressed: false, sim_mask: this.simMask };
                    }
                    const cmm = parseMmArg(args[1]);
                    if (cmm === null) return { error: "bad_number" };
                    if (cmm > 400) return { error: "out_of_range" };
                    this.simMask |= 1 << k;
                    this.travelCmm[k] = cmm;
                    return { type: "sim_event", key: k, travel: mm(cmm), pressed: this._pressed(k), sim_mask: this.simMask };
                }
                case "SCAN_RATE":
                    return { type: "scan_rate", hz: 1000, max_gap_us: 1180 };
                case "TIMING": {
                    if ((bad = this._argCount(args, 0, 1))) return bad;
                    if (args.length) {
                        if (args[0].toUpperCase() !== "RESET") return { error: "bad_request" };
                        this.timing = this._timingZero();
                        return { type: "timing", reset: true };
                    }
                    const up = Date.now() - this.t0;
                    this.timing.scans = up;
                    return {
                        type: "timing", scans: up, scan_hz: 1000,
                        gap_hist: { "1.1": up, "1.5": 0, "2": 0, "5": 0, "10": 0, "50": 0, ">50": 0 },
                        max_gap_us: 1180, missed: 0, scan_us_max: 212, scan_us_avg: 140, tx_drops: 0, uptime_ms: up,
                    };
                }
                case "RAW": {
                    if ((bad = this._argCount(args, 1, 1))) return bad;
                    const k = parseIntArg(args[0]);
                    if (k === null || k > 15) return { error: "out_of_range" };
                    return { key: k, samples: 1000, after: () => this._rawChunks(k) };
                }
                case "FULLSCREEN":
                    if ((bad = this._argCount(args, 0, 1))) return bad;
                    this.fullscreen = args.length ? args[0] !== "0" : !this.fullscreen;
                    return { display: "queued", fullscreen: this.fullscreen };
                case "SCREENSAVER":
                    return { display: "queued", screensaver: true };
                case "ANIM": {
                    if ((bad = this._argCount(args, 0, 1))) return bad;
                    const n = args.length ? parseIntArg(args[0]) : -1;
                    if (n === null || n > 5) return { error: "out_of_range", msg: "0..5" };
                    return { display: "queued", anim: n };
                }
                case "SLEEP":
                    return { display: "queued", sleep: true };
                case "WAKE":
                    return { display: "queued", sleep: false };
                case "OLED_TEST":
                    return { display: "queued" };
                case "OLED_SCAN":
                    return { devices: [60] };
                case "BOOTSEL":
                    return { bootsel: true, after: () => this._later(20, () => { if (this.port) this.port.unplug(); }) };
                default:
                    return { error: "unknown_command", msg: `unknown command ${verb}` };
            }
        }

        _info() {
            if (this.mode === "foreign") {
                return { type: "info", device: "MacroMaster", protocol: 2, fw: "9.9" };
            }
            return {
                type: "info", device: "DriftPad", hw: "DriftPad V2 (RP2040)", fw: this.fw,
                protocol: this.mode === "v3" ? 3 : 2,
                build: this.build, build_date: "2026-09-20T10:00:00Z",
                features: ["keymap", "layers", "rapid_trigger", "guided_calibration", "settings_ab", "telemetry",
                           "timing", "raw", "sim", "display", "boot_output"],
                limits: {
                    actuation: { min: mm(ACT.min), max: mm(ACT.max), default: mm(ACT.def), step: mm(5) },
                    rt_sens: { min: mm(RT.min), max: mm(RT.max), default: mm(RT.def), step: mm(5) },
                    layers: 3, keys: 16, label_max: 4, label_chars: "printable ASCII except \" \\ @",
                    code_max: 255, line_max: 160, stream_hz_max: 60,
                },
                calibration: { state: this.calibration.state, keys_valid: this.calibration.keys_valid, held_at_boot: [], faults: [] },
                output: this._outputObj(),
                settings: { dirty: this.dirty, source: this.slot, seq: this.seq, load_errors: [] },
                uptime_ms: Date.now() - this.t0,
            };
        }

        _config() {
            const s = this.state;
            return {
                type: "config", actuation: mm(s.actuationCmm), rt_sens: mm(s.rtSensCmm), rt_enabled: s.rtEnabled,
                active_layer: s.activeLayer,
                layers: s.layers.map(l => l.map((k, i) => ({ idx: i, code: k.code, label: k.label }))),
                boot_output: s.bootOutput, dirty: this.dirty, settings_seq: this.seq,
            };
        }

        _outputObj() {
            return {
                enabled: this.output.enabled, reason: this.output.reason, standalone: this.state.bootOutput,
                active_keys: [], suppressed_keys: [], overflow: 0,
            };
        }

        _pressed(k) {
            return this.travelCmm[k] >= this.state.actuationCmm;
        }

        _pressedMask() {
            let m = 0;
            for (let i = 0; i < NUM_KEYS; i++) if (this._pressed(i)) m |= 1 << i;
            return m;
        }

        _keysArray() {
            const labels = this.state.layers[this.state.activeLayer];
            return this.travelCmm.map((t, i) => ({ idx: i, pressed: this._pressed(i), travel: mm(t), label: labels[i].label }));
        }

        _status() {
            return {
                type: "status", active_layer: this.state.activeLayer, last_key: 0, keys: this._keysArray(),
                output: this._outputObj(), calibration: { state: this.cal && this._calBusy() ? "in_progress" : this.calibration.state },
                sim_mask: this.simMask, dirty: this.dirty,
            };
        }

        // ----------------------------------------------------------------------- telemetry
        _startStream() {
            this.streaming = true;
            if (this.streamTimer) clearInterval(this.streamTimer);
            this.streamTimer = setInterval(() => this._telemetry(), Math.round(1000 / this.streamHz));
        }

        _stopStream() {
            this.streaming = false;
            if (this.streamTimer) clearInterval(this.streamTimer);
            this.streamTimer = null;
        }

        _telemetry() {
            if (!this.port) return;
            this.telemetryFrames++;
            this._send({
                type: "telemetry", seq: this.telemetryFrames, active_layer: this.state.activeLayer,
                keys: this._keysArray().map(k => ({ idx: k.idx, pressed: k.pressed, travel: k.travel })),
                sim_mask: this.simMask, dropped: 0,
            });
        }

        // Physical key simulation (tests and the simulated device mode).
        pressKey(k, mmValue = 4.0) {
            this.travelCmm[k] = Math.round(mmValue * 100);
            if (this.cal && this.cal.phase === "travel") this.cal.peak[k] = Math.max(this.cal.peak[k], this.travelCmm[k]);
        }

        releaseKey(k) {
            this.travelCmm[k] = 0;
            const c = this.cal;
            if (c && c.phase === "travel" && c.peak[k] >= 300 && !c.done.has(k)) {
                c.done.add(k);
                this._calEvent("travel");
            }
        }

        // ----------------------------------------------------------------------- calibration
        _calEvent(phase) {
            const c = this.cal;
            this._send({
                type: "cal", phase, keys_done: [...c.done].sort((a, b) => a - b),
                keys_failed: [...c.failed].sort((a, b) => a - b), elapsed_ms: Date.now() - c.startedAt,
            });
        }

        _cal(sub) {
            const c = this.cal;
            switch (sub) {
                case "START": {
                    if (this._calBusy()) return { error: "busy", msg: "calibration already running" };
                    this.cal = {
                        phase: "rest", done: new Set(), failed: new Set(), peak: new Array(NUM_KEYS).fill(0),
                        startedAt: Date.now(), prevOutput: Object.assign({}, this.output),
                    };
                    this.output = { enabled: false, reason: "calibration_in_progress" };
                    const cal = this.cal;
                    this._later(REST_PHASE_MS, () => {
                        if (this.cal !== cal || cal.phase !== "rest") return;
                        const fails = this.faults.restFailKeys || [];
                        if (fails.length) {
                            fails.forEach(k => cal.failed.add(k));
                            cal.phase = "failed";
                            this.output = cal.prevOutput;
                            this._calEvent("failed");
                            return;
                        }
                        cal.phase = "travel";
                        this._calEvent("travel");
                        if (this.autoCalibrate) this._autoPress(cal, 0);
                    });
                    return { phase: "rest", rest_ms: REST_PHASE_MS, output: this._outputObj() };
                }
                case "STATUS":
                    if (!c) return { phase: "idle", active: false, keys_done: [], keys_failed: [] };
                    return {
                        phase: c.phase, active: this._calBusy(), keys_done: [...c.done].sort((a, b) => a - b),
                        keys_failed: [...c.failed].sort((a, b) => a - b), elapsed_ms: Date.now() - c.startedAt,
                    };
                case "FINISH": {
                    if (!c || c.phase !== "travel") return { error: "not_allowed", msg: "no calibration in the travel phase" };
                    const missing = [];
                    for (let i = 0; i < NUM_KEYS; i++) if (!c.done.has(i)) missing.push(i);
                    if (missing.length) return { error: "calibration_incomplete", msg: `${missing.length} keys not done`, extra: { missing } };
                    c.phase = "done";
                    this.calibration = { state: "valid", keys_valid: 16 };
                    this.output = c.prevOutput.enabled ? { enabled: true, reason: "enabled" } : { enabled: false, reason: "disabled_default" };
                    this._calEvent("done");
                    return this._applied({ phase: "done", calibration: { state: "valid", keys_valid: 16 }, output: this._outputObj() });
                }
                case "CANCEL": {
                    if (!this._calBusy()) return { phase: "idle" };
                    c.phase = "cancelled";
                    this.output = c.prevOutput;
                    this._calEvent("cancelled");
                    return { phase: "cancelled", output: this._outputObj() };
                }
                default:
                    return { error: "bad_request", msg: "CAL START|STATUS|FINISH|CANCEL" };
            }
        }

        _autoPress(cal, k) {
            if (this.cal !== cal || cal.phase !== "travel" || k >= NUM_KEYS) return;
            this._later(120, () => {
                if (this.cal !== cal || cal.phase !== "travel") return;
                this.pressKey(k, 3.9);
                this._later(80, () => {
                    this.releaseKey(k);
                    this._autoPress(cal, k + 1);
                });
            });
        }

        _rawChunks(k) {
            const total = 1000;
            const samples = [];
            for (let i = 0; i < total; i++) samples.push(2048 + ((i * 7 + k * 13) % 9) - 4);
            for (let off = 0; off < total; off += 100) {
                const chunk = samples.slice(off, off + 100);
                const o = off;
                this._later(1 + off / 100, () => this._send({ type: "raw", key: k, rate_hz: 1000, offset: o, total, samples: chunk }));
            }
        }
    }

    // --------------------------------------------------------------------------- fake SerialPort
    // Behaves like Chrome's SerialPort where it matters to the transport: open() creates
    // readable/writable streams, close() refuses while either stream is locked, unplug() errors the
    // readable (NetworkError) and makes writes fail, and "disconnect" listeners are notified.
    class FakeSerialPort {
        constructor(device, opts = {}) {
            this.device = device;
            this.chunkSize = opts.chunkSize || 0;     // split device output into chunks of N characters
            this.faults = { rejectWrites: false, closeError: null };
            this.events = [];                          // "open", "readable-cancel", "writable-close", ...
            this.readable = null;
            this.writable = null;
            this.isOpen = false;
            this.unplugged = false;
            this._listeners = new Set();
            this._controller = null;
            this._encoder = new TextEncoder();
            this._decoder = new TextDecoder();
        }

        getInfo() { return { usbVendorId: 0x2E8A, usbProductId: 0x000A }; }

        addEventListener(type, fn) { if (type === "disconnect") this._listeners.add(fn); }
        removeEventListener(type, fn) { if (type === "disconnect") this._listeners.delete(fn); }

        async open(opts) {
            if (this.unplugged) throw new DOMException("The device has been lost.", "NetworkError");
            if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
            this.events.push("open");
            this.baudRate = opts && opts.baudRate;
            this.isOpen = true;
            const self = this;
            this.readable = new ReadableStream({
                start(controller) { self._controller = controller; },
                cancel(reason) { self.events.push("readable-cancel"); self._controller = null; },
            });
            this.writable = new WritableStream({
                write(chunk) {
                    if (self.unplugged) throw new DOMException("The device has been lost.", "NetworkError");
                    if (self.faults.rejectWrites) throw new Error("write rejected by the fake port");
                    const text = self._decoder.decode(chunk, { stream: true });
                    if (self.device) self.device.receive(text);
                },
                close() { self.events.push("writable-close"); },
                abort(reason) { self.events.push("writable-abort"); },
            });
            if (this.device) this.device.attach(this);
        }

        _deliver(text) {
            if (!this._controller) return;
            const bytes = this._encoder.encode(text);
            const n = this.chunkSize > 0 ? this.chunkSize : bytes.length;
            for (let i = 0; i < bytes.length; i += n) {
                try { this._controller.enqueue(bytes.slice(i, i + n)); } catch (e) { return; }
            }
        }

        async close() {
            this.events.push("close");
            if (this.faults.closeError) {
                const err = this.faults.closeError;
                this.faults.closeError = null;
                throw err;
            }
            if ((this.readable && this.readable.locked) || (this.writable && this.writable.locked)) {
                this.events.push("close-rejected-locked");
                throw new TypeError("Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream");
            }
            if (!this.isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
            this.isOpen = false;
            if (this.device) this.device.detach(this);
            this.readable = null;
            this.writable = null;
        }

        // The USB device disappears (unplugged, rebooted into the bootloader).
        unplug() {
            if (this.unplugged) return;
            this.unplugged = true;
            this.events.push("unplug");
            if (this.device) this.device.detach(this);
            if (this._controller) {
                try { this._controller.error(new DOMException("The device has been lost.", "NetworkError")); } catch (e) { /* already closed */ }
                this._controller = null;
            }
            for (const fn of [...this._listeners]) fn({ type: "disconnect", target: this });
        }

        // Plugged back in (a new session can open it again).
        replug() {
            this.unplugged = false;
            this.isOpen = false;
            this.readable = null;
            this.writable = null;
        }
    }

    // navigator.serial stand-in: requestPort() hands out the given port.
    class FakeSerial {
        constructor(port) { this.port = port; this.requests = 0; }
        async requestPort() { this.requests++; return this.port; }
        async getPorts() { return [this.port]; }
        addEventListener() {}
        removeEventListener() {}
    }

    DP.fake = Object.freeze({ FakeDevice, FakeSerialPort, FakeSerial, fwLabel, fwCodeOk });
})(typeof window !== "undefined" ? window : globalThis);
