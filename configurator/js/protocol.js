/*
 * protocol.js - serial protocol v2 client: line framing, request ids, correlation, timeouts and
 * reply validation. Transport-agnostic: give it a `write(text)` that returns a promise and feed it
 * received text with handleText().
 *
 * Correlation rule (contract section 2): a reply resolves a request only when it carries that
 * request's "id". Events (lines with "type" and no "status"), id-less replies and replies with an
 * unknown id never resolve anything; they are passed to onEvent / onUnmatched instead.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};
    const C = DP.contract;

    class ProtocolError extends Error {
        // kind: timeout | write_failed | closed | device_error | invalid_reply | bad_request
        constructor(kind, message, extra) {
            super(message);
            this.name = "ProtocolError";
            this.kind = kind;
            Object.assign(this, extra || {});
        }
    }

    // Splits received text into lines. "\n" or "\r" end a line, "\r\n" counts once (also when the
    // two bytes arrive in separate chunks), empty lines are ignored. A line longer than
    // `maxLineChars` is discarded up to its terminator (never delivered truncated).
    class LineFramer {
        constructor(onLine, { maxLineChars = 65536, onOverflow = null } = {}) {
            this.onLine = onLine;
            this.maxLineChars = maxLineChars;
            this.onOverflow = onOverflow;
            this.reset();
        }

        reset() {
            this.buf = "";
            this.lastWasCR = false;
            this.discarding = false;
        }

        push(text) {
            let start = 0;
            for (let i = 0; i < text.length; i++) {
                const ch = text.charCodeAt(i);
                if (ch !== 10 && ch !== 13) continue;
                const skip = ch === 10 && this.lastWasCR && i === start && this.buf === "";
                this._append(text.slice(start, i));
                start = i + 1;
                this.lastWasCR = ch === 13;
                if (skip) continue;
                this._finishLine();
            }
            if (start < text.length) {
                this._append(text.slice(start));
                this.lastWasCR = false;
            }
        }

        _append(part) {
            if (!part) return;
            if (this.discarding) return;
            this.buf += part;
            if (this.buf.length > this.maxLineChars) {
                this.buf = "";
                this.discarding = true;
            }
        }

        _finishLine() {
            if (this.discarding) {
                this.discarding = false;
                if (this.onOverflow) this.onOverflow();
                return;
            }
            const line = this.buf;
            this.buf = "";
            if (line.trim() === "") return;
            this.onLine(line);
        }
    }

    const VERB_RE = /^[A-Za-z_]+$/;

    function randomPrefix() {
        const chars = "abcdefghijklmnopqrstuvwxyz";
        let out = "";
        for (let i = 0; i < 3; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    }
    const ARG_RE = /^[\x21-\x7E]+$/;

    // Builds "@<id> VERB arg arg". Throws ProtocolError(bad_request) instead of producing a line the
    // device would reject or truncate.
    function formatLine(id, verb, args) {
        if (id !== null && !C.REQUEST_ID_RE.test(id)) throw new ProtocolError("bad_request", `Invalid request id "${id}"`);
        if (!VERB_RE.test(verb)) throw new ProtocolError("bad_request", `Invalid command "${verb}"`);
        const parts = [];
        if (id !== null) parts.push("@" + id);
        parts.push(verb);
        for (const a of args || []) {
            const s = String(a);
            if (!ARG_RE.test(s)) throw new ProtocolError("bad_request", `Invalid argument "${s}" for ${verb} (no spaces or non-ASCII characters)`);
            parts.push(s);
        }
        const line = parts.join(" ");
        if (line.length > C.LIMITS_CMM.LINE_MAX_LEN) {
            throw new ProtocolError("bad_request", `${verb} would be ${line.length} bytes; the limit is ${C.LIMITS_CMM.LINE_MAX_LEN}`);
        }
        return line;
    }

    class ProtocolClient {
        /**
         * @param {object} o
         * @param {(text:string)=>Promise<void>} o.write  sends raw text (the line plus "\n")
         * @param {(ev:object)=>void} [o.onEvent]         unsolicited event objects ("type", no "status")
         * @param {(obj:object, why:string)=>void} [o.onUnmatched]  replies that resolve nothing
         * @param {(line:string)=>void} [o.onText]        non-JSON lines (legacy log output)
         * @param {(dir:string, text:string)=>void} [o.onTraffic]  TX/RX trace for the serial log
         * @param {number} [o.timeoutMs]                  default per-request timeout
         */
        constructor(o) {
            this.write = o.write;
            this.onEvent = o.onEvent || (() => {});
            this.onUnmatched = o.onUnmatched || (() => {});
            this.onText = o.onText || (() => {});
            this.onTraffic = o.onTraffic || (() => {});
            this.timeoutMs = o.timeoutMs || 2000;
            // A random per-connection prefix: a late reply to a request of an earlier connection
            // (or of another program that used the port) can never match a pending request.
            this.idPrefix = o.idPrefix || randomPrefix();
            this.pending = new Map();
            this.watchers = new Set();
            this.nextId = 1;
            this.closed = false;
            this.framer = new LineFramer(line => this.handleLine(line), {
                onOverflow: () => this.onText("[configurator] discarded an over-long line from the device"),
            });
        }

        get pendingCount() { return this.pending.size; }

        handleText(text) {
            if (this.closed) return;
            this.framer.push(text);
        }

        allocId() {
            // Monotonic, never reused within a connection, at most 12 characters.
            let id = this.idPrefix + (this.nextId++).toString(36);
            if (id.length > C.LIMITS_CMM.REQUEST_ID_MAX_LEN) {
                this.idPrefix = randomPrefix();
                this.nextId = 1;
                id = this.idPrefix + (this.nextId++).toString(36);
            }
            return id;
        }

        /**
         * Sends `VERB args` with a fresh id and resolves with the correlated "ok" reply.
         * Rejects with ProtocolError: device_error (status error, `code` set), timeout,
         * write_failed, closed, invalid_reply, bad_request. The pending entry is always removed.
         * @param {object} [opts] { timeoutMs, expectType, validate(reply) -> problem string | null }
         */
        request(verb, args = [], opts = {}) {
            if (this.closed) return Promise.reject(new ProtocolError("closed", "Not connected"));
            const id = this.allocId();
            let line;
            try {
                line = formatLine(id, verb, args);
            } catch (err) {
                return Promise.reject(err);
            }
            return new Promise((resolve, reject) => {
                const entry = {
                    id, verb, args,
                    expected: C.expectedCmds(verb, args),
                    expectType: opts.expectType || null,
                    validate: opts.validate || null,
                    resolve, reject, timer: null,
                };
                this.pending.set(id, entry);
                const ms = opts.timeoutMs || this.timeoutMs;
                entry.timer = setTimeout(() => {
                    this._settle(id, new ProtocolError("timeout", `No reply to ${verb} within ${ms} ms`, { verb }));
                }, ms);
                this.onTraffic("tx", line);
                let written;
                try {
                    written = Promise.resolve(this.write(line + "\n"));
                } catch (err) {
                    written = Promise.reject(err);
                }
                written.catch(err => {
                    const msg = err && err.message ? err.message : String(err);
                    this._settle(id, new ProtocolError("write_failed", `Could not send ${verb}: ${msg}`, { verb, cause: err }));
                });
            });
        }

        // Writes a line without an id (only used to probe legacy firmware). Nothing is correlated.
        sendUntracked(verb) {
            if (this.closed) return Promise.reject(new ProtocolError("closed", "Not connected"));
            const line = formatLine(null, verb, []);
            this.onTraffic("tx", line);
            return Promise.resolve().then(() => this.write(line + "\n"));
        }

        // Resolves with the first parsed object (event or reply) matching `predicate`, or null.
        waitFor(predicate, timeoutMs) {
            return new Promise(resolve => {
                const w = { predicate, resolve, timer: null };
                w.timer = setTimeout(() => { this.watchers.delete(w); resolve(null); }, timeoutMs);
                this.watchers.add(w);
            });
        }

        handleLine(line) {
            this.onTraffic("rx", line);
            let obj;
            try {
                obj = JSON.parse(line);
            } catch (e) {
                this.onText(line);
                return;
            }
            if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
                this.onText(line);
                return;
            }
            for (const w of [...this.watchers]) {
                let hit = false;
                try { hit = !!w.predicate(obj); } catch (e) { hit = false; }
                if (hit) {
                    this.watchers.delete(w);
                    clearTimeout(w.timer);
                    w.resolve(obj);
                }
            }
            if (Object.prototype.hasOwnProperty.call(obj, "status")) {
                const id = typeof obj.id === "string" ? obj.id : null;
                const entry = id !== null ? this.pending.get(id) : undefined;
                if (!entry) {
                    this.onUnmatched(obj, id === null ? "no_id" : "unknown_id");
                    return;
                }
                const problem = this._checkReply(obj, entry);
                if (problem) {
                    this._settle(id, new ProtocolError("invalid_reply", `Unexpected reply to ${entry.verb}: ${problem}`, { verb: entry.verb, reply: obj }));
                } else if (obj.status === "error") {
                    const code = typeof obj.code === "string" ? obj.code : "";
                    this._settle(id, new ProtocolError("device_error", C.errorText(code, obj.msg), { verb: entry.verb, code, reply: obj }));
                } else {
                    this._settle(id, null, obj);
                }
                return;
            }
            if (typeof obj.type === "string") {
                this.onEvent(obj);
                return;
            }
            this.onUnmatched(obj, "unrecognised");
        }

        _checkReply(obj, entry) {
            if (obj.status !== "ok" && obj.status !== "error") return `status "${obj.status}"`;
            if (obj.status === "error") return null;   // reported with its code whatever "cmd" says
            if (!entry.expected.includes(obj.cmd)) return `cmd "${obj.cmd}" (expected ${entry.expected.join(" or ")})`;
            if (entry.expectType && obj.type !== entry.expectType) return `type "${obj.type}" (expected ${entry.expectType})`;
            if (entry.validate) {
                let problem;
                try { problem = entry.validate(obj); } catch (e) { problem = e.message; }
                if (problem) return problem;
            }
            return null;
        }

        _settle(id, err, reply) {
            const entry = this.pending.get(id);
            if (!entry) return false;
            this.pending.delete(id);
            clearTimeout(entry.timer);
            if (err) entry.reject(err);
            else entry.resolve(reply);
            return true;
        }

        // Rejects every pending request (kind "closed") and stops accepting new ones. Idempotent.
        close(reason) {
            if (this.closed) return;
            this.closed = true;
            const msg = reason || "Connection closed";
            for (const id of [...this.pending.keys()]) {
                this._settle(id, new ProtocolError("closed", msg));
            }
            for (const w of [...this.watchers]) {
                clearTimeout(w.timer);
                w.resolve(null);
            }
            this.watchers.clear();
            this.framer.reset();
        }
    }

    DP.protocol = Object.freeze({ ProtocolClient, ProtocolError, LineFramer, formatLine });
})(typeof window !== "undefined" ? window : globalThis);
