/*
 * session_tests.js - DeviceSession (device.js), KeymapSync / SettingsSync / Draft (draft.js) and
 * backups (backup.js) over the real SerialTransport, against the fake DriftPad (fake_device.js).
 *
 * The first group are the new-app equivalents of the defects reproduced on the old pages
 * (prefix_defects.js); the rest cover partial application, stream teardown, fresh read-back,
 * connection states, telemetry, persistence, calibration and backups.
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad;
    const C = DP.contract;
    const FAST = { request: 300, identify: 300, legacyProbe: 250, save: 600, raw: 1500 };

    async function rig(opts = {}) {
        const sim = DP.fake.createSimulation(opts.device || {});
        const session = new DP.device.DeviceSession({
            createTransport: h => new DP.transport.SerialTransport({ serial: sim.serial, onText: h.onText, onClose: h.onClose, log: h.log }),
            timeouts: Object.assign({}, FAST, opts.timeouts || {}),
        });
        const states = [];
        session.on("conn", c => states.push(c.state));
        const draft = new DP.draft.Draft({ storage: opts.storage === undefined ? null : opts.storage });
        const keymap = new DP.draft.KeymapSync(draft, session);
        const settings = new DP.draft.SettingsSync(session);
        if (opts.before) opts.before(sim.device, draft);
        if (opts.connect !== false) {
            await session.connect();
            assertEq(session.conn.state, "connected", "rig: connect");
        }
        const verbs = () => sim.device.verbs();
        const countVerb = v => verbs().filter(x => x === v).length;
        return { sim, device: sim.device, port: sim.port, session, draft, keymap, settings, states, verbs, countVerb };
    }
    const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
    const key = (code, label) => ({ code, label });

    // ============================================================ the reviewed defects, new app
    test("defect keymap_edit_during_write: an edit made while its write is pending stays pending", async () => {
        const { device, session, draft, keymap } = await rig();
        device.faults.delayMs.SET_KEY = 80;
        draft.set(0, 0, 98, "A1");
        const p = keymap.writeChanges();
        await waitUntil(() => keymap.inFlight.size === 1);
        assertEq(keymap.syncState(), "writing");
        draft.set(0, 0, 98, "B2");        // the user keeps typing while the write is pending
        draft.set(0, 7, 99, "C3");        // and edits another key
        await p;
        assertEq(session.confirmed.layers[0][0], key(98, "A1"), "confirmed holds what was sent and acknowledged");
        assertEq(device.state.layers[0][7].label, "6", "a key edited during the write is not swept into it");
        assertEq(keymap.pendingList(), [{ l: 0, k: 0 }, { l: 0, k: 7 }]);
        assertEq(keymap.syncState(), "pending");
        await keymap.writeChanges();
        assertEq(keymap.syncState(), "in_sync");
        assertEq(device.state.layers[0][0], key(98, "B2"));
    });

    test("defect keymap_write_rejected: a failed port write finalizes the write and never leaves it stuck", async () => {
        const { port, session, draft, keymap } = await rig();
        draft.set(0, 0, 98, "A1");
        draft.set(0, 1, 99, "B1");
        port.faults.rejectWrites = true;
        const r = await settle(keymap.writeChanges());
        assert(!r.ok, "the write must fail");
        assertEq(keymap.writing, false, "writing flag");
        assertEq(keymap.inFlight.size, 0);
        assertEq(r.e.result.failed.length, 1);
        assertEq(r.e.result.skipped.length, 1, "the other key is not attempted and says so");
        await waitUntil(() => session.conn.state === "lost");
        assertEq(session.conn.state, "lost", "a port that rejects writes is a lost connection");
        // A loss clears every per-connection record; none may be left pending.
        assert(Object.values(session.ops).every(o => o.state !== "pending"), JSON.stringify(session.ops));
        assertEq(draft.get(0, 0), key(98, "A1"), "the edit is kept");
    });

    test("defect keymap_disconnect_teardown: disconnect closes the port and reports teardown problems", async () => {
        const { port, session } = await rig();
        await session.disconnect();
        assertEq(session.conn.state, "disconnected");
        assertEq(port.isOpen, false, "port closed");
        assert(port.events.includes("close"), port.events.join(","));
        // A failing close is reported (log + status detail), not swallowed.
        const b = await rig();
        b.port.faults.closeError = new Error("close exploded");
        const logs = [];
        b.session.on("log", e => logs.push(e));
        await b.session.disconnect();
        assert(b.session.conn.detail.includes("teardown problem"), b.session.conn.detail);
        assert(logs.some(e => e.msg.includes("close exploded")), "logged");
    });

    test("defect keymap_label_rule: labels follow the firmware rule; another stored label is a mismatch", async () => {
        const { device, session, draft, keymap } = await rig();
        let err = null;
        try { draft.set(0, 1, 98, "n_/x"); draft.set(0, 1, 98, "n/"); } catch (e) { err = e; }
        assertEq(err, null);
        assertEq(draft.get(0, 1).label, "N/", "normalised exactly like the firmware (no '/' to '_' rewrite)");
        await keymap.writeChanges();
        assertEq(device.state.layers[0][1].label, "N/");
        assertEq(keymap.syncState(), "in_sync");
        // A device that stores a different label than sent is never shown as in sync.
        device.faults.labelOverride = l => l.replace("/", "_");
        draft.set(0, 2, 98, "A/");
        const r = await settle(keymap.writeChanges());
        assert(!r.ok, "a mismatch fails the write");
        assertEq(r.e.result.mismatched.length, 1);
        assertEq(keymap.keyState(0, 2).mismatch.stored, key(98, "A_"));
        assertEq(session.confirmed.layers[0][2], key(98, "A_"), "confirmed is what the device reported");
        assertEq(keymap.syncState(), "pending");
        for (const bad of ["a b", "É", "ABCDE", "@x", ""]) {
            let e2 = null;
            try { draft.set(0, 3, 98, bad); } catch (e) { e2 = e; }
            assert(e2, `label ${JSON.stringify(bad)} must be refused`);
        }
    });

    test("defect keymap_load_is_stale: Load sends a fresh GET_CONFIG and adopts what the device holds now", async () => {
        const { device, draft, keymap, countVerb } = await rig();
        device.externalEdit(s => { s.layers[0][2] = key(120, "NEW"); });   // changed on the pad (knob menu)
        const before = countVerb("GET_CONFIG");
        await keymap.loadFromDevice();
        assertEq(countVerb("GET_CONFIG"), before + 1);
        assertEq(draft.get(0, 2), key(120, "NEW"));
        assertEq(keymap.syncState(), "in_sync");
    });

    test("defect keymap_no_telemetry_request: live key state is requested (STREAM 1) while wanted", async () => {
        const { device, session, countVerb } = await rig();
        session.wantTelemetry("keys", true);
        await waitUntil(() => session.telemetry.active);
        assertEq(countVerb("STREAM"), 1);
        assert(device.streaming, "the device streams");
    });

    test("defect keymap_stray_reply_accepted: unrelated and id-less replies never confirm a write", async () => {
        const { device, port, session, draft, keymap } = await rig();
        device.faults.drop.SET_KEY = 1;              // the device never applies it and never answers
        draft.set(0, 3, 98, "XX");
        const p = settle(keymap.writeChanges());
        await waitUntil(() => device.received.some(l => l.includes("SET_KEY")));
        const unmatched = session.counters.unmatched;
        port.inject('{"status":"ok","cmd":"SET_KEY","layer":0,"key":3,"code":98,"label":"XX","applied":true}\r\n');
        port.inject('{"status":"ok","id":"zzz9","cmd":"SET_KEY","layer":0,"key":3,"code":98,"label":"XX","applied":true}\r\n');
        const r = await p;
        assert(!r.ok, "no correlated reply: the write fails (timeout)");
        assertEq(r.e.result.failed[0].error.kind, "timeout");
        assertEq(session.counters.unmatched, unmatched + 2, "both stray replies were ignored");
        assertEq(device.state.layers[0][3].label, "9");
        assertEq(keymap.keyState(0, 3).pending, true, "still pending against the re-read device state");
    });

    test("defect keymap_unidentified_device / index_unidentified_device: silence is never 'connected'", async () => {
        const { session, states, port } = await rig({ device: { mode: "silent" }, connect: false });
        const p = session.connect();
        await waitUntil(() => session.conn.state === "identifying");
        assertEq(session.isConnected, false, "not connected while identifying");
        await p;
        assertEq(session.conn.state, "not_driftpad");
        assert(!states.includes("connected"), states.join(","));
        assertEq(port.isOpen, false, "the port is released");
    });

    test("defect index_optimistic_setting: a rejected value is never shown as the device value", async () => {
        const { device, settings } = await rig();
        device.faults.forceError.SET_ACTUATION = "busy";
        settings.set("actuation", 2.0);
        const r = await settle(settings.apply());
        assert(!r.ok);
        assertEq(settings.confirmedValue("actuation"), 1.2, "confirmed is unchanged");
        assert(settings.errors.get("actuation").includes("busy"), settings.errors.get("actuation"));
        assertEq(settings.isPending("actuation"), true, "the edit stays visible as not applied");
        assertEq(device.state.actuationCmm, 120);
    });

    // index_layer_view_writes is an app-level behaviour: see app_tests.js.

    // ============================================================ connection states
    test("connection: 'connected' comes only after INFO, with the device's limits and features", async () => {
        const { session, states, verbs } = await rig();
        assertEq(states.slice(0, 3), ["connecting", "identifying", "connected"]);
        assertEq(verbs().slice(0, 3), ["INFO", "GET_CONFIG", "STATUS"]);
        assertEq(session.info.protocol, 2);
        assertEq(session.limitsSource, "device");
        assertEq(session.limits.actuation.min, C.FALLBACK_LIMITS.actuation.min);
        assertEq(session.info.features, C.FEATURES.slice());
        assert(session.statusText.startsWith("Connected: DriftPad fw "), session.statusText);
    });

    test("connection: legacy, foreign and newer devices are named, and nothing but INFO/PING is sent", async () => {
        const cases = [["v1", "legacy"], ["foreign", "not_driftpad"], ["other", "not_driftpad"], ["v3", "unsupported"]];
        for (const [mode, expected] of cases) {
            const { device, port, session } = await rig({ device: { mode }, connect: false });
            await session.connect();
            assertEq(session.conn.state, expected, mode);
            assert(device.verbs().every(v => v === "INFO" || v === "PING"), `${mode} sent ${device.verbs().join(",")}`);
            assertEq(port.isOpen, false, `${mode}: port released`);
            assertEq(session.isConnected, false);
        }
    });

    test("connection: cancelling the port chooser changes nothing; an open failure says why", async () => {
        const a = await rig({ connect: false });
        a.sim.serial.cancelChooser = true;
        await a.session.connect();
        assertEq(a.session.conn.state, "idle");
        const b = await rig({ connect: false });
        b.port.faults.openError = new DOMException("The port is in use by another program.", "NetworkError");
        await b.session.connect();
        assertEq(b.session.conn.state, "disconnected");
        assert(b.session.conn.detail.includes("in use"), b.session.conn.detail);
    });

    test("connection: a device that is unplugged and plugged back in can be connected again", async () => {
        const { port, session } = await rig();
        port.unplug();
        await waitUntil(() => session.conn.state === "lost");
        assertEq(session.confirmed, null, "no stale device state after a loss");
        port.replug();
        await session.connect();
        assertEq(session.conn.state, "connected");
        assert(session.confirmed, "read again");
    });

    // ============================================================ partial application
    test("partial application: a key the device rejects is reported; the other keys still apply", async () => {
        const { device, draft, keymap } = await rig();
        device.faults.setKeyError["0:1"] = "invalid_code";
        draft.set(0, 0, 98, "A");
        draft.set(0, 1, 99, "B");
        draft.set(0, 2, 100, "C");
        const r = await settle(keymap.writeChanges());
        assert(!r.ok);
        assertEq(r.e.result.written.map(w => w.k), [0, 2]);
        assertEq(r.e.result.failed.map(f => f.k), [1]);
        assertEq(keymap.pendingList(), [{ l: 0, k: 1 }]);
        assert(keymap.keyState(0, 1).error.includes("does not produce a key"), keymap.keyState(0, 1).error);
        assertEq([device.state.layers[0][0].label, device.state.layers[0][2].label], ["A", "C"]);
    });

    test("partial application: a key whose reply was lost is settled by re-reading, not by assuming", async () => {
        const { device, draft, keymap, countVerb } = await rig();
        device.faults.wrongId.SET_KEY = "lost1";     // the device applies it, but the reply cannot be matched
        draft.set(0, 4, 98, "Q1");
        draft.set(0, 5, 99, "Q2");
        const before = countVerb("GET_CONFIG");
        const r = await settle(keymap.writeChanges());
        assertEq(countVerb("GET_CONFIG"), before + 1, "re-read after the unanswered write");
        assert(r.ok, `the read-back shows the key applied: ${r.ok ? "" : r.e.message}`);
        assertEq(r.v.written[0].confirmedBy, "readback");
        assertEq(r.v.skipped.length, 1, "the remaining key waits for the next write");
        assertEq(keymap.keyState(0, 4).error, null);
        assertEq(keymap.pendingList(), [{ l: 0, k: 5 }]);
    });

    test("partial application: a setting whose reply was lost is settled by re-reading", async () => {
        const { device, session, settings } = await rig();
        device.faults.wrongId.SET_ACTUATION = "lost2";
        settings.set("actuation", 1.75);
        const r = await settle(settings.apply());
        assert(r.ok, r.ok ? "" : r.e.message);
        assertEq(session.confirmed.actuation, 1.75);
        assertEq(settings.isPending("actuation"), false);
        assertEq(settings.errors.size, 0);
    });

    // ============================================================ stream teardown
    test("teardown: unplugging mid-write rejects what was pending and finalizes the write", async () => {
        const { device, port, session, draft, keymap } = await rig();
        device.faults.delayMs.SET_KEY = 100;
        draft.set(1, 0, 98, "A");
        draft.set(1, 1, 99, "B");
        draft.set(1, 2, 100, "C");
        const p = settle(keymap.writeChanges());
        await waitUntil(() => keymap.inFlight.size === 1);
        port.unplug();
        const r = await p;
        assert(!r.ok);
        assertEq(r.e.result.failed[0].error.kind, "closed");
        assertEq(r.e.result.skipped.length, 2);
        assertEq([keymap.writing, keymap.inFlight.size], [false, 0]);
        assert(Object.values(session.ops).every(o => o.state !== "pending"), "no operation left pending");
        assertEq(session.conn.state, "lost");
        assertEq(keymap.syncState(), "offline");
        assertEq(draft.get(1, 2), key(100, "C"), "edits survive the loss");
    });

    test("teardown: a raw capture in progress is rejected when the device goes away", async () => {
        const { port, session } = await rig();
        const full = await session.raw(3);
        assertEq(full.samples.length, 1000);
        assert(full.samples.every(v => Number.isInteger(v)), "every chunk arrived");
        const p = settle(session.raw(4));
        await sleep(3);
        port.unplug();
        const r = await p;
        assert(!r.ok && r.e.kind === "closed", r.ok ? "resolved" : r.e.kind);
    });

    test("teardown: disconnect unsubscribes telemetry before closing; nothing streams afterwards", async () => {
        const { device, port, session, verbs } = await rig();
        session.wantTelemetry("keys", true);
        await waitUntil(() => session.telemetry.active);
        await session.disconnect();
        const streams = device.received.filter(l => l.includes("STREAM"));
        assert(streams[streams.length - 1].endsWith("STREAM 0"), streams.join(" | "));
        assertEq(device.streaming, false);
        assertEq(port.isOpen, false);
        assertEq(verbs()[verbs().length - 1], "STREAM");
        const frames = session.telemetry.frames;
        await sleep(200);
        assertEq(session.telemetry.frames, frames, "no frames after disconnect");
    });

    // ============================================================ telemetry
    test("telemetry: firmware frames update pressed keys and travel (masks and centi-mm)", async () => {
        const { device, session } = await rig();
        session.wantTelemetry("keys", true);
        await waitUntil(() => session.telemetry.active);
        device.pressKey(5, 2.0);
        assert(await waitUntil(() => session.telemetry.pressed[5]), "key 5 shown pressed");
        assertEq(session.telemetry.travel[5], 2.0);
        assertEq(session.telemetry.pressed.filter(Boolean).length, 1);
        device.releaseKey(5);
        assert(await waitUntil(() => !session.telemetry.pressed[5]), "key 5 released");
    });

    test("telemetry: subscribed only while wanted and visible; frames while unsubscribed are ignored", async () => {
        const { device, port, session, countVerb } = await rig();
        port.inject('{"type":"telemetry","seq":1,"t":1,"layer":0,"pressed":1,"active":0,"sim":0,"travel":[400,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"dirty":false}\r\n');
        await sleep(20);
        assertEq([session.telemetry.frames, session.telemetry.pressed[0]], [0, false], "unrequested frame ignored");
        session.wantTelemetry("keys", true);
        await waitUntil(() => session.telemetry.active);
        session.setPageVisible(false);
        await waitUntil(() => !session.telemetry.active);
        assertEq(device.streaming, false, "hidden page: STREAM 0");
        session.setPageVisible(true);
        await waitUntil(() => session.telemetry.active);
        session.wantTelemetry("keys", false);
        await waitUntil(() => !session.telemetry.active);
        assertEq(countVerb("STREAM"), 4);
        assertEq(session.telemetry.pressed.some(Boolean), false);
    });

    test("telemetry: only the documented frame shape is accepted", () => {
        const p = DP.device.parseTelemetry;
        const t = p({ type: "telemetry", pressed: 0b101, active: 0b1, sim: 0b100, travel: [250, 0, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
        assertEq(t.pressed.slice(0, 3), [true, false, true]);
        assertEq(t.sending.slice(0, 3), [true, false, false]);
        assertEq(t.travel.slice(0, 3), [2.5, 0, 1.2]);
        assertEq(t.simMask, 4);
        assertEq(p({ type: "telemetry", pressed: [true], travel: [] }), null);
        assertEq(p({ type: "telemetry", pressed: 1, travel: [1, 2] }), null);
        assertEq(p({ type: "telemetry", keys: [{ idx: 0, pressed: true }] }), null);
    });

    // ============================================================ settings
    test("settings: shown as applied only after the device confirms, then the edit follows the device", async () => {
        const { device, session, settings } = await rig();
        settings.set("actuation", 1.5);
        assertEq([settings.isPending("actuation"), settings.confirmedValue("actuation")], [true, 1.2]);
        await settings.apply();
        assertEq([session.confirmed.actuation, device.state.actuationCmm, settings.edits.actuation], [1.5, 150, null]);
        assertEq(session.dirty, true, "applied, not saved");
    });

    test("settings: an edit made while its apply is in flight stays pending", async () => {
        const { device, session, settings } = await rig();
        device.faults.delayMs.SET_ACTUATION = 80;
        settings.set("actuation", 1.5);
        const p = settings.apply();
        await waitUntil(() => settings.inFlight.has("actuation"));
        settings.set("actuation", 1.6);
        await p;
        assertEq(session.confirmed.actuation, 1.5);
        assertEq([settings.isPending("actuation"), settings.value("actuation")], [true, 1.6]);
    });

    test("settings: out-of-range and over-precise values are refused locally; nothing is sent", async () => {
        const { settings, countVerb } = await rig();
        for (const v of [9.99, 0.01, 1.234]) {
            settings.set("actuation", v);
            const r = await settle(settings.apply());
            assert(!r.ok, `${v} must be refused`);
        }
        assertEq(countVerb("SET_ACTUATION"), 0);
    });

    // ============================================================ persistence
    test("save: succeeds only on persisted:true with slot and seq; a flash failure is an error", async () => {
        const { device, session, settings } = await rig();
        settings.set("rt_sens", 0.4);
        await settings.apply();
        const saved = await session.save();
        assertEq([saved.persisted, saved.slot, saved.seq], [true, "slot_a", 1]);
        assertEq(session.dirty, false);
        settings.set("rt_sens", 0.5);
        await settings.apply();
        device.faults.saveError = "flash_verify_failed";
        const r = await settle(session.save());
        assert(!r.ok);
        assertEq([r.e.kind, r.e.code], ["device_error", "flash_verify_failed"]);
        assertEq([session.dirty, session.opState("save")], [true, "failed"]);
    });

    test("revert: goes back to the saved settings, confirmed by a fresh read", async () => {
        const { session, settings, countVerb } = await rig();
        settings.set("actuation", 1.5);
        await settings.apply();
        await session.save();
        settings.set("actuation", 1.8);
        await settings.apply();
        const before = countVerb("GET_CONFIG");
        await session.revert();
        assertEq(countVerb("GET_CONFIG"), before + 1);
        assertEq([session.confirmed.actuation, session.dirty], [1.5, false]);
    });

    // ============================================================ calibration and output
    test("calibration: progress is reported, finishing early is refused, and the run ends valid", async () => {
        const { device, session } = await rig({ device: { calibration: "missing" } });
        await session.calStart();
        await waitUntil(() => session.cal && session.cal.phase === "travel");
        const early = await settle(session.calFinish());
        assertEq([early.ok, early.ok || early.e.code], [false, "calibration_incomplete"]);
        assertEq(session.cal.missing.length, 16);
        for (let k = 0; k < 16; k++) { device.pressKey(k, 3.9); device.releaseKey(k); }
        assert(await waitUntil(() => session.cal.done.length === 16), `done: ${session.cal.done}`);
        await session.calFinish();
        assertEq(session.deviceStatus.calibration.state, "valid");
        assertEq(session.cal.active, false);
    });

    test("calibration: a key that moves during the rest phase fails the run; the old state is kept", async () => {
        const { device, session } = await rig({ device: { calibration: "missing" } });
        device.faults.restFailKeys = [3];
        await session.calStart();
        await waitUntil(() => session.cal && session.cal.phase === "failed");
        assertEq(session.cal.failed, [3]);
        await waitUntil(() => session.opState("status") === "succeeded");
        assertEq(session.deviceStatus.calibration.state, "missing");
    });

    test("output: turning keyboard output on needs calibration unless forced", async () => {
        const { session } = await rig({ device: { calibration: "missing" } });
        const r = await settle(session.setOutput(true, false));
        assertEq(r.ok || r.e.code, "calibration_required");
        const forced = await session.setOutput(true, true);
        assertEq([forced.enabled, forced.reason], [true, "forced"]);
    });

    // ============================================================ backup and restore
    function editSomething(draft, settings) {
        draft.set(0, 0, 98, "BK");
        draft.set(2, 15, 241, "F14");
        settings.set("actuation", 2.25);
        settings.set("rt_enabled", false);
    }

    test("backup: round-trips to another pad and is verified by a fresh read-back", async () => {
        const a = await rig();
        editSomething(a.draft, a.settings);
        await a.keymap.writeChanges();
        await a.settings.apply();
        const file = DP.backup.create(a.session);
        assert(!("calibration" in file) && !("calibration" in file.settings), "calibration is never in a backup");
        const text = JSON.stringify(file);
        const parsed = DP.backup.parse(text, a.session.limits);
        assertEq([parsed.kind, parsed.problems], ["full", []]);
        const b = await rig();
        const before = b.countVerb("GET_CONFIG");
        const res = await DP.backup.restore(b.session, parsed);
        assertEq([res.failed, res.mismatched], [[], []]);
        assertEq(b.countVerb("GET_CONFIG"), before + 1, "fresh read-back after restoring");
        assertEq(JSON.stringify(b.device.state.layers), JSON.stringify(a.device.state.layers));
        assertEq([b.device.state.actuationCmm, b.device.state.rtEnabled], [225, false]);
        assertEq(b.session.dirty, true, "restoring does not save");
    });

    test("backup: a partially failing restore lists exactly what did not end up on the pad", async () => {
        const a = await rig();
        editSomething(a.draft, a.settings);
        await a.keymap.writeChanges();
        await a.settings.apply();
        const parsed = DP.backup.parse(JSON.stringify(DP.backup.create(a.session)), a.session.limits);
        const b = await rig();
        b.device.faults.setKeyError["1:4"] = "invalid_code";
        b.device.faults.labelOverride = l => (l === "BK" ? "BQ" : l);
        const res = await DP.backup.restore(b.session, parsed);
        assertEq(res.failed.map(f => f.what), ["layer 1 key 4"]);
        assertEq(res.mismatched.map(m => m.what).sort(), ["layer 0 key 0"]);
        assertEq(res.mismatched[0].actual, key(98, "BQ"), "mismatches show what the pad holds");
        assertEq(res.applied.length, 5 + 48 - 1, "every other step was accepted (5 settings, 48 keys)");
    });

    test("backup: invalid files are refused with a reason", () => {
        const lim = C.FALLBACK_LIMITS;
        const good = {
            format: "driftpad-backup", format_version: 1, created: "x", source: { fw: "2.1.0", protocol: 2, build: "x" },
            settings: { actuation_mm: 1.2, rt_sens_mm: 0.2, rt_enabled: true, active_layer: 0, boot_output: false },
            layers: DP.keycodes.defaultKeymaps(),
        };
        assertEq(DP.backup.parse(JSON.stringify(good), lim).problems, []);
        const variant = fn => { const d = JSON.parse(JSON.stringify(good)); fn(d); return JSON.stringify(d); };
        const cases = {
            "not json": "{nope",
            "array": "[]",
            "other format": variant(d => { d.format = "something-else"; }),
            "future version": variant(d => { d.format_version = 2; }),
            "actuation out of range": variant(d => { d.settings.actuation_mm = 9; }),
            "3 decimals": variant(d => { d.settings.rt_sens_mm = 0.123; }),
            "bad layer": variant(d => { d.settings.active_layer = 3; }),
            "bad label": variant(d => { d.layers[0][0].label = "a b"; }),
            "unassignable code": variant(d => { d.layers[1][1].code = 137; }),
            "short layer": variant(d => { d.layers[2].pop(); }),
        };
        for (const [name, text] of Object.entries(cases)) {
            const r = DP.backup.parse(text, lim);
            assert(r.problems.length > 0, `${name} must be refused`);
            assertEq([r.settings, r.layers], [null, null], `${name}: nothing restorable`);
        }
    });

    test("backup: the old keymap editor's export restores keymaps only, with label fixes listed", async () => {
        const layers = DP.keycodes.defaultKeymaps();
        layers[0][0].label = "e sc";               // allowed by the old editor, not by the rule
        const parsed = DP.backup.parse(JSON.stringify({ device: "DriftPad", version: 1, layers }), C.FALLBACK_LIMITS);
        assertEq([parsed.kind, parsed.settings, parsed.problems], ["keymap", null, []]);
        assert(parsed.warnings.some(w => w.includes("layers[0][0].label")), parsed.warnings.join("\n"));
        const b = await rig();
        await DP.backup.restore(b.session, parsed);
        assertEq(b.countVerb("SET_ACTUATION"), 0, "no settings sent");
        assertEq(b.device.state.layers[0][0].label, "ESC");
    });

    // ============================================================ draft storage
    function memoryStorage(initial = {}) {
        const data = Object.assign({}, initial);
        return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
    }

    test("draft: kept under a versioned key; invalid or unknown data falls back to defaults with a note", () => {
        const store = memoryStorage();
        const d1 = new DP.draft.Draft({ storage: store });
        d1.set(0, 0, 98, "ZZ");
        const saved = JSON.parse(store.data[DP.draft.STORAGE_KEY]);
        assertEq([saved.version, saved.touched, saved.layers[0][0]], [2, true, key(98, "ZZ")]);
        assertEq(new DP.draft.Draft({ storage: store }).get(0, 0), key(98, "ZZ"), "reloaded");
        const bad = memoryStorage({ [DP.draft.STORAGE_KEY]: JSON.stringify({ version: 2, layers: [[]] }) });
        const d2 = new DP.draft.Draft({ storage: bad });
        assert(d2.loadNote && d2.loadNote.includes("invalid"), d2.loadNote);
        assertEq(d2.get(0, 0), DP.keycodes.defaultKeymaps()[0][0]);
        const future = memoryStorage({ [DP.draft.STORAGE_KEY]: JSON.stringify({ version: 3, layers: [] }) });
        assert(new DP.draft.Draft({ storage: future }).loadNote.includes("unknown version"));
    });

    test("draft: the old editor's draft is carried over once, with label fixes", () => {
        const old = DP.keycodes.defaultKeymaps();
        old[1][2].label = "N_ok!";                 // too long for the rule
        const store = memoryStorage({ [DP.draft.LEGACY_STORAGE_KEY]: JSON.stringify(old) });
        const d = new DP.draft.Draft({ storage: store });
        assert(d.loadNote.includes("carried over"), d.loadNote);
        assertEq(d.touched, true);
        assertEq(C.normalizeLabel(d.get(1, 2).label), d.get(1, 2).label);
        assert(store.data[DP.draft.STORAGE_KEY], "migrated to the new key");
    });

    test("draft: a browser that refuses storage still edits, and says the draft is not kept", () => {
        const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
        const d = new DP.draft.Draft({ storage: broken });
        d.set(0, 0, 98, "OK");
        assertEq(d.get(0, 0), key(98, "OK"));
        assert(d.storageError && d.storageError.includes("quota"), d.storageError);
    });

    test("draft: an untouched draft follows the device on connect; a touched one stays pending", async () => {
        const a = await rig({ before: dev => dev.externalEdit(s => { s.layers[0][9] = key(120, "DEV"); }) });
        assertEq(a.draft.get(0, 9), key(120, "DEV"));
        assertEq(a.keymap.syncState(), "in_sync");
        const b = await rig({ before: (dev, draft) => draft.set(0, 9, 98, "MINE") });
        assertEq(b.draft.get(0, 9), key(98, "MINE"));
        assertEq(b.keymap.pendingList(), [{ l: 0, k: 9 }]);
    });
})(window);
