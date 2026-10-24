/*
 * app.js - the configurator page: wires DeviceSession (device.js), the keymap draft and settings
 * sync (draft.js) and backups (backup.js) to the DOM in index.html.
 *
 * Rendering updates the static DOM in place (never rebuilding an element that may have focus).
 * Everything shown as "on the pad", "applied" or "saved" comes from correlated replies; local
 * edits are always shown separately.
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad;
    const C = DP.contract;
    const K = DP.keycodes;
    const $ = id => document.getElementById(id);
    const NUM_KEYS = C.NUM_KEYS;
    const params = new URLSearchParams(g.location.search);
    const SIMULATE = params.get("simulate") === "1";

    // ------------------------------------------------------------------ session and models
    let simulation = null;
    function serialApi() {
        if (SIMULATE) {
            if (!simulation) simulation = DP.fake.createSimulation({ calibration: "missing", autoCalibrate: true });
            return simulation.serial;
        }
        return g.navigator.serial || null;
    }

    const session = new DP.device.DeviceSession({
        createTransport: h => new DP.transport.SerialTransport({ serial: serialApi(), port: h.port || undefined, onText: h.onText, onClose: h.onClose, log: h.log }),
    });
    // The simulator keeps its draft in memory: trying it must never touch the draft kept for a real pad.
    const draft = new DP.draft.Draft(SIMULATE ? { storage: null } : {});
    const keymap = new DP.draft.KeymapSync(draft, session);
    const settings = new DP.draft.SettingsSync(session);

    const VIEWS = ["keys", "sensitivity", "device", "screen"];
    const ui = { view: "keys", layer: 0, key: 0, category: "All", capturing: false, simActive: false };

    // ------------------------------------------------------------------ announcements
    function announce(msg) {
        const el = $("liveStatus");
        el.textContent = "";
        setTimeout(() => { el.textContent = msg; }, 20);
    }
    function announceError(msg) {
        const el = $("liveError");
        el.textContent = "";
        setTimeout(() => { el.textContent = msg; }, 20);
    }
    function setLine(id, text, kind) {
        const el = $(id);
        el.textContent = text || "";
        el.classList.toggle("error", kind === "error");
        el.classList.toggle("ok", kind === "ok");
    }

    // ------------------------------------------------------------------ confirm dialog
    function confirmDialog({ title, body, ok }) {
        const dlg = $("confirmDialog");
        const opener = document.activeElement;
        $("confirmTitle").textContent = title;
        $("confirmBody").textContent = body;
        $("confirmOk").textContent = ok || "Continue";
        return new Promise(resolve => {
            const finish = value => {
                $("confirmOk").onclick = $("confirmCancel").onclick = null;
                dlg.removeEventListener("cancel", onCancel);
                if (dlg.open) dlg.close();
                if (opener && typeof opener.focus === "function") opener.focus();
                resolve(value);
            };
            const onCancel = e => { e.preventDefault(); finish(false); };   // Escape
            dlg.addEventListener("cancel", onCancel);
            $("confirmOk").onclick = () => finish(true);
            $("confirmCancel").onclick = () => finish(false);
            if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
            $("confirmCancel").focus();
        });
    }

    // ------------------------------------------------------------------ helpers
    const layerName = l => K.LAYER_NAMES[l] || `Layer ${l}`;
    const keyName = code => K.keyName(code);
    const comboName = key => K.comboName(key.code, key.mods);
    const connected = () => session.isConnected;
    const fmt = mm => (typeof mm === "number" ? `${C.formatMm(mm)} mm` : "?");

    function download(name, obj) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function readFile(input) {
        return new Promise((resolve, reject) => {
            const file = input.files && input.files[0];
            input.value = "";
            if (!file) return resolve(null);
            file.text().then(resolve, reject);
        });
    }

    let renderQueued = false;
    function requestRender() {
        if (renderQueued) return;
        renderQueued = true;
        queueMicrotask(() => { renderQueued = false; render(); });
    }

    // ARIA radio group keys: arrows move and select (wrapping), Home/End go to the first/last option.
    function radioGroupKeys(container, selector, pick) {
        container.addEventListener("keydown", e => {
            const items = [...container.querySelectorAll(selector)];
            const i = items.indexOf(e.target);
            if (i < 0) return;
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            let next;
            if (step) next = (i + step + items.length) % items.length;
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = items.length - 1;
            else return;
            e.preventDefault();
            pick(items[next]);
            items[next].focus();
        });
    }

    // ------------------------------------------------------------------ build static parts once
    const caps = [];
    function buildCaps() {
        const pad = $("pad");
        for (let i = 0; i < NUM_KEYS; i++) {
            const cap = document.createElement("button");
            cap.type = "button";
            cap.className = "cap";
            cap.dataset.key = String(i);
            const face = document.createElement("div");
            face.className = "cap-face";
            const label = document.createElement("div");
            label.className = "cap-label";
            const name = document.createElement("div");
            name.className = "cap-name";
            face.append(label, name);
            const flag = document.createElement("span");
            flag.className = "flag";
            flag.setAttribute("aria-hidden", "true");
            cap.append(face, flag);
            cap.addEventListener("click", () => selectKey(i, false));
            pad.appendChild(cap);
            caps.push({ cap, label, name, flag });
        }
        pad.addEventListener("keydown", e => {
            if (ui.capturing || !e.target.classList.contains("cap")) return;
            const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
            const rowStart = ui.key - (ui.key % 4);
            let next;
            if (e.key in moves) {
                next = ui.key + moves[e.key];
                if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && Math.floor(next / 4) !== Math.floor(ui.key / 4)) return;
            } else if (e.key === "Home") next = e.ctrlKey ? 0 : rowStart;
            else if (e.key === "End") next = e.ctrlKey ? NUM_KEYS - 1 : rowStart + 3;
            else return;
            if (next < 0 || next >= NUM_KEYS) return;
            e.preventDefault();
            selectKey(next, true);
        });
    }

    function buildCategories() {
        const tabs = $("catTabs");
        K.CATEGORIES.forEach(cat => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "cat-tab";
            b.setAttribute("role", "radio");
            b.textContent = cat;
            b.dataset.cat = cat;
            b.addEventListener("click", () => pickCategory(cat));
            tabs.appendChild(b);
        });
        radioGroupKeys(tabs, ".cat-tab", b => pickCategory(b.dataset.cat));
    }

    function pickCategory(cat) {
        ui.category = cat;
        buildPicker();
        renderCategories();
    }

    function renderCategories() {
        document.querySelectorAll("#catTabs .cat-tab").forEach(b => {
            const on = b.dataset.cat === ui.category;
            b.classList.toggle("active", on);
            b.setAttribute("aria-checked", String(on));
            b.tabIndex = on ? 0 : -1;
        });
    }

    // Rebuilt only when the search or category changes (focus is then in the search box or tabs)
    function buildPicker() {
        const picker = $("picker");
        picker.textContent = "";
        K.searchCatalog($("search").value, ui.category).forEach(entry => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "pick";
            b.setAttribute("role", "option");
            b.dataset.code = String(entry.code);
            b.textContent = entry.name;
            b.title = `${entry.name} (code ${entry.code})`;
            b.addEventListener("click", () => assign(entry.code));
            picker.appendChild(b);
        });
        renderPicker();
    }

    function renderPicker() {
        const current = draft.get(ui.layer, ui.key).code;
        document.querySelectorAll("#picker .pick").forEach(b => {
            const on = Number(b.dataset.code) === current;
            b.classList.toggle("active", on);
            b.setAttribute("aria-selected", String(on));
        });
    }

    function buildSelects() {
        for (const id of ["simKey", "rawKey"]) {
            const sel = $(id);
            for (let i = 0; i < NUM_KEYS; i++) sel.add(new Option(`Key ${i}`, String(i)));
        }
        const grid = $("calGrid");
        for (let i = 0; i < NUM_KEYS; i++) {
            const s = document.createElement("span");
            s.setAttribute("role", "listitem");
            s.textContent = String(i);
            grid.appendChild(s);
        }
    }

    // ------------------------------------------------------------------ views
    function setView(view, focusTab) {
        ui.view = view;
        document.querySelectorAll(".tab").forEach(t => {
            const on = t.dataset.view === view;
            t.setAttribute("aria-selected", String(on));
            t.tabIndex = on ? 0 : -1;
            if (on && focusTab) t.focus();
        });
        document.querySelectorAll(".panel").forEach(p => { p.hidden = p.id !== `panel-${view}`; });
        if (g.location.hash !== `#${view}`) {
            // Absolute URL: a bare "#view" would resolve against a <base> element, not this page.
            const url = new URL(g.location.href);
            url.hash = view;
            history.replaceState(null, "", url.href);
        }
        // Key highlighting needs telemetry only while the keys are on screen
        session.wantTelemetry("keys", view === "keys");
        requestRender();
    }

    function selectKey(i, focus) {
        ui.key = i;
        stopCapture();
        requestRender();
        if (focus) caps[i].cap.focus();
    }

    function setLayer(l) {
        ui.layer = l;
        stopCapture();
        requestRender();
    }

    // ------------------------------------------------------------------ keymap editing
    function assign(code) {
        const k = draft.get(ui.layer, ui.key);
        const oldDefault = K.defaultLabel(k.code);
        const layerDefault = draft.defaults[ui.layer][ui.key].label;
        // Replace the label only if the user had not customised it
        const keepLabel = k.label && k.label !== oldDefault && k.label !== layerDefault;
        draft.set(ui.layer, ui.key, code, keepLabel ? k.label : K.defaultLabel(code));
        announce(`Key ${ui.key} on layer ${ui.layer} now sends ${comboName(draft.get(ui.layer, ui.key))} (not written yet)`);
    }

    function startCapture() {
        ui.capturing = true;
        $("captureBtn").setAttribute("aria-pressed", "true");
        $("captureBtn").classList.add("listening");
        $("captureBtn").textContent = "Listening: press a key";
        $("captureHint").textContent = "Esc can be assigned too. Click the button again to cancel.";
    }

    function stopCapture() {
        ui.capturing = false;
        $("captureBtn").setAttribute("aria-pressed", "false");
        $("captureBtn").classList.remove("listening");
        $("captureBtn").textContent = "Press a key to assign";
        $("captureHint").textContent = "Or pick one below.";
    }

    g.addEventListener("keydown", e => {
        if (!ui.capturing) return;
        e.preventDefault();
        e.stopPropagation();
        const entry = K.byEventCode(e.code);
        stopCapture();
        if (entry) assign(entry.code);
        else announceError(`"${e.code || e.key}" is not a key the pad can send.`);
        $("captureBtn").focus();
    }, true);

    async function writeChanges() {
        try {
            const r = await keymap.writeChanges();
            announce(`Wrote ${r.written.length} key${r.written.length === 1 ? "" : "s"} to the pad (applied, not saved).`);
        } catch (err) {
            announceError(`Write: ${err.message}`);
        }
    }

    async function loadFromDevice() {
        const pending = keymap.pendingList().length;
        if (pending) {
            const ok = await confirmDialog({
                title: "Replace your edits?",
                body: `Loading reads the keymap from the pad and replaces this browser's draft. ${pending} key change${pending === 1 ? "" : "s"} not yet written will be lost.`,
                ok: "Load from the pad",
            });
            if (!ok) return;
        }
        try {
            await keymap.loadFromDevice();
            announce("Loaded the keymap from the pad.");
        } catch (err) {
            announceError(`Load: ${err.message}`);
        }
    }

    function exportKeymap() {
        download("driftpad-keymap.json", { format: "driftpad-keymap", format_version: 1, layers: draft.layers });
    }

    async function importKeymap(input) {
        try {
            const text = await readFile(input);
            if (text === null) return;
            let data = JSON.parse(text);
            const layers = data && (data.format === "driftpad-keymap" || data.format === DP.backup.FORMAT || data.device === "DriftPad") ? data.layers : null;
            const check = DP.draft.checkLayers(layers, { strict: data && data.format === DP.backup.FORMAT });
            if (!check.layers) throw new Error(check.problems[0] || "expected 3 layers of 16 keys");
            draft.replaceLayers(check.layers);
            announce(`Keymap imported${check.warnings.length ? ` with ${check.warnings.length} label fix${check.warnings.length === 1 ? "" : "es"}` : ""}. Write it to the pad to use it.`);
        } catch (err) {
            announceError(`Import failed: ${err.message}`);
        }
    }

    // ------------------------------------------------------------------ settings
    let applyTimer = null;
    function scheduleApply() {
        clearTimeout(applyTimer);
        applyTimer = setTimeout(() => {
            if (!connected() || settings.applying) { if (settings.applying) scheduleApply(); return; }
            settings.apply().catch(err => announceError(`Sensitivity: ${err.message}`));
        }, 250);
    }

    // ------------------------------------------------------------------ device actions
    async function run(label, fn, okMsg) {
        try {
            const r = await fn();
            if (okMsg) announce(typeof okMsg === "function" ? okMsg(r) : okMsg);
            return r;
        } catch (err) {
            announceError(`${label}: ${err.message}`);
            return null;
        }
    }

    // Device tab: updating the firmware without opening the case (update.js). phase: idle, restarting
    // (BOOTSEL sent), waiting (in update mode, for the pad to come back), reconnecting, done.
    const update = { site: null, phase: "idle", from: null, result: null };
    DP.update.loadSiteFirmware(SIMULATE ? null : g.fetch && g.fetch.bind(g)).then(site => {
        update.site = site;
        requestRender();
    });
    const UPDATE_STATE = {
        current: ["Up to date", "badge-ok"], update: ["Update available", "badge-warn"],
        older: ["Newer than the site's", "badge-warn"], different: ["Different build", "badge-warn"],
    };
    function renderUpdate(isConn) {
        const site = update.site, info = isConn ? session.info : null;
        const link = $("updateFileLink");
        link.hidden = !site;
        if (site && link.getAttribute("href") !== DP.update.FILE) link.setAttribute("href", DP.update.FILE);
        const btn = $("updateBtn");
        const label = site ? "Download and restart into update mode" : "Restart into update mode";
        if (btn.textContent !== label) btn.textContent = label;
        btn.disabled = !isConn || update.phase === "restarting" || session.opState("bootsel") === "pending";
        const pad = info ? `Your pad: firmware ${info.fw}, build ${info.build}.` : "Connect the pad to update it.";
        const offer = site ? ` This site offers firmware ${site.fw}, build ${site.build}.`
            : " This page has no firmware file of its own: use a DriftPad.uf2 you downloaded or built.";
        setLine("updateVersions", pad + offer);
        const verdict = info && site ? UPDATE_STATE[DP.update.compare(info, site)] : null;
        const badge = $("updateBadge");
        badge.hidden = !verdict;
        if (verdict) { badge.textContent = verdict[0]; badge.className = `badge ${verdict[1]}`; }
        const r = update.result;
        const line = {
            restarting: ["Restarting the pad into update mode…"],
            waiting: [`The pad is in update mode. Copy DriftPad.uf2${site ? " (in your downloads)" : ""} onto the RPI-RP2 drive. This page reconnects when the pad comes back; if it does not within a few seconds of the drive closing, click Connect DriftPad.`],
            reconnecting: ["The pad is back. Reconnecting…"],
            done: r && r.changed ? [`Updated: the pad now runs firmware ${r.fw}, build ${r.build}. Settings and calibration were kept.`, "ok"]
                : r ? [`The pad is back on the same build (${r.build}): the file was not copied, or it was this firmware already.`] : [""],
        }[update.phase] || [""];
        setLine("updateState", line[0], line[1]);
    }
    async function restartForUpdate() {
        if (!session.isConnected || update.phase === "restarting") return;
        const unsaved = session.dirty === true ? " Unsaved changes on the pad are lost: save them first to keep them." : "";
        if (!await confirmDialog({
            title: "Restart into update mode?",
            body: `The pad disconnects and shows up as a drive called RPI-RP2.${update.site ? " DriftPad.uf2 downloads now: copy it onto that drive." : " Copy DriftPad.uf2 onto that drive."} Saved settings and calibration are kept.${unsaved}`,
            ok: "Restart",
        })) return;
        if (update.site) $("updateFileLink").click();   // the download starts while the pad restarts
        update.from = { fw: session.info.fw, build: session.info.build };
        update.result = null;
        update.phase = "restarting";
        requestRender();
        try {
            await session.bootsel();
            update.phase = "waiting";
            announce("The pad is in update mode. Copy DriftPad.uf2 onto the RPI-RP2 drive.");
        } catch (err) {
            update.phase = "idle";
            announceError(`Could not restart into update mode: ${err.message}`);
        }
        requestRender();
    }
    // The browser reports a serial port the user already chose when it comes back: after an update,
    // that is the pad restarting with its new firmware, so the page reconnects without asking
    async function padCameBack(port) {
        if (update.phase !== "waiting" || session.transport || session.isConnected) return;
        update.phase = "reconnecting";
        requestRender();
        await new Promise(resolve => setTimeout(resolve, 400));   // let the pad finish starting up
        await session.connect(port);
        if (!session.isConnected) {
            update.phase = "waiting";
            announceError("The pad is back, but reconnecting failed. Click Connect DriftPad.");
        } else {
            const info = session.info;
            update.result = { changed: !update.from || info.build !== update.from.build, fw: info.fw, build: info.build };
            update.phase = "done";
            announce(update.result.changed ? `Updated: the pad now runs firmware ${info.fw}.` : "The pad is back on the same firmware.");
        }
        requestRender();
    }

    // Screen tab: when the screensaver starts by itself and what it plays (stored settings)
    const SAVER_ANIMS = ["Starfield", "Plasma", "Tesseract", "Drift grid", "Magnetic pulse", "Lava lamp", "Sakura", "Orbit"];
    const THEME_NAMES = ["Drift", "Cherry blossom", "Space"];
    function minutesText(n) { return `${n} minute${n === 1 ? "" : "s"}`; }
    function renderSaver(isConn) {
        const s = session;
        const feature = isConn && s.hasFeature("screensaver_idle");
        const c = s.confirmed;
        const ready = feature && !!c && Number.isInteger(c.saver_idle);
        const idle = $("saverIdle"), anim = $("saverAnim"), theme = $("themeSelect");
        idle.disabled = anim.disabled = !ready;
        const themeReady = isConn && s.hasFeature("themes") && !!c && Number.isInteger(c.theme);
        theme.disabled = !themeReady;
        if (themeReady && document.activeElement !== theme) theme.value = String(c.theme);
        $("saverPlayBtn").disabled = !isConn || s.opState("display") === "pending";
        $("saverSaveBtn").disabled = !ready || s.dirty !== true;
        if (ready) {
            // A value set another way (serial console) gets its own entry instead of showing a wrong one
            const v = String(c.saver_idle);
            if (![...idle.options].some(o => o.value === v)) {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = minutesText(c.saver_idle);
                idle.appendChild(o);
            }
            if (document.activeElement !== idle) idle.value = v;
            if (document.activeElement !== anim) anim.value = String(c.saver_anim);
        }
        const badge = $("saverBadge");
        badge.textContent = !isConn ? "Not connected" : !feature ? "Manual only" : !ready ? "Reading…" : c.saver_idle === 0 ? "Off" : `After ${minutesText(c.saver_idle)}`;
        badge.className = `badge ${ready && c.saver_idle > 0 ? "badge-ok" : ""}`;
        const what = ready ? (c.saver_anim >= 0 ? SAVER_ANIMS[c.saver_anim] || `animation ${c.saver_anim}` : "all animations in turn") : "";
        setLine("saverState", !isConn ? "Connect the pad to choose when its screensaver starts." :
            !feature ? "This firmware plays the screensaver only when you start it. Update the firmware (Download firmware) to have it start by itself." :
            !ready ? "" :
            `${c.saver_idle === 0 ? "The screensaver plays only when you start it" : `After ${minutesText(c.saver_idle)} idle, the pad plays ${what}`}.` +
            (s.dirty === true ? " Not saved yet." : ""));
    }

    async function save() {
        const r = await run("Save", () => session.save());
        if (r) {
            // Save stores what the pad has applied; local edits not on the pad yet are not part of it.
            const keys = keymap.pendingList().length;
            const fields = settings.pendingFields().length;
            const left = [keys && `${keys} key change${keys === 1 ? "" : "s"} not written`, fields && `${fields} sensitivity edit${fields === 1 ? "" : "s"} not applied`].filter(Boolean);
            const note = left.length ? ` Not included: ${left.join(" and ")}.` : "";
            announce(`Saved to the pad.${note}`);
        }
        // Persistent feedback is derived from current confirmed state in renderDevice,
        // so a later edit cannot leave this operation's success message behind.
        requestRender();
    }

    async function revert() {
        const ok = await confirmDialog({ title: "Discard unsaved changes?", body: "The pad goes back to the settings it has saved in flash.", ok: "Discard" });
        if (ok) await run("Discard", () => session.revert(), "The pad is back to its saved settings.");
    }

    async function reset(all) {
        const ok = await confirmDialog({
            title: all ? "Factory settings and forget calibration?" : "Factory settings?",
            body: all
                ? "Keymaps and sensitivity go back to the factory defaults and the calibration is cleared, so keyboard output turns off until you calibrate again. Nothing is saved until you save."
                : "Keymaps and sensitivity go back to the factory defaults. Calibration is kept. Nothing is saved until you save.",
            ok: all ? "Reset everything" : "Reset",
        });
        if (ok) await run("Reset", () => session.reset(all), "Factory settings applied (not saved yet).");
    }

    async function setOutput(on, force) {
        if (force) {
            const ok = await confirmDialog({
                title: "Force keyboard output on?",
                body: "This turns keyboard output on although the pad is not calibrated. Keys held at power-up or misread by the sensors may type. Use it only for bench testing.",
                ok: "Force on",
            });
            if (!ok) return;
        }
        try {
            await session.setOutput(on, force);
            announce(on ? "Keyboard output is on." : "Keyboard output is off.");
        } catch (err) {
            if (err.code === "calibration_required") announceError("Calibrate the pad first: keyboard output needs a valid calibration.");
            else announceError(`Keyboard output: ${err.message}`);
        }
    }

    async function doRestore(input) {
        let parsed;
        try {
            const text = await readFile(input);
            if (text === null) return;
            parsed = DP.backup.parse(text, session.limits);
        } catch (err) {
            announceError(`Restore: ${err.message}`);
            return;
        }
        if (parsed.problems.length) {
            setLine("restoreState", `Cannot restore: ${parsed.problems.slice(0, 3).join(" ")}${parsed.problems.length > 3 ? ` (+${parsed.problems.length - 3} more)` : ""}`, "error");
            announceError("The backup file has problems; nothing was changed.");
            return;
        }
        const ok = await confirmDialog({
            title: "Restore this backup?",
            body: `${parsed.kind === "keymap" ? "Keymaps only." : "Keymaps and sensitivity settings."} Calibration is not touched. ${parsed.warnings.join(" ")} Nothing is saved until you save.`,
            ok: "Restore",
        });
        if (!ok) return;
        try {
            const r = await DP.backup.restore(session, parsed, (i, n) => setLine("restoreState", `Restoring ${i} of ${n}…`));
            const problems = r.failed.length + r.mismatched.length;
            if (problems) {
                const first = r.failed.map(f => `${f.what}: ${f.error}`).concat(r.mismatched.map(m => `${m.what} reads back differently`));
                setLine("restoreState", `Restored partly: ${r.applied.length} applied, ${problems} did not (${first.slice(0, 3).join("; ")}). Nothing is saved yet.`, "error");
                announceError("The restore was only partly applied.");
            } else {
                setLine("restoreState", "Restored and read back. Save to keep it.", "ok");
                announce("Backup restored and verified. Save to keep it.");
            }
        } catch (err) {
            setLine("restoreState", `Restore failed: ${err.message}`, "error");
            announceError(`Restore: ${err.message}`);
        }
    }

    // Simulation keeps itself alive while in use (the firmware ends it 3 s after the last SIM)
    let simKeepAlive = null;
    let simTimer = null;
    function simulate() {
        clearTimeout(simTimer);
        simTimer = setTimeout(async () => {
            const key = Number($("simKey").value);
            const mm = Number($("simTravel").value);
            const r = await run("Simulation", () => session.sim(key, mm));
            ui.simActive = !!r;
            if (ui.simActive && !simKeepAlive) {
                simKeepAlive = setInterval(() => {
                    if (!connected() || !ui.simActive) return;
                    session.sim(Number($("simKey").value), Number($("simTravel").value)).catch(() => {});
                }, 1500);
            }
            requestRender();
        }, 100);
    }

    async function simOff() {
        clearInterval(simKeepAlive);
        simKeepAlive = null;
        ui.simActive = false;
        $("simTravel").value = "0";
        await run("Simulation", () => session.sim(null), "Simulation stopped.");
        requestRender();
    }

    // ------------------------------------------------------------------ rendering
    function render() {
        const s = session;
        const isConn = connected();
        const lim = s.limits;

        // header
        $("statusText").textContent = s.statusText;
        const dot = $("statusDot");
        dot.classList.toggle("connected", isConn);
        dot.classList.toggle("warn", ["legacy", "unsupported", "not_driftpad"].includes(s.conn.state));
        dot.classList.toggle("bad", s.conn.state === "lost");
        $("connDetail").textContent = s.conn.detail || (SIMULATE ? "Simulated device mode." : "");
        const busy = ["connecting", "identifying"].includes(s.conn.state);
        $("connectBtn").textContent = isConn || busy ? "Disconnect" : "Connect DriftPad";
        $("dirtyBadge").hidden = !(isConn && s.dirty === true);

        renderKeys(isConn);
        renderSettings(isConn, lim);
        renderDevice(isConn);
    }

    function renderKeys(isConn) {
        document.querySelectorAll("#layerTabs .layer-tab").forEach(b => {
            const on = Number(b.dataset.layer) === ui.layer;
            b.classList.toggle("active", on);
            b.setAttribute("aria-checked", String(on));
            b.tabIndex = on ? 0 : -1;
        });
        const confirmed = isConn && session.confirmed;
        $("activeLayerNote").textContent = confirmed ? `The pad is using layer ${session.confirmed.active_layer}.` : "";
        $("makeActiveBtn").disabled = !confirmed || session.confirmed.active_layer === ui.layer;
        const knobSel = $("knobSelect");
        const knobs = confirmed && session.hasFeature("knob_modes") ? session.confirmed.knob : null;
        knobSel.disabled = !knobs || session.opState("knob") === "pending";
        if (knobs && document.activeElement !== knobSel) knobSel.value = String(knobs[ui.layer]);

        const pressed = session.telemetry.pressed;
        for (let i = 0; i < NUM_KEYS; i++) {
            const st = keymap.keyState(ui.layer, i);
            const c = caps[i];
            c.label.textContent = st.draft.label;
            c.name.textContent = comboName(st.draft);
            c.cap.classList.toggle("selected", i === ui.key);
            c.cap.tabIndex = i === ui.key ? 0 : -1;
            const isPressed = isConn && session.telemetry.active && pressed[i];
            c.cap.classList.toggle("pressed", !!isPressed);
            let flag = "", cls = "", text = "";
            if (st.error) { flag = "✕"; cls = "error"; text = `write failed: ${st.error}`; }
            else if (st.writing) { flag = "…"; cls = "pending"; text = "being written"; }
            else if (st.pending) { flag = "▲"; cls = "pending"; text = "not written to the pad"; }
            else if (st.custom) { flag = "●"; cls = "custom"; text = "changed from the default"; }
            c.flag.textContent = flag;
            c.flag.className = `flag ${cls}`;
            const row = Math.floor(i / 4) + 1, col = (i % 4) + 1;
            c.cap.setAttribute("aria-label", `Key ${i}, row ${row} column ${col}: ${comboName(st.draft)}, label ${st.draft.label}${text ? ", " + text : ""}${isPressed ? ", pressed" : ""}`);
            c.cap.setAttribute("aria-current", i === ui.key ? "true" : "false");
        }

        const k = draft.get(ui.layer, ui.key);
        const st = keymap.keyState(ui.layer, ui.key);
        $("oledLayer").textContent = `L${ui.layer} ${layerName(ui.layer).toUpperCase()}`;
        $("oledMain").textContent = k.label;
        $("oledSub").textContent = `KEY ${ui.key} · ${comboName(k)}`;
        $("editorTitle").textContent = `Key ${ui.key} · row ${Math.floor(ui.key / 4) + 1}, column ${(ui.key % 4) + 1} · layer ${ui.layer}`;
        const telemetry = session.telemetry;
        const simulated = SIMULATE || !!(session.deviceStatus.sim_mask & (1 << ui.key));
        $("keyTravelState").textContent = !isConn ? "Connect the pad to see sensor movement." :
            telemetry.error ? `Live readings unavailable: ${telemetry.error}` :
            !(telemetry.active && telemetry.target && telemetry.hasFrame) ? "Waiting for live sensor readings…" :
            `${simulated ? "Simulated" : "Sensor"} travel: ${telemetry.travel[ui.key].toFixed(2)} mm · ${telemetry.pressed[ui.key] ? "Pressed" : "Released"} · ${telemetry.sending[ui.key] ? "Sending to computer" : "Not sending to computer"}`;
        const knob = isConn && telemetry.active && telemetry.target && telemetry.hasFrame ? telemetry.knob : null;
        const level = v => v ? "high" : "low";
        $("knobState").textContent = !isConn ? "Connect the pad to check the knob." :
            !session.hasFeature("encoder_status") ? "This firmware does not report the knob. Update it to check the knob's wiring." :
            !knob ? "Waiting for knob readings…" :
            `${SIMULATE ? "Simulated knob" : "Knob"}: A ${level(knob.a)} · B ${level(knob.b)} · switch ${knob.sw ? "open" : "closed (pressed)"} · ` +
            `${knob.steps} step${knob.steps === 1 || knob.steps === -1 ? "" : "s"} turned · ${knob.presses} press${knob.presses === 1 ? "" : "es"} since power-up`;
        $("knob").classList.toggle("pressed", !!knob && knob.sw === 0);
        // 80 steps per turn on a 20-click encoder; the pointer follows the counted steps
        $("knob").style.setProperty("--knob-angle", `${knob ? knob.steps * 4.5 : 0}deg`);
        $("keyTravelHint").textContent = simulated ?
            "Simulated readings do not verify a physical sensor. Travel is an estimate." :
            "Travel is an estimate; calibrate all 16 keys before testing keyboard output.";
        const labelInput = $("labelInput");
        if (document.activeElement !== labelInput) {
            labelInput.value = k.label;
            labelInput.removeAttribute("aria-invalid");
        }
        const codeInput = $("codeInput");
        if (document.activeElement !== codeInput) codeInput.value = String(k.code);
        $("sendsName").textContent = comboName(k);
        $("deviceKeyState").textContent = !st.compared ? "Not compared with a pad." :
            st.error ? `Last write failed: ${st.error}` :
            st.mismatch ? `The pad stored ${comboName(st.mismatch.stored)} / ${st.mismatch.stored.label}.` :
            st.writing ? "Being written…" :
            st.pending ? `On the pad: ${comboName(st.device)} / ${st.device.label}. Not written yet.` :
            "Same as on the pad.";
        // Older firmware stores no modifiers: the boxes stay usable offline, but not against it
        const modsUnsupported = isConn && !!session.info && !session.hasFeature("key_modifiers");
        document.querySelectorAll("#modsField input[data-mod]").forEach(box => {
            box.checked = ((k.mods || 0) & Number(box.dataset.mod)) !== 0;
            box.disabled = modsUnsupported;
        });
        $("modsHint").textContent = modsUnsupported ? "This firmware cannot store key combinations. Update it with Download firmware." :
            "Held together with the key, e.g. Ctrl + C.";
        renderPicker();

        const pending = keymap.pendingList().length;
        const state = keymap.syncState();
        $("syncSummary").textContent = {
            offline: "Not connected: edits are kept in this browser",
            loading: "Reading the pad's keymap…",
            writing: "Writing…",
            pending: `${pending} key change${pending === 1 ? "" : "s"} not written to the pad`,
            in_sync: "Matches the pad (applied)",
        }[state];
        $("writeBtn").disabled = !isConn || !session.confirmed || pending === 0 || keymap.writing;
        $("writeBtn").textContent = pending ? `Write ${pending} change${pending === 1 ? "" : "s"}` : "Write changes";
        $("loadBtn").disabled = !isConn || keymap.writing;
    }

    function renderSlider(prefix, field, lim) {
        const slider = $(`${prefix}Slider`);
        slider.min = String(lim.min);
        slider.max = String(lim.max);
        slider.step = String(lim.step || 0.05);
        $(`${prefix}Min`).textContent = C.formatMm(lim.min);
        $(`${prefix}Max`).textContent = C.formatMm(lim.max);
        const value = settings.value(field);
        if (document.activeElement !== slider) slider.value = String(value);
        slider.style.setProperty("--fill", `${((value - lim.min) / (lim.max - lim.min)) * 100}%`);
        $(`${prefix}Edit`).textContent = fmt(value);
        const dev = $(`${prefix}Device`);
        const confirmed = settings.confirmedValue(field);
        const err = settings.errors.get(field);
        const mismatch = settings.mismatches.get(field);
        dev.classList.toggle("error", !!(err || mismatch));
        dev.textContent = !connected() ? "Not connected." : settingStatus(field, fmt(confirmed), {
            err, mismatch: mismatch && `the pad stored ${fmt(mismatch.stored)} instead of ${fmt(mismatch.sent)}`,
            sending: settings.inFlight.has(field) && `Sending ${fmt(settings.inFlight.get(field))}…`,
        });
    }

    // One line saying what the pad uses now; a failed or altered write never hides the confirmed value.
    function settingStatus(field, confirmedText, { err, mismatch, sending }) {
        const onPad = `On the pad: ${confirmedText}`;
        if (err) return `Not applied: ${err.replace(/\.$/, "")}. ${onPad}.`;
        if (mismatch) return `Changed by the pad: ${mismatch}. ${onPad}.`;
        if (sending) return sending;
        if (settings.isPending(field)) return `${onPad}. Your edit is not applied yet.`;
        return `${onPad} (applied${session.dirty ? ", not saved" : ""}).`;
    }

    function renderSettings(isConn, lim) {
        renderSlider("act", "actuation", lim.actuation);
        renderSlider("rt", "rt_sens", lim.rt_sens);
        $("actSlider").disabled = $("rtSlider").disabled = $("rtToggle").disabled = !isConn || !session.confirmed;
        const rtToggle = $("rtToggle");
        if (document.activeElement !== rtToggle) rtToggle.checked = !!settings.value("rt_enabled");
        const rtErr = settings.errors.get("rt_enabled");
        $("rtEnDevice").classList.toggle("error", !!rtErr);
        $("rtEnDevice").textContent = !isConn ? "" : settingStatus("rt_enabled", `Rapid Trigger ${settings.confirmedValue("rt_enabled") ? "on" : "off"}`, {
            err: rtErr, sending: settings.inFlight.has("rt_enabled") && "Sending…",
        });
        $("limitsSource").textContent = isConn ? (session.limitsSource === "device" ? "Limits reported by the pad" : "Built-in limits (the pad did not report any)") : "Built-in limits";
        setLine("settingsState", !isConn ? "Connect a DriftPad to change its sensitivity." :
            session.dirty ? "Applied changes are not saved yet: save on the Device page to keep them after unplugging." : "");
    }

    function renderDevice(isConn) {
        const s = session;
        const info = s.info;
        const dl = $("identity");
        const rows = [["Status", s.statusText]];
        if (info) {
            rows.push(["Firmware", info.fw], ["Protocol", String(info.protocol)], ["Build", `${info.build} (${info.build_date})`],
                ["Hardware", info.hw], ["Features", info.features.join(", ") || "none"]);
            const set = s.deviceStatus.settings;
            if (set) rows.push(["Settings loaded from", `${set.source}${set.load_errors && set.load_errors.length ? ` (${set.load_errors.join(", ")})` : ""}`]);
        }
        const html = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
        if (dl.innerHTML !== html) dl.innerHTML = html;

        $("saveBtn").disabled = !isConn || s.opState("save") === "pending";
        $("revertBtn").disabled = !isConn || s.dirty !== true;
        $("resetBtn").disabled = !isConn;
        const calFeature = isConn && s.hasFeature("guided_calibration");
        $("resetAllBtn").hidden = !calFeature;
        $("resetAllBtn").disabled = !calFeature;
        if (!isConn) setLine("saveState", "");
        else if (s.opState("save") === "pending") setLine("saveState", "Saving the applied settings to the pad…");
        else if (s.opState("save") === "failed") setLine("saveState",
            `Not saved: ${s.ops.save.error ? s.ops.save.error.message : "unknown error"}. The current settings were not confirmed saved. Retry Save before unplugging.`, "error");
        else if (s.dirty === true) setLine("saveState", "Unsaved changes on the pad. Save to keep them after unplugging.");
        else if (s.dirty === false) {
            const result = s.ops.save && s.ops.save.result;
            const keys = keymap.pendingList().length;
            const fields = settings.pendingFields().length;
            const left = [keys && `${keys} key change${keys === 1 ? "" : "s"} not written`, fields && `${fields} sensitivity edit${fields === 1 ? "" : "s"} not applied`].filter(Boolean);
            const note = left.length ? ` Not included: ${left.join(" and ")}.` : "";
            setLine("saveState", result
                ? `Saved to the pad's flash${result.slot ? ` (${String(result.slot).replace(/^slot_(\w)$/, (m, c) => `slot ${c.toUpperCase()}`)}, save #${result.seq})` : ""}. The settings survive unplugging.${note}`
                : `Everything applied is saved.${note}`, "ok");
        } else setLine("saveState", "Saved state unknown. Reconnect to read the pad's settings.");

        const out = s.deviceStatus.output;
        setLine("outputState", !isConn ? "Not connected." : !out ? "Unknown." :
            `${C.OUTPUT_REASONS[out.reason] || out.reason}${out.overflow ? ` (${out.overflow} presses blocked by the 6-key limit)` : ""}`);
        $("outputOnBtn").disabled = !isConn || !out || out.enabled;
        $("outputOffBtn").disabled = !isConn || !out || !out.enabled;
        $("forceOutputBtn").disabled = !isConn;

        const bootFeature = isConn && s.hasFeature("boot_output");
        $("bootOutputRow").hidden = !bootFeature;
        const bootToggle = $("bootOutputToggle");
        bootToggle.disabled = !bootFeature || !s.confirmed;
        if (s.confirmed && document.activeElement !== bootToggle) bootToggle.checked = !!s.confirmed.boot_output;

        const cal = s.deviceStatus.calibration;
        // Standalone mode is stored even without calibration, but the pad then stays silent at power-up.
        const bootNote = bootFeature && s.confirmed && s.confirmed.boot_output && cal && cal.state !== "valid"
            ? "Standalone mode is on, but the pad is not calibrated, so keyboard output will stay off at power-up. Calibrate below." : "";
        $("bootOutputNote").hidden = !bootNote;
        setLine("bootOutputNote", bootNote, bootNote ? "error" : null);

        renderSaver(isConn);
        renderUpdate(isConn);

        $("calCard").hidden = !calFeature;
        const calState = s.cal && s.cal.active ? "in_progress" : cal ? cal.state : "unknown";
        const badge = $("calState");
        badge.textContent = { valid: "Calibrated", missing: "Not calibrated", invalid: "Calibration invalid", in_progress: "Calibrating…" }[calState] || "Unknown";
        badge.className = `badge ${calState === "valid" ? "badge-ok" : calState === "in_progress" ? "badge-warn" : "badge-bad"}`;
        const active = !!(s.cal && s.cal.active);
        $("calStartBtn").disabled = !calFeature || active;
        $("calFinishBtn").disabled = !calFeature || !active;
        $("calCancelBtn").disabled = !calFeature || !active;
        const done = new Set(s.cal ? s.cal.done || [] : []);
        const failed = new Set(s.cal ? s.cal.failed || [] : []);
        const missing = new Set(s.cal ? s.cal.missing || [] : []);
        $("calGrid").querySelectorAll("span").forEach((el, i) => {
            el.classList.toggle("done", done.has(i));
            el.classList.toggle("failed", failed.has(i) || missing.has(i));
            el.setAttribute("aria-label", `Key ${i}: ${failed.has(i) ? "rest measurement failed; restart with hands off" : missing.has(i) ? "press fully and release, then finish again" : done.has(i) ? "done" : "not done"}`);
            el.textContent = done.has(i) ? `✓${i}` : String(i);
        });
        setLine("calProgress", !s.cal ? "" : {
            rest: "Measuring the keys at rest. Keep your hands off the pad.",
            travel: missing.size ? `Keys ${[...missing].join(", ")}: press fully and release, then choose Finish again. ${done.size} of ${NUM_KEYS} done.` : `Press each key fully and release it: ${done.size} of ${NUM_KEYS} done.`,
            done: s.dirty === false ? "Calibration applied and saved. Check the keys, then turn keyboard output on when ready." : "Calibration applied. Save to the pad to keep it, then turn keyboard output on when ready.",
            failed: failed.size ? `Rest readings rejected for keys ${[...failed].join(", ")}. Start again with your hands off the pad. If the same keys fail again, check their sensors.` : "Calibration ended without a complete result. Start again with your hands off, then press and release all 16 keys.",
            cancelled: "Calibration cancelled; the previous calibration is kept.",
        }[s.cal.phase] || "", s.cal && s.cal.phase === "failed" ? "error" : null);

        $("backupBtn").disabled = !isConn || !s.confirmed;
        $("restoreBtn").disabled = !isConn || !s.confirmed;
        for (const id of ["rawBtn", "timingBtn", "timingResetBtn", "bootselBtn"]) $(id).disabled = !isConn;
        const displayPending = s.opState("display") === "pending" || s.opState("displayStatus") === "pending";
        const display = s.deviceStatus.display;
        for (const id of ["animSelect", "screensaverBtn", "screensaverStopBtn", "displayOffBtn"]) {
            $(id).disabled = !isConn || displayPending || !!(display && !display.available);
        }
        $("displayRefreshBtn").disabled = !isConn || displayPending || !s.hasFeature("display_status");
        const animNames = SAVER_ANIMS;
        $("animSelect").options[0].textContent = !isConn || s.hasFeature("display_status") ? "Shuffle all" : "All animations";
        const reported = !display ? "Display state has not been read." : !display.available ? "Device reports: OLED unavailable." :
            display.mode === "screen" ? "Device reports: selected screen active." :
            display.mode === "sleep" ? "Device reports: display off." :
            `Device reports: screensaver${display.animation >= 0 ? ` — ${animNames[display.animation]}` : ""}${display.shuffle ? " (Shuffle all)" : ""}${display.dimmed ? ", dimmed" : ""}.`;
        setLine("displayState", !isConn ? "Connect the pad to control its display." : !s.hasFeature("display_status") ?
            "This firmware does not report display state. The controls send a request only." : reported);
        const displayOp = [s.ops.display, s.ops.displayStatus].filter(Boolean).sort((a, b) => b.sequence - a.sequence)[0];
        let requestText = "", requestKind = null;
        if (isConn && displayOp) {
            if (displayOp.state === "pending") requestText = displayOp === s.ops.displayStatus ? "Reading display state…" :
                ({ ANIM: "Requesting screensaver…", SCREENSAVER: "Requesting screensaver…", WAKE: "Requesting the selected screen…", SLEEP: "Requesting display off…" }[displayOp.verb] || "Requesting display change…");
            else if (displayOp.state === "failed") {
                requestText = `Display request not confirmed: ${displayOp.error ? displayOp.error.message : "unknown error"}.`;
                requestKind = "error";
            } else if (displayOp === s.ops.displayStatus) requestText = display ? "Display report refreshed." : "The device did not return usable display state.";
            else {
                requestText = {
                    confirmed: "Request applied by the display.",
                    unsupported: "Request accepted. This firmware cannot confirm display state.",
                    unavailable: "Request accepted, but the OLED is unavailable. Check its connection and refresh the display status.",
                    pending: "Request accepted; the display has not confirmed the change. Refresh the display status.",
                    unknown: "Request accepted; display state could not be read. Refresh the display status.",
                }[displayOp.result && displayOp.result.display_confirmation] || "Display request accepted.";
                requestKind = displayOp.result && displayOp.result.display_confirmation === "confirmed" ? "ok" : null;
            }
        }
        setLine("displayRequestState", requestText, requestKind);
        $("simOffBtn").disabled = !isConn || !ui.simActive;
        $("simTravelVal").textContent = `${C.formatMm(Number($("simTravel").value))} mm`;
    }

    function esc(v) {
        return String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    // ------------------------------------------------------------------ log
    function appendLog(entry) {
        const box = $("log");
        const line = document.createElement("div");
        line.textContent = `[${new Date(entry.t).toLocaleTimeString()}] ${entry.level.toUpperCase()} ${entry.msg}`;
        box.appendChild(line);
        while (box.childElementCount > 400) box.firstElementChild.remove();
        box.scrollTop = box.scrollHeight;
    }

    // ------------------------------------------------------------------ wiring
    function wire() {
        // The published web page has no Studio, so its build leaves this link out
        if ($("studioLink")) $("studioLink").addEventListener("click", async e => {
            e.preventDefault();
            if ((session.dirty || settings.pendingFields().length) && !await confirmDialog({
                title: "Return to Studio?",
                body: "Some changes have not been saved on the pad. Stay here to finish and save, or return to Studio and disconnect.",
                ok: "Return to Studio",
            })) return;
            await session.disconnect();
            g.location.assign($("studioLink").href);
        });
        $("connectBtn").addEventListener("click", async () => {
            if (["connected", "connecting", "identifying"].includes(session.conn.state)) {
                await session.disconnect();
                return;
            }
            if (!serialApi()) {
                announceError("This browser has no WebSerial. Use Chrome, Edge or Opera; you can still edit and export keymaps here.");
                return;
            }
            await session.connect();
            if (session.isConnected) announce(`Connected to DriftPad firmware ${session.info.fw}.`);
            else announceError(session.statusText + (session.conn.detail ? `: ${session.conn.detail}` : ""));
        });

        document.querySelectorAll(".tab").forEach(t => {
            t.addEventListener("click", () => setView(t.dataset.view, false));
            t.addEventListener("keydown", e => {
                const order = VIEWS;
                const i = order.indexOf(t.dataset.view);
                if (e.key === "ArrowRight") { e.preventDefault(); setView(order[(i + 1) % order.length], true); }
                if (e.key === "ArrowLeft") { e.preventDefault(); setView(order[(i + order.length - 1) % order.length], true); }
            });
        });
        document.querySelectorAll("#layerTabs .layer-tab").forEach(b => b.addEventListener("click", () => setLayer(Number(b.dataset.layer))));
        radioGroupKeys($("layerTabs"), ".layer-tab", b => setLayer(Number(b.dataset.layer)));
        $("knobSelect").addEventListener("change", async e => {
            const sel = e.target, layer = ui.layer, mode = Number(sel.value);
            await run("Knob", () => session.runOp("knob", () => session.setKnob(layer, mode)),
                `The knob on layer ${layer} now: ${sel.selectedOptions[0].textContent.split(":")[0]}. Save on the Device page to keep it.`);
            // Show what the pad has, also when the change was refused
            const knobs = session.confirmed && session.confirmed.knob;
            if (knobs && ui.layer === layer) sel.value = String(knobs[layer]);
        });
        $("makeActiveBtn").addEventListener("click", () => run("Active layer", () => session.setSetting("active_layer", ui.layer),
            `The pad now uses layer ${ui.layer} (applied, not saved).`));

        $("labelInput").addEventListener("input", e => {
            const norm = C.normalizeLabel(e.target.value);
            if (norm === null) {
                e.target.setAttribute("aria-invalid", "true");
                $("labelHelp").textContent = C.labelProblem(e.target.value) || "Invalid label.";
                return;
            }
            e.target.removeAttribute("aria-invalid");
            $("labelHelp").textContent = "Letters are shown in capitals. Spaces, quotes, backslash and @ are not allowed.";
            const k = draft.get(ui.layer, ui.key);
            if (norm !== k.label) draft.set(ui.layer, ui.key, k.code, norm);
        });
        $("labelInput").addEventListener("blur", () => requestRender());
        document.querySelectorAll("#modsField input[data-mod]").forEach(box => box.addEventListener("change", () => {
            let mods = 0;
            document.querySelectorAll("#modsField input[data-mod]").forEach(b => { if (b.checked) mods |= Number(b.dataset.mod); });
            const k = draft.get(ui.layer, ui.key);
            draft.set(ui.layer, ui.key, k.code, k.label, mods);
            announce(`Key ${ui.key} on layer ${ui.layer} now sends ${comboName(draft.get(ui.layer, ui.key))} (not written yet)`);
        }));
        $("codeInput").addEventListener("change", e => {
            const code = parseInt(e.target.value, 10);
            if (Number.isInteger(code) && K.isAssignable(code)) assign(code);
            else { announceError(`Code ${e.target.value} does not produce a key on the pad.`); requestRender(); }
        });
        $("captureBtn").addEventListener("click", () => (ui.capturing ? stopCapture() : startCapture()));
        $("search").addEventListener("input", buildPicker);
        $("resetKeyBtn").addEventListener("click", () => draft.resetKey(ui.layer, ui.key));
        $("resetLayerBtn").addEventListener("click", () => { draft.resetLayer(ui.layer); announce(`Layer ${ui.layer} reset to the default in the draft.`); });
        $("resetAllKeysBtn").addEventListener("click", async () => {
            if (await confirmDialog({ title: "Reset all layers?", body: "All three layers of the draft go back to the default layout. The pad is not changed until you write.", ok: "Reset all" })) draft.resetAll();
        });
        $("writeBtn").addEventListener("click", writeChanges);
        $("loadBtn").addEventListener("click", loadFromDevice);
        $("exportKeymapBtn").addEventListener("click", exportKeymap);
        $("importKeymapBtn").addEventListener("click", () => $("importKeymapFile").click());
        $("importKeymapFile").addEventListener("change", e => importKeymap(e.target));

        for (const [prefix, field] of [["act", "actuation"], ["rt", "rt_sens"]]) {
            $(`${prefix}Slider`).addEventListener("input", e => {
                settings.set(field, Number(e.target.value));
                scheduleApply();
            });
        }
        $("rtToggle").addEventListener("change", e => { settings.set("rt_enabled", e.target.checked); scheduleApply(); });

        $("saveBtn").addEventListener("click", save);
        $("revertBtn").addEventListener("click", revert);
        $("resetBtn").addEventListener("click", () => reset(false));
        $("resetAllBtn").addEventListener("click", () => reset(true));
        $("outputOnBtn").addEventListener("click", () => setOutput(true, false));
        $("outputOffBtn").addEventListener("click", () => setOutput(false, false));
        $("forceOutputBtn").addEventListener("click", () => setOutput(true, true));
        $("bootOutputToggle").addEventListener("change", e => run("Standalone mode", () => session.setSetting("boot_output", e.target.checked),
            e.target.checked ? "Standalone mode on (applied, save to keep it)." : "Standalone mode off (applied, save to keep it)."));
        $("saverIdle").addEventListener("change", e => {
            const n = Number(e.target.value);
            run("Screensaver", () => session.setSetting("saver_idle", n),
                n === 0 ? "The screensaver no longer starts by itself (applied, save to keep it)." : `The screensaver starts after ${minutesText(n)} idle (applied, save to keep it).`);
        });
        $("themeSelect").addEventListener("change", e => {
            const n = Number(e.target.value);
            run("Theme", () => session.setSetting("theme", n),
                () => `Theme: ${THEME_NAMES[n]}. The screensaver is now ${session.confirmed && session.confirmed.saver_anim >= 0 ? SAVER_ANIMS[session.confirmed.saver_anim] : "all animations in turn"} (applied, save to keep it).`);
        });
        $("saverAnim").addEventListener("change", e => {
            const n = Number(e.target.value);
            run("Screensaver", () => session.setSetting("saver_anim", n),
                `Screensaver: ${n < 0 ? "all animations in turn" : SAVER_ANIMS[n]} (applied, save to keep it).`);
        });
        $("saverPlayBtn").addEventListener("click", () => {
            if (session.opState("display") === "pending" || session.opState("displayStatus") === "pending") return;
            const v = $("saverAnim").value;
            run("Display", () => session.display("ANIM", v === "-1" ? [] : [v]), "Screensaver playing. Press any key or turn the knob to return.");
        });
        $("saverSaveBtn").addEventListener("click", save);
        $("calStartBtn").addEventListener("click", () => run("Calibration", () => session.calStart(), "Calibration started: keep your hands off the pad."));
        $("calFinishBtn").addEventListener("click", async () => {
            try {
                await session.calFinish();
                announce("Calibration applied. Save to the pad to keep it.");
            } catch (err) {
                announceError(err.code === "calibration_incomplete" ? "Some keys have not been pressed fully yet; they are marked on the grid." : `Calibration: ${err.message}`);
            }
        });
        $("calCancelBtn").addEventListener("click", () => run("Calibration", () => session.calCancel(), "Calibration cancelled."));
        $("backupBtn").addEventListener("click", () => {
            try { download("driftpad-backup.json", DP.backup.create(session)); announce("Backup downloaded."); } catch (err) { announceError(err.message); }
        });
        $("restoreBtn").addEventListener("click", () => $("restoreFile").click());
        $("restoreFile").addEventListener("change", e => doRestore(e.target));

        $("simTravel").addEventListener("input", () => { requestRender(); simulate(); });
        $("simKey").addEventListener("change", () => { if (ui.simActive) simulate(); });
        $("simOffBtn").addEventListener("click", simOff);
        $("rawBtn").addEventListener("click", async () => {
            const r = await run("Raw capture", () => session.raw(Number($("rawKey").value)));
            if (!r) return;
            const v = r.samples.filter(x => typeof x === "number");
            const min = Math.min(...v), max = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
            $("rawOut").textContent = `${v.length} samples at ${r.rate_hz || "?"} Hz\nmin ${min}  max ${max}  peak-to-peak ${max - min}\nmean ${mean.toFixed(1)} ADC counts`;
        });
        $("timingBtn").addEventListener("click", async () => {
            const r = await run("Timing", () => session.timing(false));
            if (r) $("timingOut").textContent = JSON.stringify(r, null, 1);
        });
        $("timingResetBtn").addEventListener("click", () => run("Timing", () => session.timing(true), "Timing counters reset."));
        $("screensaverBtn").addEventListener("click", () => {
            if (session.opState("display") === "pending" || session.opState("displayStatus") === "pending") return;
            const v = $("animSelect").value;
            run("Display", () => session.display("ANIM", v === "-1" ? [] : [v]));
        });
        $("screensaverStopBtn").addEventListener("click", () => {
            if (session.opState("display") === "pending" || session.opState("displayStatus") === "pending") return;
            run("Display", () => session.display("WAKE"));
        });
        $("displayOffBtn").addEventListener("click", () => {
            if (session.opState("display") === "pending" || session.opState("displayStatus") === "pending") return;
            run("Display", () => session.display("SLEEP"));
        });
        $("displayRefreshBtn").addEventListener("click", () => {
            if (session.opState("display") === "pending" || session.opState("displayStatus") === "pending") return;
            run("Display", () => session.refreshDisplayStatus());
        });
        $("updateBtn").addEventListener("click", () => { void restartForUpdate(); });
        const serial = serialApi();
        if (serial && typeof serial.addEventListener === "function") {
            serial.addEventListener("connect", e => { void padCameBack(e.target); });
        }
        $("bootselBtn").addEventListener("click", async () => {
            if (await confirmDialog({ title: "Restart into the bootloader?", body: "The pad disconnects and shows up as a USB drive (RPI-RP2) for a firmware update. Unsaved changes are lost.", ok: "Restart" })) {
                run("Bootloader", () => session.bootsel(), "The pad is restarting into its bootloader.");
            }
        });

        session.on("change", requestRender);
        session.on("conn", requestRender);
        // A dropped connection is not caused by the user, so it is announced (a chosen Disconnect is not).
        let lastConnState = session.conn.state;
        session.on("conn", conn => {
            if (conn.state === "lost" && lastConnState !== "lost") announceError(`Connection to the DriftPad lost. ${conn.detail || ""}`.trim());
            if (conn.state === "connected" && lastConnState !== "connected") $("liveError").textContent = "";   // no stale alert
            lastConnState = conn.state;
        });
        session.on("config", requestRender);
        session.on("telemetry", requestRender);
        session.on("cal", requestRender);
        session.on("log", appendLog);
        draft.on("change", requestRender);
        keymap.on("change", requestRender);
        settings.on("change", requestRender);
        session.setPageVisible(!document.hidden);   // a page opened in a background tab starts hidden
        document.addEventListener("visibilitychange", () => session.setPageVisible(!document.hidden));
        g.addEventListener("hashchange", () => {
            const v = g.location.hash.slice(1);
            if (VIEWS.includes(v) && v !== ui.view) setView(v, false);
        });
        g.addEventListener("pagehide", () => { session.disconnect().catch(() => {}); });
    }

    // ------------------------------------------------------------------ start
    buildCaps();
    buildCategories();
    renderCategories();
    buildPicker();
    buildSelects();
    wire();
    if (SIMULATE) $("simBanner").hidden = false;
    const start = g.location.hash.slice(1);
    setView(VIEWS.includes(start) ? start : "keys", false);
    if (draft.loadNote) announce(draft.loadNote);

    g.DriftPadApp = { session, draft, keymap, settings, ui, update, setView, selectKey, setLayer, assign, confirmDialog, get simulation() { return simulation; } };
})(window);
