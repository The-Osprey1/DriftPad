/*
 * screen_lab.js - the Screen tab: load a GIF or picture, convert it to the pad's 128 x 64
 * black-and-white screen (gif_convert.js) and preview it in three possible places on the pad.
 *
 * A preview only: nothing here talks to the pad. The mockups are drawn pixel for pixel with the
 * pad's own 5 x 7 font, so what shows here is what the screen would show.
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad;
    const codec = DP.animCodec;
    const GC = DP.gifConvert;
    const K = DP.keycodes;
    const $ = id => document.getElementById(id);

    const W = codec.WIDTH, H = codec.HEIGHT;
    const THUMB = { x: 85, y: 10, w: 42, h: 42 };    // where the pad draws its key map
    const BADGE_MS = 3500;                            // the pad's animation name badge
    const LIT = [159, 232, 255];                      // the configurator's display colour
    const DEBOUNCE_MS = 120;

    // Adafruit GFX "glcdfont" (BSD licence), characters 32..126: five columns each, bit 0 at the top.
    const FONT = Uint8Array.from(
        ("000000000000005f00000007000700147f147f14242a7f2a12231308646236495620500008070300001c2241000041221c002a1c7f1c2a" +
         "08083e080800807030000808080808000060600020100804023e5149453e00427f400072494949462141494d331814127f102745454539" +
         "3c4a49493141211109073649494936464949291e0000140000004034000000081422411414141414004122140802015909063e415d594e" +
         "7c1211127c7f494949363e414141227f4141413e7f494949417f090909013e414151737f0808087f00417f41002040413f017f08142241" +
         "7f404040407f021c027f7f0408107f3e4141413e7f090909063e4151215e7f09192946264949493203017f01033f4040403f1f2040201f" +
         "3f4038403f631408146303047804036159494d43007f4141410204081020004141417f04020102044040404040000307080020545478" +
         "407f284444383844444428384444287f385454541800087e090218a4a49c787f0804047800447d40002040403d007f1028440000417f40" +
         "007c047804787c080404783844444438fc1824241818242418fc7c08040408485454542404043f44243c4040207c1c2040201c3c403040" +
         "3c44281028444c9090907c4464544c440008364100000077000000413608000201020402").match(/../g).map(h => parseInt(h, 16)));

    // ------------------------------------------------------------------ 1-bit drawing

    function setPx(buf, x, y, on) {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        buf[y * W + x] = on ? 1 : 0;
    }
    function fillRect(buf, x, y, w, h, on) {
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPx(buf, i, j, on);
    }
    function strokeRect(buf, x, y, w, h) {
        for (let i = x; i < x + w; i++) { setPx(buf, i, y, 1); setPx(buf, i, y + h - 1, 1); }
        for (let j = y; j < y + h; j++) { setPx(buf, x, j, 1); setPx(buf, x + w - 1, j, 1); }
    }
    function textWidth(text, size = 1) { return text.length * 6 * size - size; }
    function drawText(buf, x, y, text, size = 1) {
        for (const ch of text) {
            let code = ch.charCodeAt(0);
            if (code < 32 || code > 126) code = 63;   // "?"
            for (let c = 0; c < 5; c++) {
                const col = FONT[(code - 32) * 5 + c];
                for (let r = 0; r < 8; r++) {
                    if ((col >> r) & 1) fillRect(buf, x + c * size, y + r * size, size, size, 1);
                }
            }
            x += 6 * size;
        }
    }
    // Copies a page-order picture of w x h into the screen at (x, y).
    function blit(buf, pages, x, y, w, h) {
        const bits = codec.bitsFromPages(pages, w, h);
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPx(buf, x + i, y + j, bits[j * w + i]);
    }
    function present(canvas, buf) {
        const ctx = canvas.getContext("2d");
        const img = ctx.createImageData(W, H);
        for (let k = 0, p = 0; k < buf.length; k++, p += 4) {
            if (buf[k]) { img.data[p] = LIT[0]; img.data[p + 1] = LIT[1]; img.data[p + 2] = LIT[2]; }
            img.data[p + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    }

    // ------------------------------------------------------------------ the three mockups

    function padContext() {
        const app = g.DriftPadApp;
        let layer = 0, label = "ESC";
        try {
            layer = app.ui.layer;
            label = (app.draft.get(layer, app.ui.key).label || "").toUpperCase() || "KEY";
        } catch (e) { /* the page without app.js (tests) */ }
        const name = (K && K.LAYER_NAMES[layer]) || `Layer ${layer}`;
        return { strip: `L${layer} ${name.toUpperCase()}`.slice(0, 13), label: label.slice(0, 4) };
    }

    function drawStrip(buf, strip) {
        fillRect(buf, 0, 0, W, 9, 0);
        drawText(buf, 1, 1, strip);
        const chip = "READY";
        drawText(buf, W - 1 - textWidth(chip), 1, chip);
    }

    function drawSaver(buf, frame, name, sinceMs) {
        blit(buf, frame, 0, 0, W, H);
        if (sinceMs >= BADGE_MS) return;
        const text = name.toUpperCase().slice(0, 18);
        const w = textWidth(text) + 8;
        const x = Math.floor((W - w) / 2);
        fillRect(buf, x, 52, w, 11, 0);
        strokeRect(buf, x, 52, w, 11);
        drawText(buf, x + 4, 54, text);
    }

    function drawHome(buf, frame, ctx) {
        blit(buf, frame, 0, 0, W, H);
        drawStrip(buf, ctx.strip);
    }

    function drawLayer(buf, thumb, ctx) {
        drawStrip(buf, ctx.strip);
        strokeRect(buf, 2, 19, 76, 27);
        const size = textWidth(ctx.label, 2) > 70 ? 1 : 2;
        drawText(buf, 2 + Math.floor((76 - textWidth(ctx.label, size)) / 2), 19 + Math.floor((27 - 7 * size) / 2), ctx.label, size);
        strokeRect(buf, 2, 49, 76, 3);
        if (thumb) blit(buf, thumb, THUMB.x, THUMB.y, THUMB.w, THUMB.h);
    }

    // ------------------------------------------------------------------ state

    const engine = new GC.Engine({ workerUrl: "js/gif_worker.js" });
    const state = {
        name: "", info: null, main: null, thumb: null,
        playing: true, startedAt: 0, pausedAt: 0, shownIndex: -1, generation: 0, timer: 0,
    };

    function options() {
        return {
            fit: $("labFit").value,
            dither: $("labDither").value,
            brightness: Number($("labBright").value),
            contrast: Number($("labContrast").value),
            invert: $("labInvert").checked,
            speed: Number($("labSpeed").value),
            first: Number($("labFirst").value) - 1,
            last: Number($("labLast").value) - 1,
        };
    }

    function showWork(on, text) {
        $("labWork").hidden = !on;
        if (text !== undefined) $("labProgressText").textContent = text;
    }
    function progress(done, total, stage) {
        $("labProgress").max = total;
        $("labProgress").value = done;
        $("labProgressText").textContent = `${stage} frame ${done} of ${total}…`;
    }
    function setSource(text, kind) {
        const el = $("labSource");
        el.textContent = text;
        el.classList.toggle("error", kind === "error");
    }

    function kb(bytes) { return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-US")} KB`; }

    function showSize() {
        const r = state.main;
        if (!r) { $("labSize").textContent = ""; $("labMeter").value = 0; return; }
        const used = r.footprint.storedBytes;
        const share = used / codec.STORE_BYTES;
        const pct = share < 0.01 ? "under 1%" : `${Math.round(share * 100)}%`;
        $("labSize").textContent = `Needs ${kb(used)} of the pad's ${kb(codec.STORE_BYTES)} for animations (${pct}). ` +
            `${r.frames.length} frame${r.frames.length === 1 ? "" : "s"}, packed ${(r.frames.length * codec.FRAME_BYTES / Math.max(1, r.packedBytes)).toFixed(1)} times smaller.`;
        $("labSize").classList.toggle("error", used > codec.STORE_BYTES);
        $("labMeter").value = Math.min(1, share);
    }

    async function convert() {
        if (!state.info) return;
        const gen = ++state.generation;
        const opt = options();
        showWork(true, "Converting…");
        try {
            const main = await engine.render(Object.assign({}, opt, { width: W, height: H }), progress);
            if (gen !== state.generation) return;
            const thumb = await engine.render(Object.assign({}, opt, { width: THUMB.w, height: THUMB.h }), progress);
            if (gen !== state.generation) return;
            state.main = main;
            state.thumb = thumb;
            state.startedAt = performance.now();
            state.pausedAt = state.startedAt;
            state.shownIndex = -1;
            showWork(false);
            showSize();
            $("labPlay").disabled = main.frames.length < 2;
            draw(true);
        } catch (e) {
            if (e && e.cancelled) return;
            if (gen !== state.generation) return;
            showWork(false);
            setSource(`Could not convert it: ${e.message}`, "error");
        }
    }

    function convertSoon() {
        clearTimeout(state.timer);
        state.timer = setTimeout(convert, DEBOUNCE_MS);
    }

    function typeOf(file) {
        if (file.type) return file.type;
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        return { gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "";
    }

    async function loadFile(file) {
        if (!file) return;
        const gen = ++state.generation;
        clearTimeout(state.timer);
        state.info = state.main = state.thumb = null;
        $("labControls").disabled = true;
        $("labPlay").disabled = true;
        showSize();
        setSource(`Reading ${file.name}…`);
        showWork(true, "Reading…");
        try {
            const bytes = await file.arrayBuffer();
            const info = await engine.load(bytes, typeOf(file), progress);
            if (gen !== state.generation) return;
            state.info = info;
            state.name = file.name.replace(/\.[^.]+$/, "");
            const secs = (info.durationMs / 1000).toFixed(1);
            const cut = info.sourceFrames > info.frameCount ? ` (the first ${info.frameCount} of ${info.sourceFrames})` : "";
            setSource(info.frameCount > 1
                ? `${file.name}: ${info.width} × ${info.height}, ${info.frameCount} frames${cut}, ${secs} s per loop.`
                : `${file.name}: ${info.width} × ${info.height}, a still picture.`, "ok");
            for (const id of ["labFirst", "labLast"]) $(id).max = String(info.frameCount);
            $("labFirst").value = "1";
            $("labLast").value = String(info.frameCount);
            $("labControls").disabled = false;
            await convert();
        } catch (e) {
            if (e && e.cancelled) return;
            if (gen !== state.generation) return;
            showWork(false);
            setSource(`Could not read ${file.name}: ${e.message}`, "error");
        }
    }

    // ------------------------------------------------------------------ playback

    function elapsed() {
        return (state.playing ? performance.now() : state.pausedAt) - state.startedAt;
    }

    function frameAt(ms) {
        const d = state.main.delays;
        const loop = d.reduce((a, b) => a + b, 0);
        let t = loop > 0 ? ms % loop : 0;
        for (let i = 0; i < d.length; i++) {
            if (t < d[i]) return i;
            t -= d[i];
        }
        return d.length - 1;
    }

    function draw(force) {
        if (!state.main) return;
        const ms = elapsed();
        const i = frameAt(ms);
        const badgeChange = ms < BADGE_MS + 100;
        if (!force && i === state.shownIndex && !badgeChange) return;
        state.shownIndex = i;
        const ctx = padContext();
        const saver = new Uint8Array(W * H), home = new Uint8Array(W * H), layer = new Uint8Array(W * H);
        drawSaver(saver, state.main.frames[i], state.name, ms);
        drawHome(home, state.main.frames[i], ctx);
        drawLayer(layer, state.thumb && state.thumb.frames[Math.min(i, state.thumb.frames.length - 1)], ctx);
        present($("labSaver"), saver);
        present($("labHome"), home);
        present($("labLayer"), layer);
        const n = state.main.frames.length;
        $("labFrame").textContent = n > 1 ? `Frame ${i + 1} of ${n}${state.playing ? "" : " (paused)"}` : "A still picture";
    }

    function tick() {
        if (!$("panel-screen").hidden) draw(false);
        g.requestAnimationFrame(tick);
    }

    // ------------------------------------------------------------------ wiring

    function wire() {
        $("labFile").addEventListener("change", e => {
            loadFile(e.target.files[0]);
            e.target.value = "";
        });
        const drop = $("labDrop");
        drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
        drop.addEventListener("dragleave", () => drop.classList.remove("over"));
        drop.addEventListener("drop", e => {
            e.preventDefault();
            drop.classList.remove("over");
            const f = e.dataTransfer && e.dataTransfer.files[0];
            if (f) loadFile(f);
        });
        for (const id of ["labFit", "labDither", "labSpeed", "labInvert", "labFirst", "labLast"]) {
            $(id).addEventListener("change", convertSoon);
        }
        for (const [id, out] of [["labBright", "labBrightVal"], ["labContrast", "labContrastVal"]]) {
            $(id).addEventListener("input", () => { $(out).textContent = $(id).value; convertSoon(); });
        }
        $("labCancel").addEventListener("click", () => {
            state.generation++;
            clearTimeout(state.timer);
            engine.cancel();
            showWork(false);
            setSource(state.main ? "Stopped; the preview shows the last finished conversion." : "Stopped.");
        });
        $("labPlay").addEventListener("click", () => {
            const now = performance.now();
            if (state.playing) {
                state.pausedAt = now;
            } else {
                state.startedAt += now - state.pausedAt;
            }
            state.playing = !state.playing;
            $("labPlay").textContent = state.playing ? "Pause" : "Play";
            draw(true);
        });
        // The layer picture mockup shows the layer and key chosen on the Keys tab
        g.addEventListener("hashchange", () => draw(true));
        g.requestAnimationFrame(tick);
    }

    wire();

    g.DriftPadScreenLab = { state, engine, loadFile, convert, options, padContext };
})(window);
