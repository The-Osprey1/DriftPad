/*
 * draft.js - the offline keymap draft, pending changes against the confirmed device state, and
 * writes that snapshot their outgoing values.
 *
 *  Draft          keymap edits kept in localStorage under a versioned key (works offline).
 *  KeymapSync     compares the draft with DeviceSession.confirmed and writes the differences.
 *                 A write snapshots {code,label} before sending; the ack stores the device's
 *                 normalised reply values as confirmed. A key edited again while its write was
 *                 in flight therefore stays pending (draft != confirmed), and a device that stored
 *                 something else than what was sent is reported as a mismatch.
 *  SettingsSync   the same model for actuation / RT sensitivity / RT enable (edits in memory).
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};
    const C = DP.contract;
    const K = DP.keycodes;
    const { Emitter } = DP.device;

    const STORAGE_KEY = "driftpad.configurator.draft.v2";
    const LEGACY_STORAGE_KEY = "driftpad.keymap.draft.v1";   // keymap.html (before the merge)
    const NUM_KEYS = C.NUM_KEYS;

    const keyId = (l, k) => `${l}:${k}`;
    const sameKey = (a, b) => !!a && !!b && a.code === b.code && a.label === b.label;
    const cloneLayers = layers => layers.map(l => l.map(k => ({ code: k.code, label: k.label })));

    // Validates 3 x 16 {code,label}. strict: labels must already satisfy the rule; otherwise
    // invalid labels are replaced by the catalog label for the code (legacy data) and reported.
    function checkLayers(layers, { strict }) {
        const problems = [];
        const warnings = [];
        if (!Array.isArray(layers) || layers.length !== 3) return { layers: null, problems: ["layers must be an array of 3 layers"], warnings };
        const out = [];
        for (let l = 0; l < 3; l++) {
            const layer = layers[l];
            if (!Array.isArray(layer) || layer.length !== NUM_KEYS) {
                problems.push(`layers[${l}] must have 16 keys`);
                continue;
            }
            const row = [];
            for (let k = 0; k < NUM_KEYS; k++) {
                const key = layer[k];
                const where = `layers[${l}][${k}]`;
                if (!key || typeof key !== "object") { problems.push(`${where} must be an object`); continue; }
                const code = key.code;
                if (!Number.isInteger(code) || code < 0 || code > 255) { problems.push(`${where}.code must be an integer 0..255`); continue; }
                if (!K.isAssignable(code)) { problems.push(`${where}.code ${code} does not produce a key on the pad`); continue; }
                let label = C.normalizeLabel(key.label);
                if (label === null) {
                    const why = C.labelProblem(typeof key.label === "string" ? key.label : "") || "invalid";
                    if (strict) { problems.push(`${where}.label ${JSON.stringify(key.label)}: ${why}`); continue; }
                    label = K.defaultLabel(code);
                    warnings.push(`${where}.label ${JSON.stringify(key.label)} replaced by "${label}" (${why})`);
                }
                row.push({ code, label });
            }
            out.push(row);
        }
        return { layers: problems.length ? null : out, problems, warnings };
    }

    class Draft extends Emitter {
        constructor({ storage } = {}) {
            super();
            this.storage = storage === undefined ? safeLocalStorage() : storage;
            this.storageError = null;
            this.loadNote = null;
            this.defaults = K.defaultKeymaps();
            this.layers = cloneLayers(this.defaults);
            this.touched = false;       // false: nothing worth keeping; adopt the device keymap on connect
            this.load();
        }

        load() {
            const read = key => {
                try { return this.storage ? this.storage.getItem(key) : null; } catch (e) { this.storageError = e.message; return null; }
            };
            const raw = read(STORAGE_KEY);
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    if (data && data.version === 2) {
                        const r = checkLayers(data.layers, { strict: true });
                        if (r.layers) {
                            this.layers = r.layers;
                            this.touched = !!data.touched;
                            return;
                        }
                        this.loadNote = `The saved draft was invalid and was replaced by the defaults (${r.problems[0]}).`;
                    } else {
                        this.loadNote = "The saved draft has an unknown version and was ignored.";
                    }
                } catch (e) {
                    this.loadNote = "The saved draft could not be read and was ignored.";
                }
                return;
            }
            const legacy = read(LEGACY_STORAGE_KEY);
            if (legacy) {
                try {
                    const r = checkLayers(JSON.parse(legacy), { strict: false });
                    if (r.layers) {
                        this.layers = r.layers;
                        this.touched = true;
                        this.loadNote = "Your keymap draft from the previous keymap editor was carried over." +
                            (r.warnings.length ? ` ${r.warnings.length} label(s) were replaced because they break the label rule.` : "");
                        this.save();
                    }
                } catch (e) { /* unreadable legacy draft: start from defaults */ }
            }
        }

        save() {
            if (!this.storage) return;
            try {
                this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), touched: this.touched, layers: this.layers }));
                this.storageError = null;
            } catch (e) {
                this.storageError = `Could not save the draft in this browser: ${e.message}`;
            }
        }

        get(l, k) { return this.layers[l][k]; }
        isCustom(l, k) { return !sameKey(this.layers[l][k], this.defaults[l][k]); }

        // Sets one key. `label` must satisfy the label rule; the code must be assignable.
        set(l, k, code, label) {
            const lbl = C.normalizeLabel(label);
            if (lbl === null) throw new Error(C.labelProblem(label) || "Invalid label");
            if (!K.isAssignable(code)) throw new Error(`Code ${code} does not produce a key on the pad`);
            this.layers[l][k] = { code, label: lbl };
            this.touched = true;
            this.save();
            this.emit("change", { l, k });
        }

        resetKey(l, k) { this.set(l, k, this.defaults[l][k].code, this.defaults[l][k].label); }

        resetLayer(l) {
            this.layers[l] = cloneLayers(this.defaults)[l];
            this.touched = true;
            this.save();
            this.emit("change", { layer: l });
        }

        resetAll() {
            this.layers = cloneLayers(this.defaults);
            this.touched = true;
            this.save();
            this.emit("change", {});
        }

        replaceLayers(layers, { touched = true } = {}) {
            this.layers = cloneLayers(layers);
            this.touched = touched;
            this.save();
            this.emit("change", {});
        }
    }

    function safeLocalStorage() {
        try { return global.localStorage || null; } catch (e) { return null; }
    }

    class KeymapSync extends Emitter {
        constructor(draft, session) {
            super();
            this.draft = draft;
            this.session = session;
            this.inFlight = new Map();     // keyId -> snapshot {l,k,code,label}
            this.errors = new Map();       // keyId -> message from the last failed write
            this.mismatches = new Map();   // keyId -> {sent, stored}
            this.writing = false;
            this.lastResult = null;
            this._adoptedThisConnection = false;
            draft.on("change", () => this.emit("change"));
            session.on("conn", conn => {
                if (conn.state !== "connected") {
                    this._adoptedThisConnection = false;
                    this.errors.clear();
                    this.mismatches.clear();
                }
                this.emit("change");
            });
            session.on("config", () => {
                // First read after connecting: an untouched draft simply follows the device.
                if (!this._adoptedThisConnection) {
                    this._adoptedThisConnection = true;
                    if (!this.draft.touched) this.draft.replaceLayers(this.session.confirmed.layers, { touched: false });
                }
                this.emit("change");
            });
        }

        get compared() { return this.session.isConnected && !!this.session.confirmed; }

        keyState(l, k) {
            const d = this.draft.get(l, k);
            const c = this.compared ? this.session.confirmed.layers[l][k] : null;
            const id = keyId(l, k);
            return {
                draft: d,
                device: c,
                compared: !!c,
                custom: this.draft.isCustom(l, k),
                pending: !!c && !sameKey(d, c),
                writing: this.inFlight.has(id),
                error: this.errors.get(id) || null,
                mismatch: this.mismatches.get(id) || null,
            };
        }

        pendingList() {
            if (!this.compared) return [];
            const out = [];
            for (let l = 0; l < 3; l++) {
                for (let k = 0; k < NUM_KEYS; k++) {
                    if (!sameKey(this.draft.get(l, k), this.session.confirmed.layers[l][k])) out.push({ l, k });
                }
            }
            return out;
        }

        // offline | loading | writing | pending | in_sync
        syncState() {
            if (!this.session.isConnected) return "offline";
            if (!this.session.confirmed) return "loading";
            if (this.writing || this.inFlight.size) return "writing";
            return this.pendingList().length ? "pending" : "in_sync";
        }

        // Writes every pending key. Never leaves `writing` set, whatever happens.
        writeChanges() {
            if (this.writing) return Promise.reject(new Error("A write is already running"));
            if (!this.compared) return Promise.reject(new Error("Connect a DriftPad and read its keymap first"));
            // Snapshot the outgoing values now; later edits do not change what this write sends.
            const items = this.pendingList().map(({ l, k }) => {
                const d = this.draft.get(l, k);
                return { l, k, code: d.code, label: d.label };
            });
            this.writing = true;
            this.emit("change");
            const result = { written: [], failed: [], mismatched: [], skipped: [] };
            return this.session.runOp("write", async () => {
                let refresh = false;
                try {
                    for (let i = 0; i < items.length; i++) {
                        const it = items[i];
                        const id = keyId(it.l, it.k);
                        if (!this.session.isConnected) { result.skipped.push(...items.slice(i)); break; }
                        this.inFlight.set(id, it);
                        this.errors.delete(id);
                        this.mismatches.delete(id);
                        this.emit("change");
                        try {
                            const stored = await this.session.setKey(it.l, it.k, it.code, it.label);
                            if (stored.code !== it.code || stored.label !== it.label) {
                                this.mismatches.set(id, { sent: { code: it.code, label: it.label }, stored });
                                result.mismatched.push({ ...it, stored });
                            } else {
                                result.written.push(it);
                            }
                        } catch (err) {
                            this.errors.set(id, err.message);
                            result.failed.push({ ...it, error: err });
                            if (err.kind !== "device_error" && err.kind !== "bad_request") {
                                // Outcome unknown (timeout, write failure, lost): stop and re-read.
                                refresh = err.kind === "timeout" || err.kind === "invalid_reply";
                                result.skipped.push(...items.slice(i + 1));
                                break;
                            }
                        } finally {
                            this.inFlight.delete(id);
                            this.emit("change");
                        }
                    }
                    if (refresh && this.session.isConnected) {
                        let cfg = null;
                        try { cfg = await this.session.refreshConfig(); } catch (e) { /* reported by ops.load */ }
                        // The fresh read-back decides what an unanswered write did: a key that now
                        // holds exactly what was sent was applied; anything else stays failed.
                        if (cfg) {
                            result.failed = result.failed.filter(f => {
                                if (!sameKey(cfg.layers[f.l][f.k], f)) return true;
                                this.errors.delete(keyId(f.l, f.k));
                                result.written.push({ l: f.l, k: f.k, code: f.code, label: f.label, confirmedBy: "readback" });
                                return false;
                            });
                        }
                    }
                } finally {
                    this.writing = false;
                    this.inFlight.clear();
                    this.lastResult = result;
                    this.emit("change");
                }
                if (result.failed.length || result.mismatched.length) {
                    const err = new Error(summarizeWrite(result));
                    err.result = result;
                    throw err;
                }
                return result;
            });
        }

        // Fresh GET_CONFIG (correlated by id), then the draft becomes the device keymap.
        async loadFromDevice() {
            const cfg = await this.session.refreshConfig();
            this.errors.clear();
            this.mismatches.clear();
            this.draft.replaceLayers(cfg.layers, { touched: false });
            return cfg;
        }
    }

    function summarizeWrite(r) {
        const parts = [];
        if (r.written.length) parts.push(`${r.written.length} written`);
        if (r.failed.length) parts.push(`${r.failed.length} failed (${r.failed[0].error.message})`);
        if (r.mismatched.length) parts.push(`${r.mismatched.length} stored differently than sent`);
        if (r.skipped.length) parts.push(`${r.skipped.length} not attempted`);
        return parts.join(", ");
    }

    const SETTING_FIELDS = ["actuation", "rt_sens", "rt_enabled"];

    function sameSetting(field, a, b) {
        if (field === "rt_enabled") return a === b;
        return C.sameMm(a, b);
    }

    class SettingsSync extends Emitter {
        constructor(session) {
            super();
            this.session = session;
            this.edits = { actuation: null, rt_sens: null, rt_enabled: null };   // null: follow the device
            this.inFlight = new Map();
            this.errors = new Map();
            this.mismatches = new Map();
            this.applying = false;
            session.on("conn", conn => { if (conn.state !== "connected") { this.errors.clear(); this.mismatches.clear(); } this.emit("change"); });
        }

        confirmedValue(field) {
            return this.session.isConnected && this.session.confirmed ? this.session.confirmed[field] : null;
        }

        value(field) {
            if (this.edits[field] !== null) return this.edits[field];
            const c = this.confirmedValue(field);
            if (c !== null && c !== undefined) return c;
            if (field === "rt_enabled") return true;
            return this.session.limits[field].default;
        }

        set(field, value) {
            this.edits[field] = value;
            this.emit("change");
        }

        isPending(field) {
            const c = this.confirmedValue(field);
            return this.edits[field] !== null && c !== null && !sameSetting(field, this.edits[field], c);
        }

        isEdited(field) { return this.edits[field] !== null && !sameSetting(field, this.edits[field], this.confirmedValue(field)); }

        pendingFields() { return SETTING_FIELDS.filter(f => this.isPending(f)); }

        discard() {
            this.edits = { actuation: null, rt_sens: null, rt_enabled: null };
            this.errors.clear();
            this.mismatches.clear();
            this.emit("change");
        }

        problem(field) {
            if (field === "rt_enabled") return null;
            return C.mmProblem(this.value(field), this.session.limits[field]);
        }

        apply() {
            if (this.applying) return Promise.reject(new Error("Already applying"));
            const fields = this.pendingFields();
            const bad = fields.find(f => this.problem(f));
            if (bad) return Promise.reject(new Error(this.problem(bad)));
            const snapshot = fields.map(f => ({ field: f, value: this.edits[f] }));
            this.applying = true;
            this.emit("change");
            const result = { applied: [], failed: [], mismatched: [] };
            const applied = s => {
                result.applied.push(s);
                // Follow the device again unless the field was edited meanwhile.
                if (this.edits[s.field] !== null && sameSetting(s.field, this.edits[s.field], s.value)) this.edits[s.field] = null;
            };
            return this.session.runOp("settings", async () => {
                try {
                    let unknown = false;
                    for (const s of snapshot) {
                        this.inFlight.set(s.field, s.value);
                        this.errors.delete(s.field);
                        this.mismatches.delete(s.field);
                        this.emit("change");
                        try {
                            const stored = await this.session.setSetting(s.field, s.value);
                            if (!sameSetting(s.field, stored, s.value)) {
                                this.mismatches.set(s.field, { sent: s.value, stored });
                                result.mismatched.push({ ...s, stored });
                            } else {
                                applied(s);
                            }
                        } catch (err) {
                            this.errors.set(s.field, err.message);
                            result.failed.push({ ...s, error: err });
                            if (err.kind !== "device_error") {
                                unknown = err.kind === "timeout" || err.kind === "invalid_reply";
                                break;
                            }
                        } finally {
                            this.inFlight.delete(s.field);
                            this.emit("change");
                        }
                    }
                    // Outcome unknown (no usable reply): the fresh read-back decides, never an assumption.
                    if (unknown && this.session.isConnected) {
                        let cfg = null;
                        try { cfg = await this.session.refreshConfig(); } catch (e) { /* reported by ops.load */ }
                        if (cfg) {
                            result.failed = result.failed.filter(f => {
                                if (!sameSetting(f.field, cfg[f.field], f.value)) return true;
                                this.errors.delete(f.field);
                                applied({ field: f.field, value: f.value, confirmedBy: "readback" });
                                return false;
                            });
                        }
                    }
                } finally {
                    this.applying = false;
                    this.emit("change");
                }
                if (result.failed.length || result.mismatched.length) {
                    const err = new Error(result.failed.length ? result.failed[0].error.message : "The device stored a different value than sent");
                    err.result = result;
                    throw err;
                }
                return result;
            });
        }
    }

    DP.draft = Object.freeze({ Draft, KeymapSync, SettingsSync, checkLayers, sameKey, STORAGE_KEY, LEGACY_STORAGE_KEY });
})(typeof window !== "undefined" ? window : globalThis);
