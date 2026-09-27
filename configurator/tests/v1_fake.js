/*
 * v1_fake.js - a fake WebSerial port with a DriftPad running the pre-fix (protocol v1) firmware,
 * used only to run the OLD configurator pages (commit e2031e2) in defect-reproduction tests.
 *
 * Port semantics follow Chrome's SerialPort: open() once; readable/writable streams; close()
 * rejects while either stream is still locked (e.g. a pipe was never shut down), leaving the port
 * open. The device follows the v1 firmware: replies without ids, labels rewritten to [A-Za-z0-9_-],
 * no label echo, "Unknown command" for anything it does not know.
 */
(function (g) {
    "use strict";
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    class V1Device {
        constructor(opts = {}) {
            this.silent = !!opts.silent;              // never answers anything
            this.rejectSettings = !!opts.rejectSettings;
            this.holdSetKey = false;                  // queue SET_KEY replies until release()
            this.dropSetKey = false;                  // never answer SET_KEY
            this.strayOnSetKey = false;               // answer SET_KEY with nothing, but emit an unrelated reply
            this.lines = [];
            this.held = [];
            this.port = null;
            this.buf = "";
            this.actuation = 1.2;
            this.layers = [0, 1, 2].map(() => Array.from({ length: 16 }, (_, k) => ({ idx: k, code: 97 + k, label: "K" + k })));
        }
        feed(text) {
            this.buf += text;
            let i;
            while ((i = this.buf.search(/[\r\n]/)) >= 0) {
                const line = this.buf.slice(0, i).trim();
                this.buf = this.buf.slice(i + 1);
                if (line) this.onLine(line);
            }
        }
        send(obj) { if (this.port) this.port.emit(JSON.stringify(obj) + "\r\n"); }
        release() { const h = this.held; this.held = []; h.forEach(f => f()); }
        onLine(line) {
            this.lines.push(line);
            if (this.silent) return;
            const [verb, ...a] = line.split(/\s+/);
            if (verb === "PING") return this.send({ type: "pong" });
            if (verb === "GET_CONFIG") {
                return this.send({ type: "config", actuation: this.actuation, rt_sens: 0.2, rt_enabled: true, active_layer: 0, layers: this.layers });
            }
            if (verb === "SET_KEY") {
                if (this.dropSetKey) return;
                if (this.strayOnSetKey) return this.send({ status: "ok", msg: "unrelated" });
                const [l, k, code, label] = a.map((x, n) => (n < 3 ? parseInt(x, 10) : x));
                const reply = () => {
                    this.layers[l][k].code = code;
                    if (label) this.layers[l][k].label = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 4);
                    this.send({ status: "ok", msg: `Key L${l}:K${k} updated` });
                };
                if (this.holdSetKey) this.held.push(reply); else reply();
                return;
            }
            if (verb === "SET_ACTUATION") {
                if (this.rejectSettings) return this.send({ status: "error", msg: "Invalid actuation" });
                this.actuation = parseFloat(a[0]);
                return this.send({ status: "ok", msg: "Actuation set" });
            }
            if (/^(SET_|STREAM|SAVE|RESET)/.test(verb)) return this.send({ status: "ok", msg: verb });
            this.send({ status: "error", msg: "Unknown command" });
        }
    }

    class FakePort {
        constructor(device) {
            this.device = device;
            device.port = this;
            this.opened = false;
            this.rejectWrites = false;
            this.closeErrors = 0;
            this.readable = null;
            this.writable = null;
        }
        async open() {
            if (this.opened) throw new DOMException("The port is already open.", "InvalidStateError");
            this.opened = true;
            this.readable = new ReadableStream({ start: c => { this._ctrl = c; } });
            this.writable = new WritableStream({
                write: chunk => {
                    if (this.rejectWrites) throw new Error("The device has been lost.");
                    this.device.feed(dec.decode(chunk));
                },
            });
        }
        emit(text) { try { this._ctrl.enqueue(enc.encode(text)); } catch (e) { /* stream closed */ } }
        async close() {
            if (this.readable.locked || this.writable.locked) {
                this.closeErrors++;
                throw new TypeError("Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream");
            }
            this.opened = false;
        }
        addEventListener() {}
        removeEventListener() {}
    }

    g.V1Fake = {
        install(opts) {
            const device = new V1Device(opts);
            const port = new FakePort(device);
            Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port, getPorts: async () => [port] } });
            g.confirm = () => true;
            g.alert = () => {};
            return { device, port };
        },
    };
})(window);
