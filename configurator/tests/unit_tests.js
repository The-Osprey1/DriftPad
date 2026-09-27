/*
 * unit_tests.js - contract.js, keycodes.js, protocol.js and transport.js on their own.
 * Registered with harness.js; run by run.html (tests/test_configurator_js.py).
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad;
    const C = DP.contract;
    const K = DP.keycodes;
    const { ProtocolClient, ProtocolError, LineFramer, formatLine } = DP.protocol;

    // tests/fixtures/label_vectors.json, shared with the firmware's own label tests.
    function loadJson(relPath) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", relPath);
            xhr.onload = () => {
                try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error(`${relPath}: ${e.message}`)); }
            };
            xhr.onerror = () => reject(new Error(`could not read ${relPath} (run from file:// with --allow-file-access-from-files)`));
            xhr.send();
        });
    }

    // ------------------------------------------------------------------------------ contract
    test("contract: every shared label vector normalises exactly as the firmware does", async () => {
        const data = await loadJson("../../tests/fixtures/label_vectors.json");
        assert(data.vectors.length >= 20, "too few vectors");
        for (const v of data.vectors) {
            assertEq(C.normalizeLabel(v.in), v.out, `normalizeLabel(${JSON.stringify(v.in)})`);
            // A rejected label always has a plain-language reason; an accepted one has none
            // (lower case is accepted and upper-cased, so it is not a "problem").
            assertEq(C.labelProblem(v.in) === null, v.out !== null, `labelProblem(${JSON.stringify(v.in)})`);
        }
    });

    test("contract: millimetre values have exactly 2 decimals and stay inside the limits", () => {
        assertEq(C.formatMm(1.2), "1.20");
        assertEq(C.formatMm(0.1 + 0.2), "0.30");
        assertEq(C.parseMm("1.2"), 1.2);
        assertEq(C.parseMm(" 0.35 "), 0.35);
        for (const bad of ["1.234", "abc", "1,2", "-1", "1e1", ""]) assertEq(C.parseMm(bad), null, bad);
        const lim = C.FALLBACK_LIMITS.actuation;
        assertEq(C.mmProblem(1.2, lim), null);
        assertEq(C.mmProblem(lim.min, lim), null);
        assertEq(C.mmProblem(lim.max, lim), null);
        assert(C.mmProblem(1.234, lim).includes("2 decimals"));
        assert(C.mmProblem(lim.min - 0.01, lim).includes("between"));
        assert(C.mmProblem(lim.max + 0.01, lim).includes("between"));
        assert(C.mmProblem(NaN, lim));
        assert(C.sameMm(1.2, 1.2000000001));
        assert(!C.sameMm(1.2, 1.21));
    });

    test("contract: fallback limits are the settings_limits.h values in millimetres", () => {
        const L = C.LIMITS_CMM;
        assertEq(C.FALLBACK_LIMITS.actuation, { min: L.ACTUATION_MIN_CMM / 100, max: L.ACTUATION_MAX_CMM / 100,
            default: L.ACTUATION_DEFAULT_CMM / 100, step: L.UI_STEP_CMM / 100 });
        assertEq(C.FALLBACK_LIMITS.rt_sens, { min: L.RT_SENS_MIN_CMM / 100, max: L.RT_SENS_MAX_CMM / 100,
            default: L.RT_SENS_DEFAULT_CMM / 100, step: L.UI_STEP_CMM / 100 });
        assert(Object.isFrozen(C.FALLBACK_LIMITS.actuation), "limits must be immutable");
    });

    test("contract: reply cmd expectations cover aliases and two-word CAL commands", () => {
        assertEq(C.expectedCmds("HELLO", []), ["INFO"]);
        assertEq(C.expectedCmds("set_key", ["0"]), ["SET_KEY"]);
        assertEq(C.expectedCmds("CAL", ["start"]), ["CAL", "CAL_START"]);
    });

    test("contract: device error codes read as plain language with the device detail", () => {
        assertEq(C.errorText("busy", ""), C.ERROR_CODES.busy);
        assertEq(C.errorText("busy", "calibration is running"), `${C.ERROR_CODES.busy} (calibration is running)`);
        assertEq(C.errorText("new_code", "detail"), "detail");
        assertEq(C.errorText("new_code", ""), "Device error: new_code");
    });

    // ------------------------------------------------------------------------------ keycodes
    test("keycodes: assignable codes mirror the firmware rule", () => {
        const expected = code => code === 0 || code === 8 || code === 9 || code === 10 || (code >= 32 && code <= 126) ||
            (code >= 128 && code <= 135) || code >= 140;
        for (let c = 0; c <= 255; c++) assertEq(K.isAssignable(c), expected(c), `code ${c}`);
        for (const bad of [-1, 256, 1.5, "65", null]) assertEq(K.isAssignable(bad), false, String(bad));
        // The fake device implements the rule independently; both must agree.
        for (let c = 0; c <= 255; c++) assertEq(DP.fake.fwCodeOk(c), K.isAssignable(c), `fake vs keycodes, code ${c}`);
    });

    test("keycodes: every catalog entry and default key is assignable with a valid label", () => {
        for (const k of K.CATALOG) {
            assert(K.isAssignable(k.code), `${k.name} (code ${k.code}) is not assignable`);
            assertEq(C.normalizeLabel(k.label), k.label, `${k.name} label ${k.label}`);
        }
        const maps = K.defaultKeymaps();
        assertEq(maps.length, 3);
        maps.forEach((layer, l) => {
            assertEq(layer.length, C.NUM_KEYS);
            layer.forEach((key, i) => {
                assert(K.isAssignable(key.code), `default layer ${l} key ${i}`);
                assertEq(C.normalizeLabel(key.label), key.label, `default layer ${l} key ${i} label`);
            });
        });
        maps[0][0].label = "X";
        assert(K.defaultKeymaps()[0][0].label !== "X", "defaultKeymaps() must return a fresh copy");
    });

    // ------------------------------------------------------------------------------ framing
    test("framing: CRLF split across chunks counts once; blank lines are ignored", () => {
        const lines = [];
        const f = new LineFramer(l => lines.push(l));
        f.push('{"a":1}\r');
        f.push('\n{"b"');
        f.push(':2}\n\n\r\n  \n');
        f.push("tail");
        assertEq(lines, ['{"a":1}', '{"b":2}']);
        f.push("\n");
        assertEq(lines, ['{"a":1}', '{"b":2}', "tail"]);
    });

    test("framing: an over-long line is discarded whole, never delivered truncated", () => {
        const lines = [];
        let overflows = 0;
        const f = new LineFramer(l => lines.push(l), { maxLineChars: 10, onOverflow: () => overflows++ });
        f.push("0123456789ABCDEF");
        f.push("GHIJ\nok\n");
        assertEq(lines, ["ok"]);
        assertEq(overflows, 1);
    });

    test("formatLine: builds @id lines and refuses what the device would reject", () => {
        assertEq(formatLine("ab1", "SET_KEY", [0, 5, 241, "F14"]), "@ab1 SET_KEY 0 5 241 F14");
        assertEq(formatLine(null, "PING", []), "PING");
        const bad = [
            () => formatLine("has space", "INFO", []),
            () => formatLine("x".repeat(13), "INFO", []),
            () => formatLine("a1", "SET KEY", []),
            () => formatLine("a1", "SET_KEY", ["A B"]),
            () => formatLine("a1", "SET_KEY", ["É"]),
            () => formatLine("a1", "SET_KEY", ["x".repeat(200)]),
        ];
        bad.forEach((fn, i) => {
            let err = null;
            try { fn(); } catch (e) { err = e; }
            assert(err instanceof ProtocolError && err.kind === "bad_request", `case ${i} must be bad_request`);
        });
    });

    // ------------------------------------------------------------------------------ correlation
    function client(opts = {}) {
        const sent = [];
        const events = [];
        const unmatched = [];
        const c = new ProtocolClient(Object.assign({
            write: text => { sent.push(text); return Promise.resolve(); },
            onEvent: ev => events.push(ev),
            onUnmatched: (obj, why) => unmatched.push(why),
            timeoutMs: 200,
            idPrefix: "t",
        }, opts));
        const lastId = () => /^@(\S+)/.exec(sent[sent.length - 1])[1];
        return { c, sent, events, unmatched, lastId };
    }
    const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));

    test("correlation: only a reply carrying the request's id resolves it", async () => {
        const { c, events, unmatched, lastId } = client();
        const p = settle(c.request("SET_KEY", [0, 1, 98, "B"]));
        const id = lastId();
        c.handleText('{"status":"ok","cmd":"SET_KEY","layer":0,"key":1,"code":98,"label":"B"}\n');            // no id
        c.handleText('{"status":"ok","id":"other1","cmd":"SET_KEY","layer":0,"key":1,"code":98,"label":"B"}\n'); // someone else's
        c.handleText('{"type":"telemetry","keys":[]}\n');                                                        // an event
        c.handleText("plain log text\n");
        assertEq(c.pendingCount, 1, "nothing above may resolve the request");
        assertEq(unmatched, ["no_id", "unknown_id"]);
        assertEq(events.length, 1);
        c.handleText(`{"status":"ok","id":"${id}","cmd":"SET_KEY","layer":0,"key":1,"code":98,"label":"B"}\n`);
        const r = await p;
        assert(r.ok, "the correlated reply resolves it");
        assertEq(r.v.code, 98);
    });

    test("correlation: a reply for the right id but another command is invalid, not accepted", async () => {
        const { c, lastId } = client();
        const p = settle(c.request("SET_KEY", [0, 1, 98]));
        c.handleText(`{"status":"ok","id":"${lastId()}","cmd":"SET_LAYER","active_layer":1}\n`);
        const r = await p;
        assert(!r.ok && r.e.kind === "invalid_reply", `got ${r.ok ? "ok" : r.e.kind}`);
    });

    test("correlation: device errors keep their code; the pending entry is always removed", async () => {
        const { c, lastId } = client();
        const p = settle(c.request("SET_ACTUATION", ["9.99"]));
        c.handleText(`{"status":"error","id":"${lastId()}","cmd":"SET_ACTUATION","code":"out_of_range","msg":"x","min":0.25,"max":3.80}\n`);
        const r = await p;
        assertEq([r.ok, r.e.kind, r.e.code], [false, "device_error", "out_of_range"]);
        assertEq(c.pendingCount, 0);
    });

    test("correlation: a timeout rejects, and a late reply afterwards resolves nothing", async () => {
        const { c, unmatched, lastId } = client();
        const p = settle(c.request("INFO", [], { timeoutMs: 50 }));
        const id = lastId();
        const r = await p;
        assertEq([r.ok, r.e.kind], [false, "timeout"]);
        c.handleText(`{"status":"ok","id":"${id}","cmd":"INFO","type":"info"}\n`);
        assertEq(unmatched, ["unknown_id"]);
    });

    test("correlation: a failed write rejects at once with write_failed", async () => {
        const { c } = client({ write: () => Promise.reject(new Error("port gone")) });
        const r = await settle(c.request("INFO"));
        assertEq([r.ok, r.e.kind], [false, "write_failed"]);
        assertEq(c.pendingCount, 0);
    });

    test("correlation: close() rejects every pending request and refuses new ones", async () => {
        const { c } = client();
        const a = settle(c.request("INFO"));
        const b = settle(c.request("STATUS"));
        c.close("Disconnected");
        const [ra, rb] = await Promise.all([a, b]);
        assertEq([ra.e.kind, rb.e.kind], ["closed", "closed"]);
        const rc = await settle(c.request("INFO"));
        assertEq(rc.e.kind, "closed");
    });

    test("correlation: ids are unique, at most 12 characters, and differ between connections", () => {
        const { c } = client({ idPrefix: undefined });
        const seen = new Set();
        c.nextId = 36 ** 9 - 1500;   // 3 + 9 characters: the rollover to a new prefix happens mid-loop
        for (let i = 0; i < 3000; i++) {
            const id = c.allocId();
            assert(C.REQUEST_ID_RE.test(id), `bad id ${id}`);
            assert(!seen.has(id), `id ${id} reused`);
            seen.add(id);
        }
        const prefixes = new Set(Array.from({ length: 20 }, () => new ProtocolClient({ write: () => {} }).idPrefix));
        assert(prefixes.size > 1, "each connection should get its own random id prefix");
    });

    // ------------------------------------------------------------------------------ transport
    function transportWith(portOpts = {}) {
        const sim = DP.fake.createSimulation(portOpts);
        const text = [];
        const closes = [];
        const logs = [];
        const t = new DP.transport.SerialTransport({
            serial: sim.serial, onText: s => text.push(s), onClose: info => closes.push(info), log: (lvl, msg) => logs.push([lvl, msg]),
        });
        return { sim, t, text, closes, logs };
    }

    test("transport: close tears down in order and leaves the port closed and unlocked", async () => {
        const { sim, t, closes } = transportWith();
        await t.open();
        await t.write("@x1 PING\n");
        await sleep(20);
        const info = await t.close();
        assertEq(t.teardownSteps, ["cancel reader", "release reader", "close writer", "release writer", "await pipes", "close port"]);
        assertEq(info.errors, []);
        assertEq(sim.port.isOpen, false);
        assert(sim.port.events.includes("readable-cancel") && sim.port.events.includes("writable-close"), sim.port.events.join(","));
        assertEq(closes.length, 1);
        assertEq(closes[0].reason, "user");
    });

    test("transport: close is idempotent and concurrent calls share one teardown", async () => {
        const { t, closes } = transportWith();
        await t.open();
        const a = t.close();
        const b = t.close();
        assert(a === b, "same promise");
        await a;
        await t.close();
        assertEq(closes.length, 1);
        let err = null;
        try { await t.write("x\n"); } catch (e) { err = e; }
        assert(err, "writing after close must fail");
    });

    test("transport: a port close error is reported, not swallowed", async () => {
        const { sim, t, logs } = transportWith();
        await t.open();
        sim.port.faults.closeError = new Error("close exploded");
        const info = await t.close();
        assertEq(info.errors.map(e => e.step), ["close port"]);
        assert(logs.some(([lvl, msg]) => lvl === "warn" && msg.includes("close exploded")), JSON.stringify(logs));
    });

    test("transport: unplugging reports a lost connection once", async () => {
        const { sim, t, closes } = transportWith();
        await t.open();
        sim.port.unplug();
        await waitUntil(() => closes.length === 1);
        await sleep(50);
        assertEq(closes.length, 1);
        assertEq(closes[0].reason, "lost");
        assertEq(t.isOpen, false);
    });

    test("transport: a chooser cancelled by the user rejects open() with NotFoundError", async () => {
        const { sim, t } = transportWith();
        sim.serial.cancelChooser = true;
        let err = null;
        try { await t.open(); } catch (e) { err = e; }
        assertEq(err && err.name, "NotFoundError");
    });
})(window);
