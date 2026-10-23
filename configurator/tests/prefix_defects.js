/*
 * prefix_defects.js - runs ONE scenario against the OLD configurator page it is injected into
 * (keymap.html or index.html of commit e2031e2, materialised by tests/test_configurator_js.py) and
 * reports whether the reviewed defect is present:
 *   <pre id="results">{"scenario", "defect": true|false, "detail"}</pre>
 * The scenario name comes from location.hash (#<name>). Uses the page's own globals.
 */
(function (g) {
    "use strict";

    async function connected(opts) {
        const fake = V1Fake.install(opts);
        // keymap.html: the device starts with exactly the page's draft, so nothing is pending
        if (typeof draft !== "undefined") {
            fake.device.layers = draft.map(layer => layer.map((k, i) => ({ idx: i, code: k.code, label: k.label })));
        }
        await g.toggleConnect();
        await waitUntil(() => typeof deviceLayers === "undefined" || deviceLayers || opts && opts.silent, 2000);
        await sleep(200);
        return fake;
    }

    const status = () => (document.getElementById("statusText") || {}).textContent || "";

    const scenarios = {
        // ---- keymap.html ----
        async keymap_edit_during_write() {
            const { device } = await connected();
            draft[0][0] = { code: 98, label: "A1" };
            device.holdSetKey = true;
            const p = writeToDevice();
            await waitUntil(() => device.held.length === 1);
            draft[0][0].label = "B2";                     // the user keeps typing while the write is pending
            device.release();
            await p;
            const pending = pendingChanges().length;
            return { defect: pending === 0, detail: `device label ${device.layers[0][0].label}, UI pending ${pending}` };
        },
        async keymap_write_rejected() {
            const { port } = await connected();
            port.rejectWrites = true;             // the device goes away: the next write fails...
            send("PING");
            await sleep(100);                     // ...and errors the pipe, so later writes reject at once
            draft[0][0] = { code: 98, label: "A1" };
            try { await writeToDevice(); } catch (e) { /* the old code lets it escape */ }
            await sleep(100);
            return { defect: writing === true, detail: `writing=${writing}` };
        },
        async keymap_disconnect_teardown() {
            const { port } = await connected();
            await disconnect();
            return { defect: port.opened === true || port.closeErrors > 0,
                     detail: `port still open=${port.opened}, close errors swallowed=${port.closeErrors}` };
        },
        async keymap_label_rule() {
            const { device } = await connected();
            draft[0][1] = { code: 98, label: sanitizeLabel("n/") };
            await writeToDevice();
            const pending = pendingChanges().length;
            return { defect: pending === 0 && device.layers[0][1].label !== draft[0][1].label,
                     detail: `UI label ${draft[0][1].label}, device label ${device.layers[0][1].label}, UI pending ${pending}` };
        },
        async keymap_load_is_stale() {
            const { device } = await connected();
            device.layers[0][2] = { idx: 2, code: 120, label: "NEW" };   // changed on the device since connecting
            loadFromDevice();
            await sleep(300);
            return { defect: draft[0][2].label !== "NEW", detail: `draft after load: ${draft[0][2].label}` };
        },
        async keymap_no_telemetry_request() {
            const { device } = await connected();
            await sleep(300);
            const asked = device.lines.some(l => /^STREAM 1/.test(l));
            return { defect: !asked, detail: `sent: ${device.lines.join(" | ")}` };
        },
        async keymap_stray_reply_accepted() {
            const { device } = await connected();
            device.strayOnSetKey = true;                  // the device never applies it; an unrelated reply arrives
            draft[0][3] = { code: 98, label: "XX" };
            await writeToDevice();
            const pending = pendingChanges().length;
            return { defect: pending === 0 && device.layers[0][3].label !== "XX",
                     detail: `device label ${device.layers[0][3].label}, UI pending ${pending}` };
        },
        async keymap_unidentified_device() {
            await connected({ silent: true });
            await sleep(3000);
            return { defect: /^connected$/i.test(status().trim()), detail: `status "${status()}" with a device that never answered` };
        },
        // ---- index.html ----
        async index_optimistic_setting() {
            await connected({ rejectSettings: true });
            onActuationChange("2.00");
            await sleep(500);
            const shown = document.getElementById("actVal").textContent;
            return { defect: shown.startsWith("2.00"), detail: `device rejected 2.00 mm, page shows "${shown}"` };
        },
        async index_layer_view_writes() {
            const { device } = await connected();
            await sleep(300);
            const before = device.lines.length;
            selectLayer(1);
            await sleep(300);
            const sent = device.lines.slice(before);
            return { defect: sent.some(l => l.startsWith("SET_LAYER")), detail: `viewing layer 1 sent: ${sent.join(" | ")}` };
        },
        async index_unidentified_device() {
            await connected({ silent: true });
            await sleep(3000);
            return { defect: /^connected$/i.test(status().trim()), detail: `status "${status()}" with a device that never answered` };
        },
    };

    g.addEventListener("load", async () => {
        const name = location.hash.slice(1);
        let out;
        try {
            if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
            out = Object.assign({ scenario: name }, await scenarios[name]());
        } catch (e) {
            out = { scenario: name, error: String((e && e.stack) || e) };
        }
        const pre = document.createElement("pre");
        pre.id = "results";
        pre.textContent = JSON.stringify(out);
        document.body.appendChild(pre);
    });
    g.PREFIX_SCENARIOS = Object.keys(scenarios);
})(window);
