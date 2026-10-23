/*
 * screen_app_tests.js - the Screen tab of the real page (index.html + app.js + screen_lab.js) in
 * simulated-device mode. tests/test_configurator_js.py injects it (after harness.js) into a copy of
 * index.html and runs it on the real clock, since the browser decodes GIFs and runs the conversion
 * worker off the page's thread.
 */
(function (g) {
    "use strict";
    const $ = id => document.getElementById(id);
    const app = () => g.DriftPadApp;
    const text = id => $(id).textContent;

    async function disconnected() {
        if (app().session.transport) await app().session.disconnect();
        await sleep(30);
    }

    function fixtureFile(name, type) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", `../tests/fixtures/${name}`);
            xhr.responseType = "arraybuffer";
            xhr.onload = () => resolve(new File([xhr.response], name, { type }));
            xhr.onerror = () => reject(new Error(`could not read ${name}`));
            xhr.send();
        });
    }
    function pickFile(file) {
        const dt = new DataTransfer();
        dt.items.add(file);
        $("labFile").files = dt.files;
        $("labFile").dispatchEvent(new Event("change", { bubbles: true }));
    }
    function litPixels(id) {
        const d = $(id).getContext("2d").getImageData(0, 0, 128, 64).data;
        let n = 0;
        for (let p = 0; p < d.length; p += 4) if (d[p + 1] > 100) n++;
        return n;
    }
    const lab = () => g.DriftPadScreenLab;

    test("screen lab: a GIF loads, converts and plays in all three mockups without a pad", async () => {
        await disconnected();
        app().setView("screen", false);
        assert($("labControls").disabled, "settings wait for a picture");
        const done = () => lab().state.main && $("labWork").hidden;
        pickFile(await fixtureFile("screen_lab_three_frames.gif", "image/gif"));
        assert(await waitUntil(done, 10000), `conversion finished: ${text("labSource")}`);
        assert(/64 × 32, 3 frames, 0\.4 s per loop/.test(text("labSource")), text("labSource"));
        assert(/^Needs 4 KB of the pad's 1,024 KB/.test(text("labSize")), text("labSize"));
        assert(!$("labControls").disabled, "settings unlocked");
        assertEq([$("labFirst").value, $("labLast").value], ["1", "3"], "the whole GIF is selected");
        for (const id of ["labSaver", "labHome", "labLayer"]) assert(litPixels(id) > 100, `${id} shows the picture`);
        assert(!$("labPlay").disabled, "an animation can be paused");
        assertEq(lab().engine.mode, "worker", "converted in the worker");
    });

    test("screen lab: changing a setting converts again, trimming changes the frame count", async () => {
        app().setView("screen", false);
        const before = lab().state.main;
        $("labLast").value = "2";
        $("labLast").dispatchEvent(new Event("change", { bubbles: true }));
        assert(await waitUntil(() => lab().state.main !== before && $("labWork").hidden, 10000), "converted again");
        assertEq(lab().state.main.frames.length, 2);
        assertEq(lab().state.main.delays, [100, 250]);
        $("labPlay").click();
        assertEq($("labPlay").textContent, "Play");
        assert(/paused/.test(text("labFrame")), text("labFrame"));
        $("labPlay").click();
        assertEq($("labPlay").textContent, "Pause");
    });

    test("screen lab: a file it cannot read says so and keeps the settings locked", async () => {
        app().setView("screen", false);
        pickFile(new File([new Uint8Array([71, 73, 70, 1, 2, 3])], "broken.gif", { type: "image/gif" }));
        assert(await waitUntil(() => $("labSource").classList.contains("error"), 10000), text("labSource"));
        assert(/^Could not read broken\.gif/.test(text("labSource")), text("labSource"));
        assert($("labControls").disabled);
        assertEq(text("labSize"), "");
        app().setView("keys", false);
    });

    g.addEventListener("load", () => setTimeout(() => runTests(), 0));
})(window);
