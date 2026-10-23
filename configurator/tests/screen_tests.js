/*
 * screen_tests.js - anim_codec.js (frame packing) and gif_convert.js (picture conversion) for the
 * Screen Lab. Registered with harness.js; run by screen.html (tests/test_configurator_js.py) on the
 * real clock: the browser decodes pictures and runs the worker off the page's thread, which
 * Chrome's simulated test clock does not wait for.
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad;
    const codec = DP.animCodec;
    const GC = DP.gifConvert;
    const FIXTURE = "../../tests/fixtures/screen_lab_three_frames.gif";

    function loadBytes(relPath) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", relPath);
            xhr.responseType = "arraybuffer";
            xhr.onload = () => resolve(xhr.response);
            xhr.onerror = () => reject(new Error(`could not read ${relPath}`));
            xhr.send();
        });
    }

    // Deterministic pseudo-random bytes
    function noise(n, seed, density = 1) {
        const out = new Uint8Array(n);
        let s = seed >>> 0 || 1;
        for (let k = 0; k < n; k++) {
            s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
            out[k] = (s % 1000) / 1000 < density ? s & 0xff : 0;
        }
        return out;
    }

    const same = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);
    const lit = (bits, w, x, y) => bits[y * w + x];

    // ------------------------------------------------------------------------------ anim_codec
    test("screen codec: page order and pixel rows convert both ways, including heights that are not a multiple of 8", () => {
        for (const [w, h] of [[128, 64], [42, 42], [5, 3]]) {
            const bits = noise(w * h, w + h).map(v => v & 1);
            const pages = codec.pagesFromBits(bits, w, h);
            assertEq(pages.length, codec.pageBytes(w, h), `${w}x${h} byte count`);
            assert(same(codec.bitsFromPages(pages, w, h), bits), `${w}x${h} round trip`);
        }
        const one = new Uint8Array(128 * 64);
        one[9 * 128 + 3] = 1;                       // x 3, y 9: page 1, bit 1
        const p = codec.pagesFromBits(one);
        assertEq(p[128 + 3], 2, "SSD1306 page layout");
    });

    test("screen codec: runs and literals pack to the documented bytes", () => {
        const blank = new Uint8Array(1024);
        assertEq(Array.from(codec.packFrames([blank])), [255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 239, 0],
            "1024 zero bytes: seven runs of 130 and one of 114");
        const f = new Uint8Array(1024);
        f.set([5, 5, 5, 5, 1, 2], 0);
        const packed = codec.packFrames([f]);
        assertEq(Array.from(packed.slice(0, 5)), [129, 5, 1, 1, 2], "a run of four, then two literals");
    });

    test("screen codec: frames survive packing exactly, frame 0 is a keyframe and changes cost little", () => {
        const frames = [noise(1024, 7)];
        for (let i = 1; i < 6; i++) {
            const f = Uint8Array.from(frames[i - 1]);
            f[i * 37] ^= 0xff;                      // one changed byte per frame
            frames.push(f);
        }
        const packed = codec.packFrames(frames);
        const back = codec.unpackFrames(packed, frames.length);
        frames.forEach((f, i) => assert(same(back[i], f), `frame ${i}`));
        const first = codec.packFrames([frames[0]]);
        assert(same(packed.subarray(0, first.length), first), "frame 0 is packed on its own, not as a difference");
        assert(packed.length - first.length < 5 * 24, `difference frames are small: ${packed.length - first.length} bytes`);
        assert(same(codec.unpackFrames(first, 1)[0], frames[0]), "frame 0 decodes cold");
    });

    test("screen codec: damaged packed data is refused", () => {
        const packed = codec.packFrames([noise(1024, 3), noise(1024, 4)]);
        let threw = 0;
        for (const bad of [packed.subarray(0, packed.length - 1), Uint8Array.from([...packed, 0, 0])]) {
            try { codec.unpackFrames(bad, 2); } catch (e) { threw++; }
        }
        assertEq(threw, 2, "short and over-long data both throw");
    });

    test("screen codec: a clip's flash footprint rounds up to whole 4 KB sectors", () => {
        assertEq(codec.clipFootprint(3, 100), { bytes: 64 + 6 + 100, sectors: 1, storedBytes: 4096 });
        assertEq(codec.clipFootprint(10, 4096).sectors, 2);
        assertEq(codec.STORE_BYTES, 1024 * 1024);
    });

    // ------------------------------------------------------------------------------ gif_convert
    test("screen convert: the three shadings on flat grey", () => {
        const flat = v => new Float32Array(64 * 64).fill(v);
        const count = bits => bits.reduce((a, b) => a + b, 0);
        for (const mode of GC.DITHER_MODES) {
            assertEq(count(GC.ditherGray(flat(0), 64, 64, mode)), 0, `${mode}: black stays black`);
            assertEq(count(GC.ditherGray(flat(255), 64, 64, mode)), 64 * 64, `${mode}: white stays white`);
        }
        assertEq(count(GC.ditherGray(flat(127), 64, 64, "threshold")), 0, "threshold: just under half is dark");
        assertEq(count(GC.ditherGray(flat(128), 64, 64, "threshold")), 64 * 64, "threshold: half is lit");
        assertEq(count(GC.ditherGray(flat(128), 64, 64, "pattern")), 64 * 64 / 2, "pattern: half grey lights half the pixels");
        const diffuse = count(GC.ditherGray(flat(128), 64, 64, "diffuse")) / (64 * 64);
        assert(diffuse > 0.45 && diffuse < 0.55, `diffuse: half grey lights about half (${diffuse})`);
        const quarter = count(GC.ditherGray(flat(64), 64, 64, "pattern")) / (64 * 64);
        assertEq(quarter, 0.25, "pattern: quarter grey lights a quarter");
    });

    test("screen convert: Fit, Fill and Stretch place a wide picture as described", () => {
        // 8 x 4 source: left half white, right half black
        const src = new Uint8Array(32);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) src[y * 8 + x] = 255;
        const fit = GC.placeGray(src, 8, 4, 4, 4, "fit");
        assertEq(Array.from(fit), [0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0], "fit: black bars above and below");
        const fill = GC.placeGray(src, 8, 4, 4, 4, "fill");
        assertEq(Array.from(fill.subarray(0, 4)), [255, 255, 0, 0], "fill: the middle half, cropped");
        const stretch = GC.placeGray(src, 8, 4, 4, 2, "stretch");
        assertEq(Array.from(stretch), [255, 255, 0, 0, 255, 255, 0, 0], "stretch: everything, squeezed");
        const up = GC.placeGray(Uint8Array.from([0, 255]), 2, 1, 4, 2, "stretch");
        assertEq(Array.from(up), [0, 0, 255, 255, 0, 0, 255, 255], "enlarging repeats pixels (crisp pixel art)");
    });

    test("screen convert: brightness, contrast and invert", () => {
        const g0 = Float32Array.from([0, 128, 255]);
        assertEq(Array.from(GC.adjustGray(g0, 0, 0, false)), [0, 128, 255], "zero changes nothing");
        assertEq(Array.from(GC.adjustGray(g0, 0, 0, true)), [255, 127, 0], "invert");
        assertEq(Array.from(GC.adjustGray(g0, 100, 0, false)), [128, 255, 255], "brightness clamps at white");
        const c = GC.adjustGray(Float32Array.from([100, 156]), 0, 50, false);
        assert(c[0] < 100 && c[1] > 156, "contrast pushes away from mid grey");
    });

    test("screen convert: trimming and speed set the frames and delays", async () => {
        const conv = new GC.Converter();
        const frames = [0, 85, 170, 255].map((v, i) => ({ gray: new Uint8Array(16 * 8).fill(v), width: 16, height: 8, delayMs: 100 + i }));
        conv.setFrames(frames);
        const r = await conv.render({ first: 1, last: 2, speed: 2 });
        assertEq(r.frames.length, 2, "frames 2 and 3 only");
        assertEq(r.delays, [51, 51], "twice as fast halves the delays");
        assertEq(r.frames[0].length, 1024, "128 x 64 in page order");
        const slow = await conv.render({ speed: 10 });
        assertEq(slow.delays[0], GC.MIN_DELAY_MS, "never faster than the minimum delay");
        const all = await conv.render({});
        assertEq(all.packedBytes, codec.packFrames(all.frames).length, "packed size is the codec's");
        assertEq(all.footprint, codec.clipFootprint(4, all.packedBytes));
    });

    test("screen convert: a real GIF decodes with its frames and delays", async () => {
        const conv = new GC.Converter();
        const info = await conv.load(await loadBytes(FIXTURE), "image/gif");
        assertEq([info.width, info.height, info.frameCount], [64, 32, 3]);
        assertEq(conv.frames.map(f => f.delayMs), [100, 250, 50]);
        const r = await conv.render({ fit: "fit", dither: "threshold" });
        const bits = r.frames.map(f => codec.bitsFromPages(f));
        assert(lit(bits[0], 128, 10, 32) && !lit(bits[0], 128, 100, 32), "frame 1: left half lit");
        assert(!lit(bits[1], 128, 10, 32) && lit(bits[1], 128, 100, 32), "frame 2: right half lit");
        assert(lit(bits[2], 128, 10, 32) && lit(bits[2], 128, 100, 32), "frame 3: all lit");
    });

    test("screen convert: unreadable files are refused with a message", async () => {
        const conv = new GC.Converter();
        let msg = "";
        try { await conv.load(new Uint8Array([1, 2, 3]).buffer, "image/gif"); } catch (e) { msg = e.message; }
        assert(msg, "garbage GIF throws");
        msg = "";
        try { await conv.load(new Uint8Array([1]).buffer, "text/plain"); } catch (e) { msg = e.message; }
        assert(/GIF, PNG, JPEG or WebP/.test(msg), `unsupported type explains: ${msg}`);
    });

    test("screen engine: the worker and the page give identical frames", async () => {
        const bytes = await loadBytes(FIXTURE);
        const page = new GC.Engine({ useWorker: false });
        await page.load(bytes, "image/gif");
        const a = await page.render({ dither: "diffuse" });
        assertEq(page.mode, "page");
        const worker = new GC.Engine({ workerUrl: "../js/gif_worker.js" });
        const progress = [];
        const info = await worker.load(bytes, "image/gif", (d, t, stage) => progress.push(`${stage} ${d}/${t}`));
        assertEq(info.frameCount, 3);
        const b = await worker.render({ dither: "diffuse" });
        assertEq(worker.mode, "worker", "converted in the worker, not on the page");
        assert(progress.includes("Reading 3/3"), `progress reported: ${progress}`);
        assertEq(b.delays, a.delays);
        assertEq(b.packedBytes, a.packedBytes);
        a.frames.forEach((f, i) => assert(same(b.frames[i], f), `frame ${i} matches`));
    });

    test("screen engine: a worker that fails to start hands the job to the page", async () => {
        const bytes = await loadBytes(FIXTURE);
        const broken = new GC.Engine({ createWorker: () => { throw new Error("SecurityError"); } });
        assertEq((await broken.load(bytes, "image/gif")).frameCount, 3);
        assertEq(broken.mode, "page");
        let fail = null;
        const crashing = new GC.Engine({ createWorker: () => (fail = { postMessage() { setTimeout(() => fail.onerror({}), 0); }, terminate() {} }) });
        assertEq((await crashing.load(bytes, "image/gif")).frameCount, 3, "a load in progress is redone on the page");
        assertEq(crashing.mode, "page");
        assertEq((await crashing.render({})).frames.length, 3, "later jobs stay on the page");
    });

    test("screen engine: a new job or cancel() stops the one in progress", async () => {
        const engine = new GC.Engine({ useWorker: false });
        engine.local = new GC.Converter();
        engine.local.setFrames(Array.from({ length: 64 }, (_, i) => ({ gray: new Uint8Array(128 * 64).fill(i * 4), width: 128, height: 64 })));
        const first = engine.render({});
        const second = engine.render({ dither: "threshold" });
        let cancelled = false;
        try { await first; } catch (e) { cancelled = !!e.cancelled; }
        assert(cancelled, "the first job was cancelled");
        assertEq((await second).frames.length, 64, "the second job finished");
        const third = engine.render({});
        engine.cancel();
        cancelled = false;
        try { await third; } catch (e) { cancelled = !!e.cancelled; }
        assert(cancelled, "cancel() stops it");
    });
})(window);
