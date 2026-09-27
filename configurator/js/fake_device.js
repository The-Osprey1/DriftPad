/*
 * fake_device.js - an in-browser DriftPad speaking serial protocol v2 (docs/protocol-v2-draft.md),
 * plus a fake Web Serial port (ReadableStream / WritableStream based) and a navigator.serial
 * stand-in.
 *
 * Used by the configurator tests (configurator/tests/), by the old-page defect reproductions and by
 * the simulated device mode (index.html?simulate=1). It is written independently of the configurator
 * modules (its own framing, parsers, label rule and code table), so a bug in protocol.js or
 * contract.js is not mirrored here. tests/test_configurator_contract.py sends the same request
 * lines to the real firmware (whole image on the host) and to this fake and compares the replies'
 * keys, value types, status and error codes.
 *
 * Modes
 *   "v2"        protocol 2. `features`: the list INFO reports; default FEATURES (what the current
 *               firmware lists). Pass a shorter list to exercise the configurator's feature gating.
 *   "v1"        legacy firmware (commit e2031e2): text commands, no ids, no "cmd", saves on every SET.
 *   "foreign"   a serial gadget that is not a DriftPad: answers every line with plain text.
 *   "other"     answers INFO in protocol-2 shape, but as another device ("device":"MacroMaster").
 *   "v3"        a DriftPad that speaks a newer protocol (3).
 *   "silent"    never answers.
 *
 * Fault injection: `device.faults` (per verb: delay, drop, stray lines, wrong id, missing id,
 * forced errors; label rewriting; save failures; unplug on a verb; calibration failures) and
 * `port.faults` (write rejection, close errors, open errors, chunk splitting).
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};

    const FW_VERSION = "2.1.0-beta.1";
    const HW = "DriftPad V2 (RP2040)";
    const NUM_KEYS = 16;
    const NUM_LAYERS = 3;
    const LINE_MAX = 160;
    const ACT = { min: 25, max: 380, def: 120 };
    const RT = { min: 10, max: 200, def: 20 };
    const UI_STEP = 5;
    const STREAM_HZ_DEFAULT = 30;
    const STREAM_HZ_MAX = 60;
    const SIM_MAX_CMM = 400;
    const RAW_LEN = 1000;
    const RAW_CHUNK = 100;
    const REST_PHASE_MS = 500;
    const CAL_TRAVEL_MIN_CMM = 300;
    // INFO.features of the current firmware (firmware/src/commands.cpp, cmdInfo).
    const FEATURES = ["keymap", "layers", "rapid_trigger", "telemetry", "timing", "raw", "sim", "display",
                      "guided_calibration", "boot_output", "settings_ab"];
    const TIMING_OPS = ["command", "telemetry", "save", "calibration", "publish", "display_request", "tx_drain"];
    const GAP_LIMITS_US = [1100, 1500, 2000, 5000, 10000, 50000];

    const DEFAULT_ROWS = [
        [[0xB1, "ESC"], [55, "7"], [56, "8"], [57, "9"], [0xF0, "M1"], [52, "4"], [53, "5"], [54, "6"],
         [0xF1, "M2"], [49, "1"], [50, "2"], [51, "3"], [0xF2, "M3"], [0xF3, "M4"], [48, "0"], [0xB0, "ENT"]],
        [[0xB1, "ESC"], [0xD2, "HOME"], [0xDA, "UP"], [0xD3, "PGUP"], [0xB3, "TAB"], [0xD8, "LEFT"], [0xD9, "DOWN"], [0xD7, "RGHT"],
         [0xD1, "INS"], [0xD5, "END"], [0xD9, "DOWN"], [0xD6, "PGDN"], [0xB2, "BSPC"], [0xD4, "DEL"], [32, "SPCE"], [0xB0, "ENT"]],
        [[0xB1, "ESC"], [49, "1"], [50, "2"], [51, "3"], [0xB3, "TAB"], [113, "Q"], [119, "W"], [101, "E"],
         [0x81, "SHFT"], [97, "A"], [115, "S"], [100, "D"], [0x80, "CTRL"], [114, "R"], [32, "SPCE"], [102, "F"]],
    ];

    // --------------------------------------------------------------------------- JSON output
    // Firmware JSON: fixed key order, millimetres with exactly 2 decimals ("1.20").
    class Fixed {
        constructor(scaled, decimals) { this.scaled = scaled; this.decimals = decimals; }
    }
    const mm = cmm => new Fixed(cmm, 2);

    function toJson(v) {
        if (v instanceof Fixed) {
            const neg = v.scaled < 0;
            const mag = Math.abs(v.scaled);
            const p = Math.pow(10, v.decimals);
            const frac = String(mag % p).padStart(v.decimals, "0");
            return (neg ? "-" : "") + Math.floor(mag / p) + (v.decimals ? "." + frac : "");
        }
        if (v === null || v === undefined) return "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "number") return String(Math.trunc(v));
        if (typeof v === "string") return JSON.stringify(v);
        if (Array.isArray(v)) return "[" + v.map(toJson).join(",") + "]";
        return "{" + Object.keys(v).map(k => JSON.stringify(k) + ":" + toJson(v[k])).join(",") + "}";
    }

    // --------------------------------------------------------------------------- parsers (firmware rules)
    const isDigit = c => c >= "0" && c <= "9";
    const upper = s => s.replace(/[a-z]/g, c => c.toUpperCase());
    const keywordIs = (text, kw) => upper(text) === upper(kw);

    function parseUint(text, min, max) {
        if (!text) return { err: "bad_number" };
        let value = 0;
        let overflow = false;
        for (const ch of text) {
            if (!isDigit(ch)) return { err: "bad_number" };
            value = value * 10 + (ch.charCodeAt(0) - 48);
            if (value > 0xFFFFFFFF) overflow = true;
        }
        if (overflow || value < min || value > max) return { err: "out_of_range" };
        return { value };
    }

    function parseCmm(text, min, max) {
        if (!text || !isDigit(text[0])) return { err: "bad_number" };
        let i = 0;
        let whole = 0;
        let overflow = false;
        while (i < text.length && isDigit(text[i])) {
            if (whole > 42949671) overflow = true;
            else whole = whole * 10 + (text.charCodeAt(i) - 48);
            i++;
        }
        let frac = 0;
        if (text[i] === ".") {
            i++;
            if (!isDigit(text[i] || "")) return { err: "bad_number" };
            frac = (text.charCodeAt(i) - 48) * 10;
            i++;
            if (isDigit(text[i] || "")) { frac += text.charCodeAt(i) - 48; i++; }
            if (isDigit(text[i] || "")) return { err: "bad_number" };
        }
        if (i !== text.length) return { err: "bad_number" };
        if (overflow) return { err: "out_of_range" };
        const cmm = whole * 100 + frac;
        if (cmm < min || cmm > max) return { err: "out_of_range" };
        return { value: cmm };
    }

    function parseBool(text) {
        if (!text) return { err: "bad_number" };
        if (text === "1" || keywordIs(text, "on") || keywordIs(text, "true")) return { value: true };
        if (text === "0" || keywordIs(text, "off") || keywordIs(text, "false")) return { value: false };
        for (const ch of text) if (!isDigit(ch)) return { err: "bad_number" };
        return { err: "out_of_range" };
    }

    // Label rule, written independently of contract.js: a-z uppercased, 1..4 bytes, each 0x21..0x7E
    // except '"', '\' and '@'. `text` holds one character per received byte.
    function fwLabel(text) {
        if (typeof text !== "string" || text.length < 1 || text.length > 4) return null;
        let out = "";
        for (let i = 0; i < text.length; i++) {
            let c = text.charCodeAt(i);
            if (c >= 0x61 && c <= 0x7A) c -= 0x20;
            if (c < 0x21 || c > 0x7E || c === 0x22 || c === 0x5C || c === 0x40) return null;
            out += String.fromCharCode(c);
        }
        return out;
    }

    // keycodeIsAssignable(): 0 = None; ASCII through the en_US layout (unmapped: 1-7, 11-31, 127);
    // modifiers 128-135; usages from code 140 (136-139 are usages 0-3, not keys).
    function fwCodeOk(code) {
        if (code === 0) return true;
        if (code < 128) return code === 8 || code === 9 || code === 10 || (code >= 32 && code <= 126);
        if (code <= 135) return true;
        return code >= 140 && code <= 255;
    }

    const isIdChar = c => /[A-Za-z0-9_-]/.test(c);
    const validId = id => id.length >= 1 && id.length <= 12 && [...id].every(isIdChar);

    // --------------------------------------------------------------------------- command table
    // [verb, aliases, minArgs, maxArgs, feature]
    const TABLE = [
        ["PING", [], 0, 0], ["INFO", ["HELLO"], 0, 0], ["GET_CONFIG", [], 0, 0], ["STATUS", [], 0, 0],
        ["STREAM", [], 1, 2], ["SET_ACTUATION", [], 1, 1], ["SET_RT_SENS", [], 1, 1], ["SET_RT_ENABLE", [], 1, 1],
        ["SET_LAYER", [], 1, 1], ["SET_KEY", [], 3, 4], ["SET_HID", ["HID", "OUTPUT"], 1, 2], ["SAVE", [], 0, 0],
        ["REVERT", [], 0, 0], ["RESET", [], 0, 0], ["CALIBRATE", [], 0, 0], ["SIM", [], 1, 2], ["SCAN_RATE", [], 0, 0],
        ["TIMING", [], 0, 1], ["RAW", [], 1, 1], ["FULLSCREEN", [], 0, 1], ["SCREENSAVER", [], 0, 0], ["ANIM", [], 0, 1],
        ["SLEEP", [], 0, 0], ["WAKE", [], 0, 0], ["OLED_TEST", [], 0, 0], ["OLED_SCAN", [], 0, 0], ["BOOTSEL", [], 0, 0],
        ["SET_BOOT_OUTPUT", [], 1, 1, "boot_output"], ["CAL", [], 1, 1, "guided_calibration"],
    ];

    function maskList(mask) {
        const out = [];
        for (let i = 0; i < NUM_KEYS; i++) if (mask & (1 << i)) out.push(i);
        return out;
    }

    const clone = o => JSON.parse(JSON.stringify(o));

    class FakeDevice {
        /**
         * @param {object} [opts]
         * @param {string} [opts.mode]          v2 | v1 | foreign | other | v3 | silent
         * @param {string[]} [opts.features]  INFO.features (default FEATURES)
         * @param {boolean} [opts.saved]        flash already holds the current settings
         * @param {string} [opts.calibration]   valid | missing | invalid (with guided_calibration)
         * @param {boolean} [opts.autoCalibrate] simulated mode: the wizard's key presses happen by themselves
         * @param {boolean} [opts.bootOutput]
         */
        constructor(opts = {}) {
            this.mode = opts.mode || "v2";
            this.fw = opts.fw || FW_VERSION;
            this.build = opts.build || "unknown";
            this.buildDate = opts.buildDate || "unknown";
            if (opts.features !== undefined && !Array.isArray(opts.features)) throw new Error("features must be a list");
            this.features = (opts.features || FEATURES).slice();
            this.autoCalibrate = !!opts.autoCalibrate;
            this.t0 = Date.now();
            this.port = null;
            this.received = [];      // every request line (after framing), as text
            this.sent = [];          // every line emitted
            this.timers = new Set();
            this.intervals = new Set();
            this._rx = [];
            this._rxOverflow = false;
            this._rxInvalid = false;
            this._rxNonSpace = false;
            this.faults = {
                delayMs: {},          // VERB -> reply delay (ms)
                drop: {},             // VERB -> replies to swallow (Infinity: all)
                strayBefore: {},      // VERB -> [line | (id) => line] emitted just before the reply
                wrongId: {},          // VERB -> id to put in the reply instead of the request's
                noId: {},             // VERB -> true: reply without the id
                forceError: {},       // VERB -> error code returned instead of executing
                setKeyError: {},      // "layer:key" -> error code for SET_KEY on that key
                labelOverride: null,  // (label) => label actually stored and reported
                saveError: null,      // "flash_error" | "flash_verify_failed"
                unplugOn: null,       // VERB: the device disappears when this command arrives
                restFailKeys: [],     // CAL START: these keys move during the rest phase
            };
            this.state = this._factory();
            if (opts.bootOutput) this.state.bootOutput = true;
            const calState = opts.calibration || (this.has("guided_calibration") ? "valid" : "missing");
            this.calibration = { state: calState, keys_valid: calState === "valid" ? NUM_KEYS : 0 };
            this.flash = null;       // null: nothing saved yet (fresh flash)
            this.seq = 0;
            this.slot = null;
            this.source = "defaults";
            if (opts.saved) this._commit();
            this.output = { enabled: false, reason: "disabled_default" };
            if (this.has("guided_calibration")) {
                if (calState !== "valid") this.output = { enabled: false, reason: "calibration_" + calState };
                else if (this.state.bootOutput) this.output = { enabled: true, reason: "enabled" };
            }
            this.streaming = false;
            this.streamHz = STREAM_HZ_DEFAULT;
            this.frameSeq = 0;
            this.streamTimer = null;
            this.travelCmm = new Array(NUM_KEYS).fill(0);
            this.physicalCmm = new Array(NUM_KEYS).fill(0);
            this.simMask = 0;
            this.lastKey = -1;
            this.cal = null;
            this.fullscreen = false;
            this.timing = this._timingZero();
            this.v1Streaming = false;
        }

        has(feature) { return this.features.includes(feature); }

        _factory() {
            return {
                actuationCmm: ACT.def, rtSensCmm: RT.def, rtEnabled: true, activeLayer: 0, bootOutput: false,
                layers: DEFAULT_ROWS.map(l => l.map(([code, label]) => ({ code, label }))),
            };
        }

        // What the persistence backend stores (A/B slots store boot_output and calibration too).
        _stored(state, calibration) {
            const s = { a: state.actuationCmm, r: state.rtSensCmm, e: state.rtEnabled, l: state.activeLayer, k: state.layers };
            if (this.has("settings_ab")) { s.b = state.bootOutput; s.c = calibration; }
            return JSON.stringify(s);
        }

        get dirty() {
            return this.flash === null || this._stored(this.state, this.calibration) !== this.flash.stored;
        }

        _commit() {
            this.flash = { stored: this._stored(this.state, this.calibration), state: clone(this.state), calibration: clone(this.calibration) };
            this.seq++;
            if (this.has("settings_ab")) {
                this.slot = this.slot === "slot_a" ? "slot_b" : "slot_a";
                this.source = this.slot;
            } else {
                this.slot = null;
            }
        }

        _timingZero() { return { scans: 0, missed: 0, maxGapUs: 0, commands: 0, since: Date.now() }; }

        // ----------------------------------------------------------------------- wiring
        attach(port) { this.port = port; }

        // The host closed the port (or it vanished): nothing queued is for the next session.
        detach(port) {
            if (port && this.port !== port) return;
            this.port = null;
            this._stopStream();
            this.v1Streaming = false;
            this._rx = [];
            this._rxOverflow = this._rxInvalid = this._rxNonSpace = false;
        }

        destroy() {
            this._stopStream();
            for (const t of this.timers) clearTimeout(t);
            for (const t of this.intervals) clearInterval(t);
            this.timers.clear();
            this.intervals.clear();
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

        _emit(obj) { this.emitRaw(toJson(obj)); }

        // Commands received so far (verb only, upper case, without the id).
        verbs() {
            return this.received.map(l => {
                const t = l.trim().split(/ +/);
                if (t[0] && t[0].startsWith("@")) t.shift();
                return (t[0] || "").toUpperCase();
            });
        }

        // ----------------------------------------------------------------------- framing (bytes)
        receiveBytes(bytes) {
            for (const b of bytes) this._feed(b);
        }

        // Text convenience for tests: every UTF-16 unit below 256 is one byte, others are UTF-8.
        receive(text) {
            this.receiveBytes(new TextEncoder().encode(text));
        }

        _feed(b) {
            if (b === 0x0A || b === 0x0D) {
                const bytes = this._rx;
                const overflow = this._rxOverflow;
                const invalid = this._rxInvalid;
                const nonSpace = this._rxNonSpace;
                this._rx = [];
                this._rxOverflow = this._rxInvalid = this._rxNonSpace = false;
                const text = String.fromCharCode(...bytes);
                if (overflow) { this.received.push(text); this._reject("line_too_long", text); return; }
                if (invalid) { this.received.push(text); this._reject("bad_request", text); return; }
                if (nonSpace) { this.received.push(text); this._line(text); }
                return;
            }
            if (b < 0x20 || b === 0x7F) { this._rxInvalid = true; this._rxNonSpace = true; }
            else if (b !== 0x20) this._rxNonSpace = true;
            if (this._rx.length < LINE_MAX) this._rx.push(b);
            else this._rxOverflow = true;
        }

        _reject(code, text) {
            if (this.mode !== "v2" && this.mode !== "v3" && this.mode !== "other") {
                if (this.mode === "v1") this._lineV1(text);
                return;
            }
            let id = null;
            const m = /^ *@([^ ]*)/.exec(text);
            if (m && validId(m[1])) id = m[1];
            const out = { status: "error" };
            if (id !== null) out.id = id;
            out.cmd = "";
            if (code === "line_too_long") Object.assign(out, { code, msg: "line longer than the maximum; discarded", max: LINE_MAX });
            else Object.assign(out, { code, msg: "control character in line; discarded" });
            this._emit(out);
        }

        _line(text) {
            switch (this.mode) {
                case "silent": return;
                case "foreign": this._later(2, () => this.emitRaw("ERR? unknown input")); return;
                case "v1": this._lineV1(text); return;
                default: this._lineV2(text);
            }
        }

        // ----------------------------------------------------------------------- protocol v2
        _lineV2(text) {
            const tokens = text.split(" ").filter(t => t.length);
            let id = null;
            const reply = { id: null, cmd: "" };
            if (tokens[0].startsWith("@")) {
                const cand = tokens.shift().slice(1);
                if (!validId(cand)) return this._send(reply, { error: "bad_request", msg: "request id must be 1-12 of A-Z a-z 0-9 _ -" }, null);
                id = cand;
                reply.id = id;
                if (!tokens.length) return this._send(reply, { error: "bad_request", msg: "missing command" }, null);
            }
            const word = tokens.shift();
            const def = TABLE.find(([verb, aliases, , , feature]) =>
                (!feature || this.has(feature)) && (keywordIs(word, verb) || aliases.some(a => keywordIs(word, a))));
            if (!def) return this._send(reply, { error: "unknown_command", msg: "unknown command" }, null);
            const verb = def[0];
            reply.cmd = verb;
            const args = tokens;
            let [, , minArgs, maxArgs] = def;
            if (verb === "RESET" && this.has("guided_calibration")) maxArgs = 1;
            const f = this.faults;
            if (f.unplugOn === verb) {
                f.unplugOn = null;
                if (this.port) this.port.unplug();
                return;
            }
            if (f.drop[verb]) { f.drop[verb]--; return; }
            if (args.length < minArgs || args.length > maxArgs) {
                return this._send(reply, { error: "bad_arguments", msg: "wrong number of arguments", extra: { min_args: minArgs, max_args: maxArgs } }, verb);
            }
            this.timing.commands++;
            if (f.forceError[verb]) return this._send(reply, { error: f.forceError[verb], msg: "injected failure" }, verb);
            let result;
            try {
                result = this._exec(verb, args);
            } catch (e) {
                result = { error: "unsupported", msg: String(e && e.message || e) };
            }
            this._send(reply, result, verb);
        }

        _send(reply, result, verb) {
            const out = { status: result.error ? "error" : "ok" };
            const f = this.faults;
            let id = reply.id;
            if (verb && f.wrongId[verb] !== undefined) id = f.wrongId[verb];
            if (verb && f.noId[verb]) id = null;
            if (id !== null) out.id = id;
            out.cmd = reply.cmd;
            if (result.error) {
                out.code = result.error;
                out.msg = result.msg || "";
                Object.assign(out, result.extra || {});
            } else {
                Object.assign(out, result.fields);
            }
            const stray = verb ? f.strayBefore[verb] : null;
            const delay = verb ? f.delayMs[verb] || 0 : 0;
            const emit = () => {
                if (stray) stray.forEach(s => this.emitRaw(typeof s === "function" ? s(reply.id) : s));
                this._emit(out);
                if (result.after) result.after();
            };
            if (delay) this._later(delay, emit);
            else emit();
        }

        _applied(fields) {
            return { fields: Object.assign(fields, { applied: true, persisted: !this.dirty, dirty: this.dirty }) };
        }

        _calBusy() { return !!this.cal && (this.cal.phase === "rest" || this.cal.phase === "travel"); }

        _exec(verb, a) {
            const s = this.state;
            let p;
            switch (verb) {
                case "PING":
                    return { fields: { type: "pong" } };
                case "INFO":
                    return { fields: this._info() };
                case "GET_CONFIG":
                    return { fields: this._config() };
                case "STATUS":
                    return { fields: this._status() };
                case "STREAM": {
                    const on = parseBool(a[0]);
                    if (on.err) return { error: on.err, msg: "STREAM takes 0 or 1" };
                    let hz = STREAM_HZ_DEFAULT;
                    if (a.length > 1) {
                        p = parseUint(a[1], 1, STREAM_HZ_MAX);
                        if (p.err) {
                            return { error: p.err, msg: "rate must be 1 to the maximum stream rate",
                                     extra: p.err === "out_of_range" ? { min: 1, max: STREAM_HZ_MAX } : {} };
                        }
                        hz = p.value;
                    }
                    this.streamHz = hz;
                    if (on.value) this._startStream(); else this._stopStream();
                    return { fields: { streaming: this.streaming, hz: this.streamHz } };
                }
                case "SET_ACTUATION":
                case "SET_RT_SENS": {
                    const lim = verb === "SET_ACTUATION" ? ACT : RT;
                    p = parseCmm(a[0], lim.min, lim.max);
                    if (p.err) {
                        const what = verb === "SET_ACTUATION" ? "actuation" : "RT sensitivity";
                        return { error: p.err, msg: `${what} must be a distance in mm with at most 2 decimals, within the limits`,
                                 extra: p.err === "out_of_range" ? { min: mm(lim.min), max: mm(lim.max) } : {} };
                    }
                    if (verb === "SET_ACTUATION") { s.actuationCmm = p.value; return this._applied({ actuation: mm(s.actuationCmm) }); }
                    s.rtSensCmm = p.value;
                    return this._applied({ rt_sens: mm(s.rtSensCmm) });
                }
                case "SET_RT_ENABLE":
                    p = parseBool(a[0]);
                    if (p.err) return { error: p.err, msg: "SET_RT_ENABLE takes 0 or 1" };
                    s.rtEnabled = p.value;
                    return this._applied({ rt_enabled: s.rtEnabled });
                case "SET_LAYER":
                    p = parseUint(a[0], 0, NUM_LAYERS - 1);
                    if (p.err) return { error: p.err, msg: "layer must be 0, 1 or 2" };
                    s.activeLayer = p.value;
                    return this._applied({ active_layer: s.activeLayer });
                case "SET_KEY": {
                    const l = parseUint(a[0], 0, NUM_LAYERS - 1);
                    if (l.err) return { error: l.err, msg: "layer must be 0, 1 or 2" };
                    const k = parseUint(a[1], 0, NUM_KEYS - 1);
                    if (k.err) return { error: k.err, msg: "key must be 0 to 15" };
                    const c = parseUint(a[2], 0, 255);
                    if (c.err) return { error: c.err, msg: "code must be 0 to 255" };
                    const injected = this.faults.setKeyError[`${l.value}:${k.value}`];
                    if (injected) return { error: injected, msg: "injected failure" };
                    if (!fwCodeOk(c.value)) return { error: "invalid_code", msg: "code produces no keyboard output" };
                    let label = s.layers[l.value][k.value].label;
                    if (a.length > 3) {
                        label = fwLabel(a[3]);
                        if (label === null) return { error: "invalid_label", msg: "label must be 1-4 printable ASCII characters, not \" \\ or @" };
                        if (this.faults.labelOverride) label = this.faults.labelOverride(label);
                    }
                    s.layers[l.value][k.value] = { code: c.value, label };
                    const lk = s.layers[l.value][k.value];
                    return this._applied({ layer: l.value, key: k.value, code: lk.code, label: lk.label });
                }
                case "SET_BOOT_OUTPUT":
                    p = parseBool(a[0]);
                    if (p.err) return { error: p.err, msg: "SET_BOOT_OUTPUT takes 0 or 1" };
                    s.bootOutput = p.value;
                    return this._applied({ boot_output: s.bootOutput });
                case "SET_HID": {
                    p = parseBool(a[0]);
                    if (p.err) return { error: p.err, msg: "SET_HID takes 0 or 1" };
                    const force = a.length > 1;
                    if (force && !keywordIs(a[1], "force")) return { error: "bad_request", msg: "the only option is FORCE" };
                    if (this.has("guided_calibration")) {
                        if (this._calBusy()) return { error: "busy", msg: "calibration is running" };
                        if (!p.value) this.output = { enabled: false, reason: "user_disabled" };
                        else if (this.calibration.state === "valid") this.output = { enabled: true, reason: "enabled" };
                        else if (force) this.output = { enabled: true, reason: "forced" };
                        else return { error: "calibration_required", msg: "calibrate the pad first (or use FORCE)", extra: { calibration: this.calibration.state } };
                    } else {
                        this.output = p.value ? { enabled: true, reason: "enabled" } : { enabled: false, reason: "user_disabled" };
                    }
                    return { fields: { hid_output: this.output.enabled, output: this._outputObj() } };
                }
                case "SAVE": {
                    if (this._calBusy()) return { error: "busy", msg: "calibration is running" };
                    if (this.faults.saveError) {
                        return { error: this.faults.saveError, msg: "settings were not saved; the previous flash contents are unchanged or lost (see docs)",
                                 extra: { persisted: false, dirty: this.dirty } };
                    }
                    this._commit();
                    const fields = { persisted: true, dirty: this.dirty, duration_ms: 12 };
                    if (this.has("settings_ab")) Object.assign(fields, { slot: this.slot, seq: this.seq });
                    return { fields };
                }
                case "REVERT": {
                    if (this._calBusy()) return { error: "busy", msg: "calibration is running" };
                    if (!this.flash) return { error: "not_allowed", msg: "no saved settings to revert to" };
                    this.state = clone(this.flash.state);
                    if (this.has("settings_ab")) this.calibration = clone(this.flash.calibration);
                    return { fields: { applied: true, persisted: !this.dirty, dirty: this.dirty } };
                }
                case "RESET": {
                    let all = false;
                    if (a.length) {
                        if (!keywordIs(a[0], "all")) return { error: "bad_request", msg: "use RESET or RESET ALL" };
                        all = true;
                    }
                    if (this._calBusy()) return { error: "busy", msg: "calibration is running" };
                    this.state = this._factory();
                    if (all) {
                        this.calibration = { state: "missing", keys_valid: 0 };
                        this.output = { enabled: false, reason: "calibration_missing" };
                    }
                    return { fields: { all, applied: true, persisted: !this.dirty, dirty: this.dirty } };
                }
                case "CALIBRATE": {
                    // Quick rest re-zero: refused while a key is off rest; the state is unchanged here
                    if (this._calBusy()) return { error: "busy", msg: "guided calibration is running" };
                    const moving = [];
                    for (let i = 0; i < NUM_KEYS; i++) if (this.physicalCmm[i] > 20) moving.push(i);
                    if (moving.length) return { error: "keys_not_at_rest", msg: "release every key and try again", extra: { keys: moving } };
                    return { fields: { applied: true, persisted: !this.dirty, dirty: this.dirty, calibration: this.calibration.state } };
                }
                case "CAL":
                    return this._cal(a[0]);
                case "SIM": {
                    if (a.length === 1) {
                        if (!keywordIs(a[0], "off")) return { error: "bad_request", msg: "use SIM <key> <mm>, SIM <key> OFF or SIM OFF" };
                        this.simMask = 0;
                        this._recompute();
                        return { fields: { sim_mask: this.simMask } };
                    }
                    const k = parseUint(a[0], 0, NUM_KEYS - 1);
                    if (k.err) return { error: k.err, msg: "key must be 0 to 15" };
                    if (keywordIs(a[1], "off")) {
                        this.simMask &= ~(1 << k.value);
                        this._recompute();
                        return { fields: { key: k.value, sim_mask: this.simMask } };
                    }
                    p = parseCmm(a[1], 0, SIM_MAX_CMM);
                    if (p.err) {
                        return { error: p.err, msg: "travel must be 0.00 to 4.00 mm",
                                 extra: p.err === "out_of_range" ? { min: mm(0), max: mm(SIM_MAX_CMM) } : {} };
                    }
                    this.simMask |= 1 << k.value;
                    this.simCmm = this.simCmm || new Array(NUM_KEYS).fill(0);
                    this.simCmm[k.value] = p.value;
                    this._recompute();
                    return { fields: { type: "sim_event", key: k.value, travel: mm(this.travelCmm[k.value]),
                                       pressed: this._pressed(k.value), sim_mask: this.simMask } };
                }
                case "SCAN_RATE":
                    return { fields: { type: "scan_rate", hz: 1000, max_gap_us: 1000 } };
                case "TIMING":
                    if (a.length === 1) {
                        if (!keywordIs(a[0], "reset")) return { error: "bad_request", msg: "use TIMING or TIMING RESET" };
                        this.timing = this._timingZero();
                        return { fields: { reset: true } };
                    }
                    return { fields: this._timingFields() };
                case "RAW": {
                    const k = parseUint(a[0], 0, NUM_KEYS - 1);
                    if (k.err) return { error: k.err, msg: "key must be 0 to 15" };
                    return { fields: { key: k.value, samples: RAW_LEN, rate_hz: 1000 }, after: () => this._rawChunks(k.value) };
                }
                case "FULLSCREEN":
                    if (a.length === 0) this.fullscreen = !this.fullscreen;
                    else {
                        p = parseBool(a[0]);
                        if (p.err) return { error: p.err, msg: "FULLSCREEN takes 0 or 1" };
                        this.fullscreen = p.value;
                    }
                    return { fields: { fullscreen: this.fullscreen } };
                case "SCREENSAVER":
                    return { fields: { screensaver: true } };
                case "ANIM": {
                    let idx = -1;
                    if (a.length === 1) {
                        p = parseUint(a[0], 0, 5);
                        if (p.err) return { error: p.err, msg: "animation must be 0 to 5 (omit it to cycle)" };
                        idx = p.value;
                    }
                    return { fields: { anim: idx } };
                }
                case "SLEEP":
                    return { fields: { sleep: true } };
                case "WAKE":
                    return { fields: { wake: true } };
                case "OLED_TEST":
                    return { fields: { display: "test_pattern" } };
                case "OLED_SCAN":
                    return { fields: { devices: [60] } };
                case "BOOTSEL":
                    this.output = { enabled: false, reason: "user_disabled" };
                    return { fields: { bootsel: true }, after: () => this._later(5, () => { if (this.port) this.port.unplug(); }) };
                default:
                    return { error: "unknown_command", msg: "unknown command" };
            }
        }

        _info() {
            if (this.mode === "other") return { type: "info", device: "MacroMaster", protocol: 2, fw: "9.9.9" };
            const cal = { state: this._calState() };
            if (this.has("guided_calibration")) {
                Object.assign(cal, { keys_valid: this.calibration.keys_valid, held_at_boot: [], drift: [], faults: [] });
            }
            return {
                type: "info", device: "DriftPad", hw: HW, fw: this.fw, protocol: this.mode === "v3" ? 3 : 2,
                build: this.build, build_date: this.buildDate, features: this.features.slice(),
                limits: {
                    actuation: { min: mm(ACT.min), max: mm(ACT.max), default: mm(ACT.def), step: mm(UI_STEP) },
                    rt_sens: { min: mm(RT.min), max: mm(RT.max), default: mm(RT.def), step: mm(UI_STEP) },
                    layers: NUM_LAYERS, keys: NUM_KEYS, label_max: 4, label_chars: "printable ASCII except \" \\ @",
                    code_max: 255, line_max: LINE_MAX, stream_hz_max: STREAM_HZ_MAX,
                },
                calibration: cal,
                output: this._outputObj(),
                settings: { dirty: this.dirty, source: this.source, seq: this.flash ? this.seq : 0, load_errors: [] },
                uptime_ms: Date.now() - this.t0,
            };
        }

        _calState() { return this._calBusy() ? "in_progress" : this.calibration.state; }

        _config() {
            const s = this.state;
            return {
                type: "config", actuation: mm(s.actuationCmm), rt_sens: mm(s.rtSensCmm), rt_enabled: s.rtEnabled,
                active_layer: s.activeLayer, boot_output: s.bootOutput, dirty: this.dirty, settings_seq: this.flash ? this.seq : 0,
                layers: s.layers.map(l => l.map((k, i) => ({ idx: i, code: k.code, label: k.label }))),
            };
        }

        _outputObj() {
            let active = 0;
            if (this.output.enabled) for (let i = 0; i < NUM_KEYS; i++) if (this._pressed(i) && !(this.simMask & (1 << i))) active |= 1 << i;
            return {
                enabled: this.output.enabled, reason: this.output.reason, active_keys: maskList(active),
                suppressed_keys: [], overflow: 0, delivery: "confirmed",
            };
        }

        _status() {
            const labels = this.state.layers[this.state.activeLayer];
            return {
                type: "status", active_layer: this.state.activeLayer, last_key: this.lastKey,
                keys: this.travelCmm.map((t, i) => ({ idx: i, pressed: this._pressed(i), travel: mm(t), label: labels[i].label })),
                output: this._outputObj(),
                ...(this.has("guided_calibration") ? { calibration: { state: this._calState() } } : {}),
                sim_mask: this.simMask, dirty: this.dirty,
            };
        }

        _timingFields() {
            const up = Date.now() - this.t0;
            const scans = Math.max(0, Date.now() - this.timing.since);
            const out = { type: "timing", uptime_ms: up, period_us: 1000, scans, scan_hz: 1000, max_gap_us: 1000, missed_deadlines: 0 };
            const hist = {};
            GAP_LIMITS_US.forEach((lim, i) => { hist["le_" + lim] = i === 0 ? scans : 0; });
            hist["gt_" + GAP_LIMITS_US[GAP_LIMITS_US.length - 1]] = 0;
            out.gap_hist_us = hist;
            out.scan_max_us = 212;
            out.scan_avg_us = new Fixed(1403, 1);
            for (const op of TIMING_OPS) {
                out[op + "_last_us"] = 0;
                out[op + "_max_us"] = 0;
                out[op + "_count"] = op === "command" ? this.timing.commands : 0;
            }
            Object.assign(out, { tx_queue_bytes: 2048, tx_used: 0, tx_high_water: 0, tx_bytes_queued: 0, tx_bytes_sent: 0,
                                 tx_events_dropped: 0, tx_replies_rejected: 0, telemetry_dropped: 0 });
            return out;
        }

        // ----------------------------------------------------------------------- keys
        _pressed(k) { return this.travelCmm[k] >= this.state.actuationCmm; }

        _recompute() {
            for (let k = 0; k < NUM_KEYS; k++) {
                const simulated = this.simMask & (1 << k);
                const t = simulated ? (this.simCmm ? this.simCmm[k] : 0) : this.physicalCmm[k];
                const was = this._pressed(k);
                this.travelCmm[k] = t;
                if (!was && this._pressed(k)) this.lastKey = k;
            }
        }

        // A physical key press (tests, simulated mode, calibration).
        pressKey(k, mmValue = 4.0) {
            this.physicalCmm[k] = Math.round(mmValue * 100);
            this._recompute();
            if (this.cal) {
                if (this.cal.phase === "rest" && this.physicalCmm[k] > 20) this.cal.moved.add(k);
                if (this.cal.phase === "travel") this.cal.peak[k] = Math.max(this.cal.peak[k], this.physicalCmm[k]);
            }
        }

        releaseKey(k) {
            this.physicalCmm[k] = 0;
            this._recompute();
            const c = this.cal;
            if (c && c.phase === "travel" && c.peak[k] >= CAL_TRAVEL_MIN_CMM && !c.travelDone.has(k)) {
                c.travelDone.add(k);
                this._calEvent();
            }
        }

        // A change made on the device itself (the knob menu), not through the protocol.
        externalEdit(fn) {
            fn(this.state);
        }

        // ----------------------------------------------------------------------- telemetry
        _startStream() {
            this.streaming = true;
            if (this.streamTimer) { clearInterval(this.streamTimer); this.intervals.delete(this.streamTimer); }
            this.streamTimer = setInterval(() => this._telemetry(), Math.round(1000 / this.streamHz));
            this.intervals.add(this.streamTimer);
        }

        _stopStream() {
            this.streaming = false;
            if (this.streamTimer) { clearInterval(this.streamTimer); this.intervals.delete(this.streamTimer); }
            this.streamTimer = null;
        }

        _telemetry() {
            if (!this.port) return;
            let pressed = 0;
            for (let i = 0; i < NUM_KEYS; i++) if (this._pressed(i)) pressed |= 1 << i;
            let active = 0;
            if (this.output.enabled) active = pressed & ~this.simMask;
            this._emit({
                type: "telemetry", seq: this.frameSeq++, t: Date.now() - this.t0, layer: this.state.activeLayer,
                pressed, active, sim: this.simMask, travel: this.travelCmm.slice(), dirty: this.dirty,
            });
        }

        _rawChunks(k) {
            const samples = [];
            for (let i = 0; i < RAW_LEN; i++) samples.push(2048 + ((i * 7 + k * 13) % 9) - 4);
            for (let off = 0; off < RAW_LEN; off += RAW_CHUNK) {
                const o = off;
                this._later(2 + off / RAW_CHUNK, () => this._emit({
                    type: "raw", key: k, rate_hz: 1000, offset: o, total: RAW_LEN, samples: samples.slice(o, o + RAW_CHUNK),
                }));
            }
        }

        // ----------------------------------------------------------------------- calibration
        _calFields(phase) {
            const c = this.cal;
            const sorted = set => [...set].sort((x, y) => x - y);
            return {
                type: "cal", phase, rest_ok: c ? sorted(c.restOk) : [], rest_failed: c ? sorted(c.restFailed) : [],
                travel_done: c ? sorted(c.travelDone) : [], elapsed_ms: c ? Date.now() - c.startedAt : 0,
            };
        }

        _calEvent() {
            if (this.cal) this._emit(this._calFields(this.cal.phase));
        }

        _cal(sub) {
            const c = this.cal;
            if (keywordIs(sub, "start")) {
                if (this._calBusy()) return { error: "busy", msg: "calibration is already running" };
                const moving = [];
                for (let i = 0; i < NUM_KEYS; i++) if (this.physicalCmm[i] > 20) moving.push(i);
                if (moving.length) return { error: "keys_not_at_rest", msg: "take your hands off the pad", extra: { keys: moving } };
                const cal = this.cal = {
                    phase: "rest", restOk: new Set(), restFailed: new Set(), travelDone: new Set(), moved: new Set(),
                    peak: new Array(NUM_KEYS).fill(0), startedAt: Date.now(), prevOutput: Object.assign({}, this.output),
                    prevCalibration: clone(this.calibration),
                };
                this.output = { enabled: false, reason: "calibration_in_progress" };
                this._later(REST_PHASE_MS, () => {
                    if (this.cal !== cal || cal.phase !== "rest") return;
                    const failed = new Set([...(this.faults.restFailKeys || []), ...cal.moved]);
                    for (let i = 0; i < NUM_KEYS; i++) (failed.has(i) ? cal.restFailed : cal.restOk).add(i);
                    if (failed.size) {
                        cal.phase = "failed";
                        this.output = cal.prevOutput;
                        this._calEvent();
                        return;
                    }
                    cal.phase = "travel";
                    this._calEvent();
                    if (this.autoCalibrate) this._autoPress(cal, 0);
                });
                return { fields: { phase: "rest", rest_ms: REST_PHASE_MS } };
            }
            if (keywordIs(sub, "status")) {
                return { fields: this._calFields(c ? c.phase : "idle") };
            }
            if (keywordIs(sub, "finish")) {
                if (!this._calBusy()) {
                    return { error: "not_allowed", msg: "no calibration is running; start one with CAL START", extra: { phase: c ? c.phase : "idle" } };
                }
                const missing = [];
                for (let i = 0; i < NUM_KEYS; i++) if (!c.travelDone.has(i)) missing.push(i);
                if (c.phase !== "travel" || missing.length) {
                    return { error: "calibration_incomplete", msg: "every key must be pressed to the bottom and released once", extra: { missing, phase: c.phase } };
                }
                c.phase = "done";
                this.calibration = { state: "valid", keys_valid: NUM_KEYS };
                this.output = c.prevOutput.enabled || c.prevOutput.reason === "forced" ? { enabled: true, reason: "enabled" } : { enabled: false, reason: "disabled_default" };
                this._calEvent();
                const done = this._applied({ calibration: { state: "valid" } });
                done.fields.output = this._outputObj();
                return done;
            }
            if (keywordIs(sub, "cancel")) {
                if (this._calBusy()) {
                    c.phase = "cancelled";
                    this.calibration = c.prevCalibration;
                    this.output = c.prevOutput;
                    this._calEvent();
                }
                return { fields: { phase: "cancelled", output: this._outputObj() } };
            }
            return { error: "bad_request", msg: "use CAL START, CAL STATUS, CAL FINISH or CAL CANCEL" };
        }

        _autoPress(cal, k) {
            if (this.cal !== cal || cal.phase !== "travel" || k >= NUM_KEYS) return;
            this._later(90, () => {
                if (this.cal !== cal || cal.phase !== "travel") return;
                this.pressKey(k, 3.9);
                this._later(60, () => {
                    this.releaseKey(k);
                    this._autoPress(cal, k + 1);
                });
            });
        }

        // ----------------------------------------------------------------------- legacy v1 (e2031e2)
        // Mirrors processCommand() of firmware/src/main.cpp at e2031e2: case-sensitive prefixes,
        // String::toFloat()/toInt() parsing, sscanf("%d %d %d %7s") for SET_KEY, every SET_* saved.
        _lineV1(raw) {
            const line = raw.trim();
            if (!line) return;
            const eq = w => line.toUpperCase() === w;
            const toFloat = t => { const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)/.exec(t); return m ? parseFloat(m[0]) : 0; };
            const toInt = t => { const m = /^\s*[-+]?\d+/.exec(t); return m ? parseInt(m[0], 10) : 0; };
            const ok = msg => this.emitRaw(JSON.stringify({ status: "ok", msg }));
            const err = msg => this.emitRaw(JSON.stringify({ status: "error", msg }));
            const s = this.state;
            const f = this.faults;
            const verb = line.split(" ")[0].toUpperCase();
            if (f.unplugOn === verb) { f.unplugOn = null; if (this.port) this.port.unplug(); return; }
            if (f.drop[verb]) { f.drop[verb]--; return; }
            const reply = () => {
                if (f.forceError[verb]) return err(f.forceError[verb]);
                if (eq("PING")) return this.emitRaw('{"type":"pong"}');
                if (eq("GET_CONFIG")) {
                    return this.emitRaw(toJson({
                        type: "config", actuation: mm(s.actuationCmm), rt_sens: mm(s.rtSensCmm), rt_enabled: s.rtEnabled,
                        active_layer: s.activeLayer, layers: s.layers.map(l => l.map((k, i) => ({ idx: i, code: k.code, label: k.label }))),
                    }));
                }
                if (eq("STATUS")) return this.emitRaw(this._v1Status());
                if (line.startsWith("SET_ACTUATION ")) {
                    const v = toFloat(line.slice(14));
                    if (v >= 0.1 && v <= 3.8) { s.actuationCmm = Math.round(v * 100); this._commit(); return ok(`Actuation set to ${v.toFixed(2)} mm`); }
                    return err("Invalid actuation (0.1 - 3.8mm)");
                }
                if (line.startsWith("SET_RT_SENS ")) {
                    const v = toFloat(line.slice(12));
                    if (v >= 0.1 && v <= 2.0) { s.rtSensCmm = Math.round(v * 100); this._commit(); return ok(`RT sensitivity set to ${v.toFixed(2)} mm`); }
                    return err("Invalid RT sensitivity (0.10 - 2.0mm)");
                }
                if (line.startsWith("SET_RT_ENABLE ")) {
                    s.rtEnabled = toInt(line.slice(14)) !== 0;
                    this._commit();
                    return ok(`Rapid Trigger ${s.rtEnabled ? "ENABLED" : "DISABLED"}`);
                }
                if (line.startsWith("SET_LAYER ")) {
                    const l = toInt(line.slice(10));
                    if (l >= 0 && l < NUM_LAYERS) { s.activeLayer = l; this._commit(); return ok(`Active layer set to ${l}`); }
                    return err("Invalid layer index");
                }
                if (line.startsWith("SET_KEY ")) {
                    const m = /^SET_KEY\s+([-+]?\d+)\s+([-+]?\d+)\s+([-+]?\d+)(?:\s+(\S{1,7}))?/.exec(line);
                    if (!m) return undefined;   // sscanf matched fewer than 3 fields: no reply at all
                    const [l, k, c] = [m[1], m[2], m[3]].map(Number);
                    if (l >= 0 && l < NUM_LAYERS && k >= 0 && k < NUM_KEYS && c >= 0 && c <= 255) {
                        s.layers[l][k].code = c;
                        if (m[4]) s.layers[l][k].label = m[4].slice(0, 4).replace(/[^0-9A-Za-z_-]/g, "_");
                        this._commit();
                        return ok(`Key L${l}:K${k} updated`);
                    }
                    return err("Invalid key update arguments");
                }
                if (line.startsWith("SIM ")) {
                    const parts = line.slice(4).split(" ");
                    if (parts.length < 2) return undefined;
                    const k = toInt(parts[0]);
                    if (k < 0 || k >= NUM_KEYS) return undefined;
                    const t = toFloat(parts.slice(1).join(" "));
                    this.simMask |= 1 << k;
                    this.simCmm = this.simCmm || new Array(NUM_KEYS).fill(0);
                    this.simCmm[k] = Math.round(t * 100);
                    this._recompute();
                    return this.emitRaw(`{"type":"sim_event","key":${k},"travel":${(this.travelCmm[k] / 100).toFixed(2)},"pressed":${this._pressed(k)}}`);
                }
                if (eq("SCAN_RATE")) return this.emitRaw('{"type":"scan_rate","hz":1000,"max_gap_us":1000}');
                if (line.startsWith("STREAM ")) {
                    this.v1Streaming = toInt(line.slice(7)) !== 0;
                    this._v1Stream();
                    return this.emitRaw(`{"status":"ok","streaming":${this.v1Streaming}}`);
                }
                if (eq("SAVE")) { this._commit(); return ok("Settings saved to Flash"); }
                if (eq("RESET")) { this.state = this._factory(); this._commit(); return ok("Factory reset complete"); }
                if (line.startsWith("FULLSCREEN")) { this.fullscreen = !this.fullscreen; return this.emitRaw(`{"status":"ok","fullscreen":${this.fullscreen}}`); }
                if (eq("SCREENSAVER")) return this.emitRaw('{"status":"ok","screensaver":true}');
                if (eq("SLEEP")) return this.emitRaw('{"status":"ok","sleep":true}');
                if (eq("WAKE")) return this.emitRaw('{"status":"ok","wake":true}');
                if (line.startsWith("ANIM")) { const t = line.slice(4).trim(); return this.emitRaw(`{"status":"ok","anim":${t ? toInt(t) : -1}}`); }
                if (eq("BOOTSEL")) { this.emitRaw('{"status":"ok","bootsel":true}'); this._later(5, () => { if (this.port) this.port.unplug(); }); return undefined; }
                if (line.startsWith("SET_HID ") || line.startsWith("HID ")) {
                    this.output.enabled = toInt(line.slice(line.indexOf(" ") + 1)) !== 0;
                    return this.emitRaw(`{"status":"ok","hid_output":${this.output.enabled}}`);
                }
                return err("Unknown command");
            };
            const stray = f.strayBefore[verb];
            const run = () => {
                if (stray) stray.forEach(x => this.emitRaw(typeof x === "function" ? x(null) : x));
                reply();
            };
            if (f.delayMs[verb]) this._later(f.delayMs[verb], run);
            else run();
        }

        _v1Status() {
            const labels = this.state.layers[this.state.activeLayer];
            const keys = this.travelCmm.map((t, i) =>
                `{"idx":${i},"pressed":${this._pressed(i)},"travel":${(t / 100).toFixed(2)},"label":${JSON.stringify(labels[i].label)}}`);
            return `{"type":"status","active_layer":${this.state.activeLayer},"last_key":${this.lastKey},"keys":[${keys.join(",")}]}`;
        }

        _v1Stream() {
            if (this._v1Timer) { clearInterval(this._v1Timer); this.intervals.delete(this._v1Timer); this._v1Timer = null; }
            if (!this.v1Streaming) return;
            this._v1Timer = setInterval(() => { if (this.port && this.v1Streaming) this.emitRaw(this._v1Status()); }, 33);
            this.intervals.add(this._v1Timer);
        }

        // v1 firmware printed a banner when it came up.
        bootBanner() {
            if (this.mode === "v1") this.emitRaw("[SYSTEM] DriftPad Firmware v2.0 Online.");
        }
    }

    // --------------------------------------------------------------------------- fake SerialPort
    // Behaves like Chrome's SerialPort where it matters to the transport: open() creates
    // readable/writable byte streams, close() refuses while either stream is locked (as Chrome
    // does), unplug() errors the readable (NetworkError), makes writes fail and fires "disconnect".
    class FakeSerialPort {
        constructor(device, opts = {}) {
            this.device = device || null;
            this.faults = {
                rejectWrites: false,      // true, or a number of writes to reject
                closeError: null,         // an Error thrown by the next close()
                openError: null,          // an Error thrown by the next open()
                chunkSize: opts.chunkSize || 0,   // split device output into chunks of N bytes
                writeDelayMs: 0,          // each write takes this long
            };
            this.events = [];              // "open", "readable-cancel", "writable-close", "writable-abort", "close", ...
            this.readable = null;
            this.writable = null;
            this.isOpen = false;
            this.unplugged = false;
            this.opens = 0;
            this.written = "";
            this._listeners = new Set();
            this._controller = null;
            this._encoder = new TextEncoder();
        }

        getInfo() { return { usbVendorId: 0x2E8A, usbProductId: 0x000A }; }

        addEventListener(type, fn) { if (type === "disconnect") this._listeners.add(fn); }
        removeEventListener(type, fn) { if (type === "disconnect") this._listeners.delete(fn); }

        async open(opts) {
            if (this.faults.openError) { const e = this.faults.openError; this.faults.openError = null; throw e; }
            if (this.unplugged) throw new DOMException("The device has been lost.", "NetworkError");
            if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
            this.events.push("open");
            this.opens++;
            this.baudRate = opts && opts.baudRate;
            this.isOpen = true;
            const self = this;
            this.readable = new ReadableStream({
                start(controller) { self._controller = controller; },
                cancel() { self.events.push("readable-cancel"); self._controller = null; },
            });
            this.writable = new WritableStream({
                async write(chunk) {
                    if (self.faults.writeDelayMs) await new Promise(r => setTimeout(r, self.faults.writeDelayMs));
                    if (self.unplugged) throw new DOMException("The device has been lost.", "NetworkError");
                    const rw = self.faults.rejectWrites;
                    if (rw === true || (typeof rw === "number" && rw > 0)) {
                        if (typeof rw === "number") self.faults.rejectWrites = rw - 1;
                        self.events.push("write-rejected");
                        throw new DOMException("The write was rejected by the fake port.", "NetworkError");
                    }
                    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    self.written += String.fromCharCode(...bytes);
                    if (self.device) self.device.receiveBytes(bytes);
                },
                close() { self.events.push("writable-close"); },
                abort() { self.events.push("writable-abort"); },
            });
            if (this.device) {
                this.device.attach(this);
                if (this.device.bootBanner) this.device.bootBanner();
            }
        }

        _deliver(text) {
            if (!this._controller) return;
            const bytes = this._encoder.encode(text);
            const n = this.faults.chunkSize > 0 ? this.faults.chunkSize : bytes.length;
            for (let i = 0; i < bytes.length; i += n) {
                try { this._controller.enqueue(bytes.slice(i, i + n)); } catch (e) { return; }
            }
        }

        // Unrelated bytes on the line (e.g. a line from another program or a partial line).
        inject(text) { this._deliver(text); }

        async close() {
            this.events.push("close");
            if (this.faults.closeError) {
                const err = this.faults.closeError;
                this.faults.closeError = null;
                this.events.push("close-error");
                throw err;
            }
            if ((this.readable && this.readable.locked) || (this.writable && this.writable.locked)) {
                this.events.push("close-rejected-locked");
                throw new TypeError("Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream");
            }
            if (!this.isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
            this.isOpen = false;
            if (this.device) this.device.detach(this);
            this._controller = null;
            this.readable = null;
            this.writable = null;
            this.events.push("closed");
        }

        // The USB device disappears (unplugged, rebooted into the bootloader).
        unplug() {
            if (this.unplugged) return;
            this.unplugged = true;
            this.events.push("unplug");
            if (this.device) this.device.detach(this);
            if (this._controller) {
                try { this._controller.error(new DOMException("The device has been lost.", "NetworkError")); } catch (e) { /* closed */ }
                this._controller = null;
            }
            for (const fn of [...this._listeners]) fn({ type: "disconnect", target: this });
        }

        // Plugged back in: a new session can open it again.
        replug() {
            this.unplugged = false;
            this.isOpen = false;
            this.readable = null;
            this.writable = null;
        }
    }

    // navigator.serial stand-in: requestPort() hands out the given port (or rejects like Chrome does
    // when the user closes the chooser).
    class FakeSerial {
        constructor(port) { this.port = port; this.requests = 0; this.cancelChooser = false; }
        async requestPort() {
            this.requests++;
            if (this.cancelChooser || !this.port) throw new DOMException("No port selected by the user.", "NotFoundError");
            return this.port;
        }
        async getPorts() { return this.port ? [this.port] : []; }
        addEventListener() {}
        removeEventListener() {}
    }

    // One-call setup: a device, a port and a navigator.serial stand-in.
    function createSimulation(opts = {}) {
        const device = new FakeDevice(opts);
        const port = new FakeSerialPort(device, opts);
        const serial = new FakeSerial(port);
        return { device, port, serial };
    }

    DP.fake = Object.freeze({
        FakeDevice, FakeSerialPort, FakeSerial, createSimulation, fwLabel, fwCodeOk, toJson,
        FEATURES,
    });
})(typeof window !== "undefined" ? window : globalThis);
