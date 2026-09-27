/*
 * transport.js - one WebSerial session: open, TextDecoder/TextEncoder pipes, reader loop, writer,
 * and an ordered, awaited, idempotent teardown.
 *
 * Teardown order (close()):
 *   1. cancel the reader (propagates through the decoder pipe to port.readable)
 *   2. wait for the reader loop to finish, release the reader lock
 *   3. close the writer (flush; abort instead if the device is gone or close fails), release it
 *   4. await both pipe promises so port.readable / port.writable are unlocked
 *   5. close the port
 * Every failure along the way is reported through `log` and returned in `errors`; none is
 * swallowed. Calling close() again (or concurrently) returns the same promise.
 *
 * The port is injectable ({ port }) so tests and the simulated device can use a fake SerialPort.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};

    const WRITER_CLOSE_TIMEOUT_MS = 1000;
    const PIPE_SETTLE_TIMEOUT_MS = 2000;

    function describe(err) {
        if (!err) return "unknown error";
        if (err.name && err.message) return `${err.name}: ${err.message}`;
        return String(err.message || err);
    }

    function withTimeout(promise, ms, what) {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    class SerialTransport {
        /**
         * @param {object} o
         * @param {object} [o.serial]   navigator.serial (or a fake with requestPort())
         * @param {object} [o.port]     an already chosen SerialPort (skips requestPort)
         * @param {number} [o.baudRate]
         * @param {(text:string)=>void} o.onText        decoded text as it arrives
         * @param {(info:{reason:string,error:any,errors:Array})=>void} [o.onClose]
         * @param {(level:string, msg:string)=>void} [o.log]
         */
        constructor(o) {
            this.serial = o.serial || null;
            this.port = o.port || null;
            this.baudRate = o.baudRate || 115200;
            this.onText = o.onText;
            this.onClose = o.onClose || (() => {});
            this.log = o.log || (() => {});
            this.state = "closed";      // closed | opening | open | closing
            this.portOpened = false;
            this.reader = null;
            this.writer = null;
            this.readPipe = null;
            this.writePipe = null;
            this.readLoopDone = null;
            this.cancelReason = null;
            this.closePromise = null;
            this.teardownSteps = [];    // step names in execution order (inspected by tests)
            this._onPortDisconnect = () => this._lost(new Error("The USB device was disconnected"));
        }

        get isOpen() { return this.state === "open"; }

        async open() {
            if (this.state !== "closed" || this.closePromise) throw new Error("This transport was already used; create a new one");
            this.state = "opening";
            try {
                if (!this.port) {
                    if (!this.serial) throw new Error("WebSerial is not available in this browser (use Chrome, Edge or Opera)");
                    this.port = await this.serial.requestPort();
                }
                await this.port.open({ baudRate: this.baudRate });
                this.portOpened = true;
            } catch (err) {
                this.state = "closed";
                this.closePromise = Promise.resolve({ reason: "open_failed", errors: [] });
                throw err;
            }

            const decoder = new TextDecoderStream();
            this.readPipe = this.port.readable.pipeTo(decoder.writable).then(
                () => ({ ok: true }), err => ({ ok: false, err }));
            this.reader = decoder.readable.getReader();

            const encoder = new TextEncoderStream();
            this.writePipe = encoder.readable.pipeTo(this.port.writable).then(
                () => ({ ok: true }), err => ({ ok: false, err }));
            this.writer = encoder.writable.getWriter();

            if (typeof this.port.addEventListener === "function") {
                this.port.addEventListener("disconnect", this._onPortDisconnect);
            }
            this.state = "open";
            this.readLoopDone = this._readLoop();
            // A failing sink (device gone) errors the write pipe; treat that as a lost connection.
            this.writePipe.then(r => { if (!r.ok && this.state === "open") this._lost(r.err); });
        }

        async _readLoop() {
            try {
                for (;;) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    if (value) this.onText(value);
                }
                if (this.state === "open") this._lost(new Error("The serial stream ended"));
            } catch (err) {
                if (this.state === "open") this._lost(err);
            }
        }

        async write(text) {
            if (this.state !== "open" || !this.writer) throw new Error("Not connected");
            await this.writer.write(text);
        }

        _lost(err) {
            if (this.state !== "open") return;
            this.log("error", `Connection lost: ${describe(err)}`);
            this.close({ reason: "lost", error: err });
        }

        // Idempotent and safe to call concurrently: every caller gets the same promise.
        close(opts = {}) {
            if (!this.closePromise) this.closePromise = this._teardown(opts.reason || "user", opts.error || null);
            return this.closePromise;
        }

        async _teardown(reason, error) {
            this.state = "closing";
            const errors = [];
            const lost = reason === "lost";
            const step = async (name, fn) => {
                this.teardownSteps.push(name);
                try {
                    await fn();
                } catch (err) {
                    errors.push({ step: name, error: err });
                    this.log(lost ? "info" : "warn", `Disconnect: ${name} failed: ${describe(err)}`);
                }
            };
            if (typeof this.port?.removeEventListener === "function") {
                this.port.removeEventListener("disconnect", this._onPortDisconnect);
            }

            // 1-2. reader
            if (this.reader) {
                this.cancelReason = new Error(`closing (${reason})`);
                await step("cancel reader", () => this.reader.cancel(this.cancelReason));
                if (this.readLoopDone) await this.readLoopDone;
                await step("release reader", () => this.reader.releaseLock());
            }
            // 3. writer
            if (this.writer) {
                if (lost) {
                    await step("abort writer", () => this.writer.abort(error || new Error("device lost")));
                } else {
                    let closed = true;
                    await step("close writer", async () => {
                        try {
                            await withTimeout(this.writer.close(), WRITER_CLOSE_TIMEOUT_MS, "writer close");
                        } catch (err) {
                            closed = false;
                            throw err;
                        }
                    });
                    if (!closed) await step("abort writer", () => this.writer.abort(new Error("close failed")));
                }
                await step("release writer", () => this.writer.releaseLock());
            }
            // 4. pipes
            if (this.readPipe || this.writePipe) {
                this.teardownSteps.push("await pipes");
                let results = [];
                try {
                    results = await withTimeout(Promise.all([this.readPipe, this.writePipe]), PIPE_SETTLE_TIMEOUT_MS, "pipe shutdown");
                } catch (err) {
                    errors.push({ step: "await pipes", error: err });
                    this.log("warn", `Disconnect: ${describe(err)}`);
                }
                const [r, w] = results;
                if (r && !r.ok && r.err !== this.cancelReason && !lost) {
                    errors.push({ step: "read pipe", error: r.err });
                    this.log("warn", `Disconnect: read pipe ended with ${describe(r.err)}`);
                }
                if (w && !w.ok && !lost) {
                    errors.push({ step: "write pipe", error: w.err });
                    this.log("warn", `Disconnect: write pipe ended with ${describe(w.err)}`);
                }
            }
            // 5. port
            if (this.port && this.portOpened) {
                await step("close port", () => this.port.close());
            }
            this.state = "closed";
            this.reader = this.writer = null;
            const info = { reason, error, errors };
            try {
                this.onClose(info);
            } catch (err) {
                this.log("error", `onClose handler failed: ${describe(err)}`);
            }
            return info;
        }
    }

    DP.transport = Object.freeze({ SerialTransport, describeError: describe });
})(typeof window !== "undefined" ? window : globalThis);
