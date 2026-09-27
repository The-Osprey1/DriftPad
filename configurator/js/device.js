/*
 * device.js - DeviceSession: connection state machine, identification, the confirmed device state
 * and every device operation.
 *
 * Truthfulness rules:
 *  - "connected" only after INFO says device "DriftPad" and protocol 2. Legacy firmware (id-less
 *    error to INFO, v1 pong to PING) and anything else are reported as such and never written to.
 *  - `confirmed` (settings + keymap) changes only from a correlated reply or a fresh GET_CONFIG.
 *    Local edits live elsewhere (draft.js) and are never copied into it.
 *  - Every operation ends in "succeeded" or "failed"; a failed write, a timeout or a lost
 *    connection always finalizes it.
 *  - Telemetry (STREAM 1) is requested only while someone asked for it, the page is visible and a
 *    DriftPad is connected; STREAM 0 is sent when that stops being true.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};
    const C = DP.contract;
    const { ProtocolClient, ProtocolError } = DP.protocol;

    const NUM_KEYS = C.NUM_KEYS;
    const LOG_MAX = 600;

    class Emitter {
        constructor() { this._handlers = new Map(); }
        on(type, fn) {
            if (!this._handlers.has(type)) this._handlers.set(type, new Set());
            this._handlers.get(type).add(fn);
            return () => this._handlers.get(type).delete(fn);
        }
        emit(type, detail) {
            const set = this._handlers.get(type);
            if (!set) return;
            for (const fn of [...set]) {
                try { fn(detail); } catch (err) { if (global.console) console.error(err); }
            }
        }
    }

    const CONN_TEXT = {
        idle: () => "No device",
        connecting: () => "Connecting…",
        identifying: () => "Identifying…",
        connected: s => `Connected: DriftPad fw ${s.info ? s.info.fw : "?"} (protocol ${s.info ? s.info.protocol : "?"})`,
        legacy: () => "Legacy firmware (protocol 1) - update required",
        not_driftpad: () => "Not a DriftPad",
        unsupported: s => `Unsupported DriftPad firmware (protocol ${s.unsupportedProtocol})`,
        disconnected: () => "Disconnected",
        lost: () => "Connection lost",
    };

    const isInt = v => Number.isInteger(v);
    const isNum = v => typeof v === "number" && Number.isFinite(v);
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    function validLimit(l) {
        return l && isNum(l.min) && isNum(l.max) && isNum(l.default) && isNum(l.step) &&
            l.min < l.max && l.default >= l.min && l.default <= l.max && l.step > 0;
    }

    // Returns the device's limits when they are usable, else null.
    function parseLimits(l) {
        if (!l || typeof l !== "object") return null;
        if (!validLimit(l.actuation) || !validLimit(l.rt_sens)) return null;
        if (l.layers !== 3 || l.keys !== NUM_KEYS) return null;
        return {
            actuation: Object.freeze({ ...l.actuation }),
            rt_sens: Object.freeze({ ...l.rt_sens }),
            layers: l.layers,
            keys: l.keys,
            label_max: isInt(l.label_max) ? l.label_max : C.FALLBACK_LIMITS.label_max,
            code_max: isInt(l.code_max) ? l.code_max : C.FALLBACK_LIMITS.code_max,
            line_max: isInt(l.line_max) ? l.line_max : C.FALLBACK_LIMITS.line_max,
            stream_hz_max: isInt(l.stream_hz_max) ? l.stream_hz_max : C.FALLBACK_LIMITS.stream_hz_max,
        };
    }

    // GET_CONFIG reply check; returns a problem string or null.
    function configProblem(r) {
        if (!isNum(r.actuation)) return "actuation missing";
        if (!isNum(r.rt_sens)) return "rt_sens missing";
        if (typeof r.rt_enabled !== "boolean") return "rt_enabled missing";
        if (!isInt(r.active_layer) || r.active_layer < 0 || r.active_layer > 2) return "active_layer invalid";
        if (!Array.isArray(r.layers) || r.layers.length !== 3) return "layers must be 3 x 16";
        for (let l = 0; l < 3; l++) {
            const layer = r.layers[l];
            if (!Array.isArray(layer) || layer.length !== NUM_KEYS) return `layer ${l} must have 16 keys`;
            for (let k = 0; k < NUM_KEYS; k++) {
                const key = layer[k];
                if (!key || !isInt(key.code) || key.code < 0 || key.code > 255) return `layers[${l}][${k}].code invalid`;
                if (typeof key.label !== "string") return `layers[${l}][${k}].label invalid`;
                if (has(key, "idx") && key.idx !== k) return `layers[${l}][${k}].idx is ${key.idx}`;
            }
        }
        return null;
    }

    function parseConfig(r) {
        return {
            actuation: r.actuation,
            rt_sens: r.rt_sens,
            rt_enabled: r.rt_enabled,
            active_layer: r.active_layer,
            boot_output: typeof r.boot_output === "boolean" ? r.boot_output : null,
            layers: r.layers.map(layer => layer.map(k => ({ code: k.code, label: k.label }))),
            dirty: typeof r.dirty === "boolean" ? r.dirty : null,
            settings_seq: isInt(r.settings_seq) ? r.settings_seq : null,
            readAt: Date.now(),
        };
    }

    // Telemetry frame (docs/protocol-v2-draft.md, STREAM; firmware sendTelemetry()):
    //   "pressed", "active", "sim": 16-bit masks; "travel": 16 integers in centi-millimetres.
    // Returns {pressed[16], sending[16], travel[16] in mm, simMask}, or null for anything else.
    function parseTelemetry(ev) {
        if (!isInt(ev.pressed) || !Array.isArray(ev.travel) || ev.travel.length !== NUM_KEYS) return null;
        const bit = (mask, i) => isInt(mask) && (mask & (1 << i)) !== 0;
        const pressed = [];
        const sending = [];
        const travel = [];
        for (let i = 0; i < NUM_KEYS; i++) {
            pressed.push(bit(ev.pressed, i));
            sending.push(bit(ev.active, i));
            travel.push(isInt(ev.travel[i]) ? ev.travel[i] / 100 : 0);
        }
        return { pressed, sending, travel, simMask: isInt(ev.sim) ? ev.sim : 0 };
    }

    class DeviceSession extends Emitter {
        /**
         * @param {object} o
         * @param {(handlers)=>SerialTransport} o.createTransport  handlers: {onText, onClose, log}
         * @param {object} [o.timeouts] {request, identify, legacyProbe, save}
         */
        constructor(o) {
            super();
            this.createTransport = o.createTransport;
            this.timeouts = Object.assign({ request: 2000, identify: 1500, legacyProbe: 1200, save: 4000, raw: 4000 }, o.timeouts || {});
            this.conn = { state: "idle", detail: "", since: Date.now() };
            this.transport = null;
            this.client = null;
            this.logLines = [];
            this.counters = { unmatched: 0, events: 0, telemetryFrames: 0, textLines: 0 };
            this.pageVisible = true;
            this.telemetry = { wanted: new Set(), target: false, active: false, hz: null, error: null, pressed: new Array(NUM_KEYS).fill(false), sending: new Array(NUM_KEYS).fill(false), travel: new Array(NUM_KEYS).fill(0), frames: 0 };
            this._telemetryChain = Promise.resolve();
            this._rawCollector = null;
            this._expectReboot = false;
            this.unsupportedProtocol = null;
            this._resetDeviceState();
        }

        _resetDeviceState() {
            this.info = null;
            this.limits = C.FALLBACK_LIMITS;
            this.limitsSource = "fallback";
            this.confirmed = null;
            this.deviceStatus = { output: null, calibration: null, sim_mask: 0, settings: null };
            this.dirty = null;
            this.ops = {};
            this.cal = null;
            this.telemetry.active = false;
            this.telemetry.target = false;
            this.telemetry.hz = null;
            this.telemetry.error = null;
            this.telemetry.pressed = new Array(NUM_KEYS).fill(false);
            this.telemetry.sending = new Array(NUM_KEYS).fill(false);
            this.telemetry.travel = new Array(NUM_KEYS).fill(0);
        }

        get isConnected() { return this.conn.state === "connected" && !!this.client; }
        get statusText() { return (CONN_TEXT[this.conn.state] || (() => this.conn.state))(this); }

        // ----------------------------------------------------------------------- logging
        log(level, msg) {
            const entry = { t: Date.now(), level, msg: String(msg) };
            this.logLines.push(entry);
            if (this.logLines.length > LOG_MAX) this.logLines.splice(0, this.logLines.length - LOG_MAX);
            this.emit("log", entry);
        }

        _traffic(dir, line) {
            if (dir === "rx" && line.startsWith('{"type":"telemetry"')) return;   // 30 Hz; counted instead
            if (dir === "rx" && line.startsWith('{"type":"raw"')) return;
            this.log(dir, line);
        }

        _changed() { this.emit("change", this); }

        _setConn(state, detail) {
            this.conn = { state, detail: detail || "", since: Date.now() };
            this.log("info", `${this.statusText}${detail ? ": " + detail : ""}`);
            this.emit("conn", this.conn);
            this._changed();
        }

        // ----------------------------------------------------------------------- connection
        async connect() {
            if (["connecting", "identifying", "connected"].includes(this.conn.state)) return this.conn.state;
            const prev = this.conn;
            this._resetDeviceState();
            this.unsupportedProtocol = null;
            this._expectReboot = false;
            this._setConn("connecting", "Choose the DriftPad's serial port");
            let transport;
            transport = this.createTransport({
                onText: text => { if (this.transport === transport && this.client) this.client.handleText(text); },
                onClose: info => this._onTransportClosed(transport, info),
                log: (level, msg) => this.log(level, msg),
            });
            const client = new ProtocolClient({
                write: text => transport.write(text),
                onEvent: ev => this._onEvent(ev),
                onUnmatched: (obj, why) => this._onUnmatched(obj, why),
                onText: line => { this.counters.textLines++; this.log("rx", line); },
                onTraffic: (dir, line) => this._traffic(dir, line),
                timeoutMs: this.timeouts.request,
            });
            this.transport = transport;
            this.client = client;
            try {
                await transport.open();
            } catch (err) {
                client.close("open failed");
                this.transport = this.client = null;
                if (err && err.name === "NotFoundError") {
                    // The user closed the port chooser: nothing changed.
                    this.conn = prev;
                    this.log("info", "No port selected");
                    this.emit("conn", this.conn);
                    this._changed();
                    return this.conn.state;
                }
                this._setConn("disconnected", `Could not open the port: ${DP.transport.describeError(err)}`);
                return this.conn.state;
            }
            if (this.transport !== transport) return this.conn.state;
            this._setConn("identifying", "Asking the device to identify itself (INFO)");
            const ident = await this._identify(client);
            if (this.transport !== transport) return this.conn.state;   // closed meanwhile
            if (ident.kind !== "driftpad") {
                if (ident.kind === "unsupported") this.unsupportedProtocol = ident.protocol;
                this._setConn(ident.kind, ident.reason);
                this._closing = "identify";
                await transport.close({ reason: "identify" });
                return this.conn.state;
            }
            this._applyInfo(ident.info);
            this._setConn("connected", ident.info.build ? `build ${ident.info.build}` : "");
            try { await this.refreshConfig(); } catch (e) { /* reported through ops.load */ }
            try { await this.refreshStatus(); } catch (e) { /* reported through ops.status */ }
            this._syncTelemetry();
            return this.conn.state;
        }

        async _identify(client) {
            let infoDone = null;
            const infoP = client.request("INFO", [], { timeoutMs: this.timeouts.identify }).then(
                info => (infoDone = { info }), err => (infoDone = { err }));
            // Legacy (v1) firmware answers "@id INFO" with an id-less {"status":"error"}; do not wait
            // for the full timeout once that has been seen.
            const idless = client.waitFor(o => has(o, "status") && typeof o.id !== "string", this.timeouts.identify);
            await Promise.race([infoP, idless.then(o => (o ? null : infoP))]);

            const fromInfo = () => {
                if (!infoDone) return null;
                if (infoDone.info) return this._classify(infoDone.info);
                const err = infoDone.err;
                if (err.kind === "closed") return { kind: "lost" };
                if (err.kind === "device_error") return { kind: "not_driftpad", reason: `The device rejected INFO (${err.code || err.message}).` };
                if (err.kind === "invalid_reply") return { kind: "not_driftpad", reason: err.message };
                return null;   // timeout / write failure: try the legacy probe
            };
            const decided = fromInfo();
            if (decided) return decided;

            const pongP = client.waitFor(o => o.type === "pong", this.timeouts.legacyProbe);
            try {
                await client.sendUntracked("PING");
            } catch (err) {
                if (err.kind === "closed") return { kind: "lost" };
                return { kind: "not_driftpad", reason: `Could not write to the port: ${err.message}` };
            }
            const pong = await pongP;
            const late = fromInfo();
            if (late) return late;
            if (!this.client) return { kind: "lost" };
            if (pong && !has(pong, "status")) {
                return { kind: "legacy", reason: "This DriftPad runs legacy firmware (protocol 1). Update the firmware to use this configurator; nothing was written." };
            }
            if (pong) return { kind: "not_driftpad", reason: "The device answered PING but not INFO, so it cannot be identified." };
            return { kind: "not_driftpad", reason: "No response to INFO or PING." };
        }

        _classify(info) {
            if (info.type !== "info") return { kind: "not_driftpad", reason: "INFO reply has no identity." };
            if (info.device !== "DriftPad") {
                return { kind: "not_driftpad", reason: `The device identifies as "${String(info.device)}", not a DriftPad.` };
            }
            if (info.protocol !== C.PROTOCOL_VERSION) {
                if (isInt(info.protocol) && info.protocol < C.PROTOCOL_VERSION) {
                    return { kind: "legacy", reason: `This DriftPad reports protocol ${info.protocol}. Update the firmware.` };
                }
                return { kind: "unsupported", protocol: info.protocol, reason: `This DriftPad speaks protocol ${String(info.protocol)}; this configurator supports protocol ${C.PROTOCOL_VERSION}. Use a matching configurator.` };
            }
            return { kind: "driftpad", info };
        }

        _applyInfo(info) {
            this.info = {
                device: info.device,
                hw: typeof info.hw === "string" ? info.hw : "unknown",
                fw: typeof info.fw === "string" ? info.fw : "unknown",
                protocol: info.protocol,
                build: typeof info.build === "string" ? info.build : "unknown",
                build_date: typeof info.build_date === "string" ? info.build_date : "unknown",
                features: Array.isArray(info.features) ? info.features.filter(f => typeof f === "string") : [],
                uptime_ms: isNum(info.uptime_ms) ? info.uptime_ms : null,
            };
            const limits = parseLimits(info.limits);
            if (limits) {
                this.limits = limits;
                this.limitsSource = "device";
            } else {
                this.limits = C.FALLBACK_LIMITS;
                this.limitsSource = "fallback";
                this.log("warn", "INFO did not include usable limits; using the built-in limits");
            }
            if (info.calibration && typeof info.calibration === "object") this.deviceStatus.calibration = { ...info.calibration };
            if (info.output && typeof info.output === "object") this.deviceStatus.output = { ...info.output };
            if (info.settings && typeof info.settings === "object") {
                this.deviceStatus.settings = { ...info.settings };
                if (typeof info.settings.dirty === "boolean") this.dirty = info.settings.dirty;
            }
        }

        hasFeature(name) { return !!(this.info && this.info.features.includes(name)); }

        async disconnect() {
            const t = this.transport;
            if (!t) return;
            if (this.isConnected && this.telemetry.active) {
                try { await this.client.request("STREAM", ["0"], { timeoutMs: 500 }); } catch (e) { /* closing anyway */ }
            }
            this._closing = "user";
            await t.close({ reason: "user" });
        }

        _onTransportClosed(transport, info) {
            if (this.transport !== transport) return;
            const closing = this._closing;
            this._closing = null;
            const client = this.client;
            this.transport = null;
            this.client = null;
            if (client) client.close(info.reason === "lost" ? "Connection lost" : "Disconnected");
            if (this._rawCollector) this._rawCollector.fail(new ProtocolError("closed", "Disconnected"));
            const keepState = closing === "identify";
            const wasState = this.conn.state;
            const errs = info.errors && info.errors.length ? ` (${info.errors.length} teardown problem${info.errors.length > 1 ? "s" : ""}, see the log)` : "";
            this._resetDeviceState();
            if (keepState) {
                this._changed();
                return;
            }
            if (info.reason === "lost") {
                const why = this._expectReboot ? "The device rebooted into the bootloader." :
                    `The device stopped responding or was unplugged (${DP.transport.describeError(info.error)}).`;
                this._setConn("lost", why + errs);
            } else {
                this._setConn("disconnected", (wasState === "connected" ? "Disconnected by you." : "Connection closed.") + errs);
            }
        }

        // ----------------------------------------------------------------------- incoming
        _onUnmatched(obj, why) {
            this.counters.unmatched++;
            const what = why === "no_id" ? "a reply without an id" : why === "unknown_id" ? `a reply for unknown request "${obj.id}" (late or stray)` : "an unrecognised line";
            this.log("warn", `Ignored ${what}`);
        }

        _onEvent(ev) {
            this.counters.events++;
            switch (ev.type) {
                case "telemetry": {
                    if (!this.isConnected || !(this.telemetry.active || this.telemetry.target)) return;
                    const t = parseTelemetry(ev);
                    if (!t) return;
                    this.telemetry.pressed = t.pressed;
                    this.telemetry.sending = t.sending;
                    this.telemetry.travel = t.travel;
                    this.telemetry.frames++;
                    this.counters.telemetryFrames++;
                    this.deviceStatus.sim_mask = t.simMask;
                    this.emit("telemetry", this.telemetry);
                    return;
                }
                case "cal":
                    this._onCalEvent(ev);
                    return;
                case "raw":
                    if (this._rawCollector) this._rawCollector.chunk(ev);
                    return;
                case "log":
                    this.log("device", typeof ev.msg === "string" ? ev.msg : JSON.stringify(ev));
                    return;
                case "boot":
                    this.log("warn", "The device reports a reboot");
                    return;
                default:
                    this.log("info", `Ignored unsolicited "${ev.type}" line (only correlated replies change the device state)`);
            }
        }

        _onCalEvent(ev) {
            if (!this.isConnected) return;
            const cal = this.cal || (this.cal = { phase: "idle", done: [], failed: [], missing: [], active: false });
            if (typeof ev.phase === "string") cal.phase = ev.phase;
            // Firmware fields (commands.cpp writeCalProgress): rest_ok, rest_failed, travel_done
            if (Array.isArray(ev.travel_done)) cal.done = ev.travel_done.filter(isInt);
            if (Array.isArray(ev.rest_failed)) cal.failed = ev.rest_failed.filter(isInt);
            if (Array.isArray(ev.rest_ok)) cal.restOk = ev.rest_ok.filter(isInt);
            if (isInt(ev.elapsed_ms)) cal.elapsedMs = ev.elapsed_ms;
            cal.active = cal.phase === "rest" || cal.phase === "travel";
            cal.updatedAt = Date.now();
            if (!cal.active) this.refreshStatus().catch(() => {});
            this.emit("cal", cal);
            this._changed();
        }

        // ----------------------------------------------------------------------- operations
        // Runs `fn` as a named operation: state pending -> succeeded | failed, always finalized.
        async runOp(name, fn) {
            const op = { state: "pending", error: null, result: null, startedAt: Date.now(), finishedAt: null };
            this.ops[name] = op;
            this._changed();
            try {
                const r = await fn();
                op.state = "succeeded";
                op.result = r;
                return r;
            } catch (err) {
                op.state = "failed";
                op.error = err;
                throw err;
            } finally {
                op.finishedAt = Date.now();
                if (this.ops[name] === op) this._changed();
            }
        }

        opState(name) { return this.ops[name] ? this.ops[name].state : "idle"; }

        request(verb, args, opts) {
            if (!this.isConnected) {
                return Promise.reject(new ProtocolError("closed", "Not connected to a supported DriftPad"));
            }
            return this.client.request(verb, args, opts);
        }

        _noteDirty(reply) {
            if (reply && typeof reply.dirty === "boolean") {
                this.dirty = reply.dirty;
                if (this.confirmed) this.confirmed.dirty = reply.dirty;
            }
        }

        // Fresh GET_CONFIG, correlated by id. Replaces the confirmed state.
        refreshConfig() {
            return this.runOp("load", async () => {
                const r = await this.request("GET_CONFIG", [], { expectType: "config", validate: configProblem });
                this.confirmed = parseConfig(r);
                this._noteDirty(r);
                this.emit("config", this.confirmed);
                return this.confirmed;
            });
        }

        refreshStatus() {
            return this.runOp("status", async () => {
                const r = await this.request("STATUS", [], { expectType: "status" });
                if (r.output && typeof r.output === "object") this.deviceStatus.output = { ...r.output };
                if (r.calibration && typeof r.calibration === "object") {
                    this.deviceStatus.calibration = Object.assign({}, this.deviceStatus.calibration, r.calibration);
                }
                if (isInt(r.sim_mask)) this.deviceStatus.sim_mask = r.sim_mask;
                this._noteDirty(r);
                return r;
            });
        }

        refreshInfo() {
            return this.runOp("info", async () => {
                const r = await this.request("INFO", [], { expectType: "info" });
                const c = this._classify(r);
                if (c.kind !== "driftpad") throw new ProtocolError("invalid_reply", c.reason);
                this._applyInfo(r);
                return this.info;
            });
        }

        // Applies one setting ("actuation" | "rt_sens" | "rt_enabled" | "active_layer" | "boot_output").
        // Resolves with the device's normalised value from the reply.
        async setSetting(field, value) {
            const spec = {
                actuation: ["SET_ACTUATION", () => C.formatMm(value), isNum],
                rt_sens: ["SET_RT_SENS", () => C.formatMm(value), isNum],
                rt_enabled: ["SET_RT_ENABLE", () => (value ? "1" : "0"), v => typeof v === "boolean"],
                active_layer: ["SET_LAYER", () => String(value), isInt],
                boot_output: ["SET_BOOT_OUTPUT", () => (value ? "1" : "0"), v => typeof v === "boolean"],
            }[field];
            if (!spec) throw new Error(`Unknown setting ${field}`);
            const [verb, arg, check] = spec;
            const r = await this.request(verb, [arg()], { validate: rep => (check(rep[field]) ? null : `${field} missing from the reply`) });
            if (this.confirmed) this.confirmed[field] = r[field];
            this._noteDirty(r);
            this._changed();
            return r[field];
        }

        // SET_KEY; resolves with the normalised {code, label} the device reports.
        async setKey(layer, key, code, label) {
            const args = [layer, key, code];
            if (label !== null && label !== undefined) args.push(label);
            const r = await this.request("SET_KEY", args, {
                validate: rep => {
                    if (rep.layer !== layer || rep.key !== key) return `reply is for layer ${rep.layer} key ${rep.key}`;
                    if (!isInt(rep.code) || typeof rep.label !== "string") return "code/label missing from the reply";
                    return null;
                },
            });
            if (this.confirmed) this.confirmed.layers[layer][key] = { code: r.code, label: r.label };
            this._noteDirty(r);
            this._changed();
            return { code: r.code, label: r.label };
        }

        setOutput(enabled, force) {
            return this.runOp("output", async () => {
                const args = [enabled ? "1" : "0"];
                if (enabled && force) args.push("FORCE");
                const r = await this.request("SET_HID", args, {
                    validate: rep => (rep.output && typeof rep.output.enabled === "boolean" ? null : "output state missing from the reply"),
                });
                this.deviceStatus.output = { ...r.output };
                return r.output;
            });
        }

        // SAVE. Succeeds only when the reply says persisted:true.
        save() {
            return this.runOp("save", async () => {
                const r = await this.request("SAVE", [], { timeoutMs: this.timeouts.save });
                this._noteDirty(r);
                if (r.persisted !== true) {
                    throw new ProtocolError("device_error", "The device did not confirm that the settings reached flash (persisted is not true).", { reply: r });
                }
                if (this.confirmed && isInt(r.seq)) this.confirmed.settings_seq = r.seq;
                return { persisted: true, slot: r.slot, seq: r.seq, duration_ms: r.duration_ms };
            });
        }

        revert() {
            return this.runOp("revert", async () => {
                const r = await this.request("REVERT", [], { timeoutMs: this.timeouts.save });
                this._noteDirty(r);
                await this.refreshConfig();
                await this.refreshStatus().catch(() => {});
                return r;
            });
        }

        reset(all) {
            return this.runOp("reset", async () => {
                const r = await this.request("RESET", all ? ["ALL"] : []);
                this._noteDirty(r);
                await this.refreshConfig();
                await this.refreshStatus().catch(() => {});
                return r;
            });
        }

        // ----------------------------------------------------------------------- calibration
        calStart() {
            return this.runOp("cal", async () => {
                const r = await this.request("CAL", ["START"]);
                this.cal = { phase: typeof r.phase === "string" ? r.phase : "rest", done: [], failed: [], missing: [], active: true, startedAt: Date.now() };
                if (r.output) this.deviceStatus.output = { ...r.output };
                this.emit("cal", this.cal);
                return this.cal;
            });
        }

        calStatus() {
            return this.runOp("calStatus", async () => {
                const r = await this.request("CAL", ["STATUS"]);
                this._onCalEvent(Object.assign({}, r, { type: "cal" }));
                return this.cal;
            });
        }

        calFinish() {
            return this.runOp("cal", async () => {
                try {
                    const r = await this.request("CAL", ["FINISH"]);
                    if (this.cal) { this.cal.phase = "done"; this.cal.active = false; this.cal.missing = []; }
                    if (r.calibration) this.deviceStatus.calibration = Object.assign({}, this.deviceStatus.calibration, r.calibration);
                    if (r.output) this.deviceStatus.output = { ...r.output };
                    this._noteDirty(r);
                    await this.refreshStatus().catch(() => {});
                    return r;
                } catch (err) {
                    if (err.code === "calibration_incomplete" && this.cal && err.reply) {
                        const miss = err.reply.missing || err.reply.keys_missing;
                        this.cal.missing = Array.isArray(miss) ? miss.filter(isInt) : [];
                        this._changed();
                    }
                    throw err;
                }
            });
        }

        calCancel() {
            return this.runOp("cal", async () => {
                const r = await this.request("CAL", ["CANCEL"]);
                if (this.cal) { this.cal.phase = "cancelled"; this.cal.active = false; }
                await this.refreshStatus().catch(() => {});
                return r;
            });
        }

        // ----------------------------------------------------------------------- telemetry
        wantTelemetry(reason, on) {
            if (on) this.telemetry.wanted.add(reason);
            else this.telemetry.wanted.delete(reason);
            this._syncTelemetry();
        }

        setPageVisible(visible) {
            this.pageVisible = !!visible;
            this._syncTelemetry();
        }

        _syncTelemetry() {
            const should = this.isConnected && this.pageVisible && this.telemetry.wanted.size > 0;
            if (should === this.telemetry.target) return this._telemetryChain;
            this.telemetry.target = should;
            if (!should) {
                // No live data any more: show nothing rather than the last frame.
                this.telemetry.pressed = new Array(NUM_KEYS).fill(false);
                this.telemetry.sending = new Array(NUM_KEYS).fill(false);
                this.telemetry.travel = new Array(NUM_KEYS).fill(0);
                this.emit("telemetry", this.telemetry);
            }
            this._telemetryChain = this._telemetryChain.then(() => this._applyTelemetry()).catch(() => {});
            return this._telemetryChain;
        }

        async _applyTelemetry() {
            const want = this.telemetry.target;
            if (!this.isConnected || want === this.telemetry.active) return;
            try {
                const r = await this.request("STREAM", [want ? "1" : "0"], {
                    validate: rep => (typeof rep.streaming === "boolean" ? null : "streaming missing from the reply"),
                });
                this.telemetry.active = r.streaming;
                this.telemetry.hz = isInt(r.hz) ? r.hz : null;
                this.telemetry.error = null;
            } catch (err) {
                this.telemetry.error = err.message;
                this.log("warn", `Telemetry ${want ? "subscribe" : "unsubscribe"} failed: ${err.message}`);
            }
            this._changed();
        }

        // ----------------------------------------------------------------------- diagnostics
        sim(key, mmOrOff) {
            return this.runOp("sim", () => {
                if (key === null) return this.request("SIM", ["OFF"]);
                return this.request("SIM", [String(key), mmOrOff === "OFF" ? "OFF" : C.formatMm(mmOrOff)]);
            });
        }

        timing(reset) {
            return this.runOp("timing", () => this.request("TIMING", reset ? ["RESET"] : [], { expectType: "timing" }));
        }

        scanRate() {
            return this.runOp("scanRate", () => this.request("SCAN_RATE", [], { expectType: "scan_rate" }));
        }

        // RAW <key>: resolves with the samples once every chunk arrived.
        raw(key) {
            return this.runOp("raw", () => new Promise((resolve, reject) => {
                let total = null;
                const samples = [];
                let received = 0;
                let timer = null;
                const done = (err) => {
                    clearTimeout(timer);
                    if (this._rawCollector === collector) this._rawCollector = null;
                    if (err) reject(err); else resolve({ key, samples, rate_hz: collector.rate });
                };
                const collector = {
                    rate: null,
                    chunk: ev => {
                        if (ev.key !== key || !isInt(ev.offset) || !Array.isArray(ev.samples)) return;
                        if (isInt(ev.total)) total = ev.total;
                        if (isInt(ev.rate_hz)) collector.rate = ev.rate_hz;
                        ev.samples.forEach((v, i) => { samples[ev.offset + i] = v; });
                        received += ev.samples.length;
                        if (total !== null && received >= total) done(null);
                    },
                    fail: err => done(err),
                };
                if (this._rawCollector) this._rawCollector.fail(new ProtocolError("closed", "Superseded by a new capture"));
                this._rawCollector = collector;
                timer = setTimeout(() => done(new ProtocolError("timeout", "Raw capture did not complete")), this.timeouts.raw);
                this.request("RAW", [String(key)]).then(r => {
                    if (isInt(r.samples) && total === null) total = r.samples;
                    if (total !== null && received >= total) done(null);
                }, err => done(err));
            }));
        }

        display(verb, args) {
            return this.runOp("display", () => this.request(verb, args || []));
        }

        bootsel() {
            return this.runOp("bootsel", async () => {
                this._expectReboot = true;
                try {
                    return await this.request("BOOTSEL", []);
                } catch (err) {
                    this._expectReboot = false;
                    throw err;
                }
            });
        }
    }

    DP.device = Object.freeze({ DeviceSession, Emitter, parseLimits, configProblem, parseConfig, parseTelemetry, CONN_TEXT });
})(typeof window !== "undefined" ? window : globalThis);
