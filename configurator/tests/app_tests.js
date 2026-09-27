/*
 * app_tests.js - the configurator page itself (index.html + app.js) in simulated-device mode.
 *
 * tests/test_configurator_js.py injects this file (after harness.js) into a copy of index.html
 * opened with ?simulate=1, so the page, its DOM and app.js are exactly what ships. The fake device
 * is reached through window.DriftPadApp.simulation once the page has connected.
 */
(function (g) {
    "use strict";
    const $ = id => document.getElementById(id);
    const app = () => g.DriftPadApp;
    const sim = () => app().simulation;
    const verbs = () => sim().device.verbs();
    const countVerb = v => verbs().filter(x => x === v).length;
    const text = id => $(id).textContent;

    async function connected() {
        if (!app().session.isConnected) {
            if (sim()) sim().port.replug();
            $("connectBtn").click();
            assert(await waitUntil(() => app().session.isConnected && app().session.confirmed), `connect: ${app().session.statusText}`);
        }
        await sleep(30);
    }

    async function disconnected() {
        if (app().session.transport) await app().session.disconnect();
        await sleep(30);
    }

    function key(el, k, opts = {}) {
        el.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
    }

    function setSlider(id, value) {
        const s = $(id);
        s.value = String(value);
        s.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // ------------------------------------------------------------------ identity and status
    test("app: the status says 'connected' only after the device identified itself", async () => {
        assertEq(text("statusText"), "No device");
        assert($("dirtyBadge").hidden, "no device badge while disconnected");
        const states = [];
        app().session.on("conn", c => states.push([c.state, text("statusText")]));
        await connected();
        assertEq(states.map(s => s[0]).slice(0, 3), ["connecting", "identifying", "connected"]);
        assert(text("statusText").startsWith("Connected: DriftPad fw "), text("statusText"));
        assert(!$("simBanner").hidden, "simulated mode is labelled as such");
    });

    // ------------------------------------------------------------------ reviewed defect
    test("app: viewing a layer never sends SET_LAYER (defect index_layer_view_writes)", async () => {
        await connected();
        const before = countVerb("SET_LAYER");
        document.querySelector('#layerTabs [data-layer="1"]').click();
        await sleep(50);
        document.querySelector('#layerTabs [data-layer="2"]').click();
        await sleep(50);
        assertEq(countVerb("SET_LAYER"), before, "viewing is local");
        assertEq(sim().device.state.activeLayer, 0);
        $("makeActiveBtn").click();                         // the explicit action does send it
        assert(await waitUntil(() => sim().device.state.activeLayer === 2), "make active");
        assertEq(countVerb("SET_LAYER"), before + 1);
        document.querySelector('#layerTabs [data-layer="0"]').click();
        $("makeActiveBtn").click();
        await waitUntil(() => sim().device.state.activeLayer === 0);
    });

    // ------------------------------------------------------------------ keymap sync display
    test("app: a key edit is 'not written' until the device confirms it, then 'matches the pad'", async () => {
        await connected();
        app().setLayer(0);
        app().selectKey(5, false);
        app().assign(241);                                   // F14
        await sleep(10);
        assert(/not written/.test(text("syncSummary")), text("syncSummary"));
        assert(/not written to the pad/.test(document.querySelectorAll("#pad .cap")[5].getAttribute("aria-label")));
        assertEq(sim().device.state.layers[0][5].code, 52, "nothing sent yet");
        $("writeBtn").click();
        assert(await waitUntil(() => /Matches the pad/.test(text("syncSummary"))), text("syncSummary"));
        assertEq(sim().device.state.layers[0][5].code, 241);
        assert(await waitUntil(() => /Wrote 1 key/.test(text("liveStatus"))), text("liveStatus"));
    });

    test("app: the simulator keeps its draft in memory and never touches the stored draft", async () => {
        let stored = "unavailable";
        try { stored = g.localStorage.getItem(g.DriftPad.draft.STORAGE_KEY); } catch (e) { /* storage blocked */ }
        assertEq(stored, stored === "unavailable" ? "unavailable" : null, "no draft stored by the simulator");
        assertEq(app().draft.storage, null);
    });

    // ------------------------------------------------------------------ settings
    test("app: a rejected setting shows the pad's value with the reason, and is announced", async () => {
        await connected();
        app().setView("sensitivity", false);
        sim().device.faults.forceError.SET_ACTUATION = "busy";
        setSlider("actSlider", 2.0);
        assert(await waitUntil(() => /Not applied/.test(text("actDevice")), 2000), text("actDevice"));
        assert(/On the pad: 1\.20 mm/.test(text("actDevice")), text("actDevice"));
        assert(await waitUntil(() => /busy/.test(text("liveError"))), text("liveError"));
        delete sim().device.faults.forceError.SET_ACTUATION;
        setSlider("actSlider", 1.25);
        assert(await waitUntil(() => /On the pad: 1\.25 mm \(applied/.test(text("actDevice")), 2000), text("actDevice"));
        app().setView("keys", false);
    });

    test("app: saving says which local edits are not part of the save", async () => {
        await connected();
        app().setLayer(1);
        app().selectKey(3, false);
        app().assign(98);                                    // not written
        app().setView("device", false);
        $("saveBtn").click();
        assert(await waitUntil(() => /Saved to the pad's flash/.test(text("saveState"))), text("saveState"));
        assert(/slot [AB], save #\d+/.test(text("saveState")), text("saveState"));
        assert(/Not included: 1 key change not written/.test(text("saveState")), text("saveState"));
        app().setView("keys", false);
        app().draft.resetKey(1, 3);
    });

    test("app: standalone mode on an uncalibrated pad warns that output stays off at power-up", async () => {
        await connected();
        app().setView("device", false);
        const toggle = $("bootOutputToggle");
        if (toggle.checked) { toggle.click(); await sleep(50); }
        assert($("bootOutputNote").hidden, "no warning while standalone mode is off");
        toggle.click();
        assert(await waitUntil(() => !$("bootOutputNote").hidden), "warning shown");
        assert(/not calibrated/.test(text("bootOutputNote")), text("bootOutputNote"));
        toggle.click();
        await waitUntil(() => $("bootOutputNote").hidden);
        app().setView("keys", false);
    });

    // ------------------------------------------------------------------ keyboard use
    test("app: the key grid moves with arrows, Home and End, with one tab stop", async () => {
        app().setView("keys", false);
        app().selectKey(5, true);
        const caps = [...document.querySelectorAll("#pad .cap")];
        const focused = () => caps.indexOf(document.activeElement);
        key(document.activeElement, "ArrowRight");
        await sleep(5);
        assertEq(focused(), 6);
        key(document.activeElement, "ArrowDown");
        await sleep(5);
        assertEq(focused(), 10);
        key(document.activeElement, "Home");
        await sleep(5);
        assertEq(focused(), 8);
        key(document.activeElement, "End");
        await sleep(5);
        assertEq(focused(), 11);
        key(document.activeElement, "ArrowRight");        // no wrap into the next row
        await sleep(5);
        assertEq(focused(), 11);
        key(document.activeElement, "End", { ctrlKey: true });
        await sleep(5);
        assertEq(focused(), 15);
        assertEq(caps.filter(c => c.tabIndex === 0).length, 1, "roving tabindex");
    });

    test("app: layer and category pickers are radio groups driven by the arrow keys", async () => {
        app().setView("keys", false);
        const layers = [...document.querySelectorAll("#layerTabs .layer-tab")];
        app().setLayer(0);
        await sleep(5);
        layers[0].focus();
        key(layers[0], "ArrowRight");
        await sleep(5);
        assertEq([app().ui.layer, document.activeElement], [1, layers[1]]);
        key(layers[1], "ArrowLeft");
        key(layers[0], "ArrowLeft");                      // wraps
        await sleep(5);
        assertEq(app().ui.layer, 2);
        assertEq(layers.filter(b => b.tabIndex === 0), [layers[2]]);
        const cats = [...document.querySelectorAll("#catTabs .cat-tab")];
        cats[0].focus();
        key(cats[0], "End");
        await sleep(5);
        assertEq(app().ui.category, cats[cats.length - 1].dataset.cat);
        key(document.activeElement, "Home");
        await sleep(5);
        assertEq(app().ui.category, "All");
        app().setLayer(0);
    });

    test("app: key capture assigns the next key pressed", async () => {
        app().setView("keys", false);
        app().setLayer(0);
        app().selectKey(2, false);
        $("captureBtn").click();
        assertEq($("captureBtn").getAttribute("aria-pressed"), "true");
        g.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ", key: "q", bubbles: true, cancelable: true }));
        await sleep(5);
        assertEq($("captureBtn").getAttribute("aria-pressed"), "false");
        assertEq(app().draft.get(0, 2).code, 113);
        assertEq(document.activeElement, $("captureBtn"), "focus returns to the capture button");
        app().draft.resetKey(0, 2);
    });

    test("app: the confirm dialog starts on Cancel; Escape cancels, sends nothing and restores focus", async () => {
        await connected();
        app().setView("device", false);
        const opener = $("resetBtn");
        opener.focus();
        const resets = countVerb("RESET");
        opener.click();
        const dlg = $("confirmDialog");
        assert(await waitUntil(() => dlg.open), "dialog opened");
        assertEq(document.activeElement, $("confirmCancel"), "safe default");
        // What the browser does on Escape for a modal <dialog>:
        dlg.dispatchEvent(new Event("cancel", { cancelable: true }));
        await sleep(20);
        assertEq(dlg.open, false);
        assertEq(document.activeElement, opener, "focus back on the opener");
        assertEq(countVerb("RESET"), resets, "nothing sent");
        app().setView("keys", false);
    });

    // ------------------------------------------------------------------ live state
    test("app: a pressed key is highlighted from telemetry and named in its label", async () => {
        await connected();
        app().setView("keys", false);
        assert(await waitUntil(() => app().session.telemetry.active), "telemetry subscribed on the Keys view");
        sim().device.pressKey(3, 3.0);
        const cap = document.querySelectorAll("#pad .cap")[3];
        assert(await waitUntil(() => cap.classList.contains("pressed")), "highlighted");
        assert(/, pressed$/.test(cap.getAttribute("aria-label")), cap.getAttribute("aria-label"));
        sim().device.releaseKey(3);
        assert(await waitUntil(() => !cap.classList.contains("pressed")), "released");
        app().setView("device", false);
        assert(await waitUntil(() => !app().session.telemetry.active), "unsubscribed away from the Keys view");
        app().setView("keys", false);
    });

    test("app: a lost connection is announced once and cleared on reconnect", async () => {
        await connected();
        const alerts = [];
        const obs = new MutationObserver(() => { if (text("liveError")) alerts.push(text("liveError")); });
        obs.observe($("liveError"), { childList: true, characterData: true, subtree: true });
        sim().port.unplug();
        assert(await waitUntil(() => text("statusText") === "Connection lost"), text("statusText"));
        await sleep(100);
        assertEq(alerts.filter(a => /Connection to the DriftPad lost/.test(a)).length, 1, alerts.join(" | "));
        assert($("dirtyBadge").hidden, "no device badge after the loss");
        assert($("writeBtn").disabled && $("saveBtn").disabled, "device actions disabled");
        obs.disconnect();
        await connected();
        assertEq(text("liveError"), "", "stale alert cleared");
    });

    test("app: disconnect releases the port", async () => {
        await connected();
        $("connectBtn").click();                               // "Disconnect"
        assert(await waitUntil(() => text("statusText") === "Disconnected"), text("statusText"));
        assertEq(sim().port.isOpen, false);
        assertEq(sim().device.streaming, false);
    });

    // ------------------------------------------------------------------ accessibility invariants
    function accessibleName(el) {
        if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
        const by = el.getAttribute("aria-labelledby");
        if (by) return by.split(/\s+/).map(id => ($(id) ? $(id).textContent : "")).join(" ").trim();
        if (el.labels && el.labels.length) return [...el.labels].map(l => l.textContent).join(" ").trim();
        if (el.tagName === "BUTTON") return el.textContent.trim();
        return (el.getAttribute("title") || "").trim();
    }

    test("app: accessibility invariants hold in every state visited", async () => {
        await connected();
        for (const view of ["keys", "sensitivity", "device"]) {
            app().setView(view, false);
            await sleep(10);
            const ids = [...document.querySelectorAll("[id]")].map(e => e.id);
            assertEq(ids.filter((id, i) => ids.indexOf(id) !== i), [], "duplicate ids");
            for (const el of document.querySelectorAll("button, input, select, textarea")) {
                if (el.type === "file" && el.hidden) continue;
                assert(accessibleName(el), `${el.tagName.toLowerCase()}#${el.id || "?"}.${el.className} has no accessible name`);
            }
            for (const el of document.querySelectorAll("[tabindex]")) {
                assert(Number(el.getAttribute("tabindex")) <= 0, `positive tabindex on #${el.id}`);
            }
            for (const ref of document.querySelectorAll("[aria-describedby], [aria-labelledby], [aria-controls]")) {
                for (const attr of ["aria-describedby", "aria-labelledby", "aria-controls"]) {
                    const v = ref.getAttribute(attr);
                    if (!v) continue;
                    for (const id of v.split(/\s+/)) assert($(id), `${attr}="${id}" on #${ref.id || ref.className} points nowhere`);
                }
            }
            const tabs = [...document.querySelectorAll('[role="tab"]')];
            assertEq(tabs.filter(t => t.getAttribute("aria-selected") === "true").map(t => t.dataset.view), [view]);
            assertEq(tabs.filter(t => t.tabIndex === 0).length, 1, "one tab stop in the tab list");
            for (const radio of document.querySelectorAll('[role="radio"]')) {
                assert(["true", "false"].includes(radio.getAttribute("aria-checked")), `radio ${radio.textContent} without aria-checked`);
            }
        }
        assertEq($("liveStatus").getAttribute("aria-live"), "polite");
        assertEq($("liveError").getAttribute("role"), "alert");
        assertEq(document.documentElement.lang, "en");
        app().setView("keys", false);
    });

    test("app: controls that need a device are disabled without one", async () => {
        await disconnected();
        for (const id of ["writeBtn", "saveBtn", "revertBtn", "resetBtn", "actSlider", "rtSlider", "rtToggle", "backupBtn", "restoreBtn", "timingBtn", "rawBtn", "bootselBtn"]) {
            assert($(id).disabled, `#${id} must be disabled while disconnected`);
        }
        assert(!$("captureBtn").disabled, "the draft stays editable offline");
    });

    g.addEventListener("load", () => setTimeout(() => runTests(), 0));
})(window);
