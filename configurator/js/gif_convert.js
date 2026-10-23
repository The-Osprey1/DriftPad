/*
 * gif_convert.js - turns a GIF (or a PNG, JPEG or WebP picture) into the pad's black-and-white
 * frames, for the Screen Lab.
 *
 * Steps:
 * 1. load(): the browser's own ImageDecoder decodes every frame once (Chrome and Edge, which the
 *    configurator needs anyway for the serial link). Each frame is kept as a small grey picture
 *    just big enough to cover 128 x 64, with its delay.
 * 2. render(options): crops or scales each kept frame to the requested size (Fit, Fill or
 *    Stretch), applies brightness, contrast and invert, dithers it to black and white, and packs
 *    the result with anim_codec.js. Changing a slider only repeats this step.
 *
 * Both steps yield between frames, so they can be cancelled and report progress. Engine runs them
 * in a Web Worker (gif_worker.js) so a 200-frame GIF never stalls the page or the serial link;
 * when no worker can start (some pages opened from a local file) it runs the same code on the page.
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad = g.DriftPad || {};
    const codec = DP.animCodec;

    const MAX_FRAMES = 1000;
    const MAX_CACHE_SIDE = 512;
    const MIN_DELAY_MS = 20;
    const DEFAULT_DELAY_MS = 100;    // what browsers show for a GIF frame with no (or a tiny) delay
    const FIT_MODES = ["fit", "fill", "stretch"];
    const DITHER_MODES = ["pattern", "diffuse", "threshold"];
    const DEFAULT_OPTIONS = {
        width: codec.WIDTH, height: codec.HEIGHT, fit: "fit", dither: "pattern",
        brightness: 0, contrast: 0, invert: false, speed: 1, first: 0, last: null,
    };
    const BAYER4 = [
        [0, 8, 2, 10],
        [12, 4, 14, 6],
        [3, 11, 1, 9],
        [15, 7, 13, 5],
    ];

    class CancelledError extends Error {
        constructor() { super("cancelled"); this.cancelled = true; }
    }

    const nextTurn = () => new Promise(r => setTimeout(r, 0));

    // ------------------------------------------------------------------ pixel steps (pure)

    // Grey picture -> part of a w x h picture, by the fit mode. Shrinking averages the source
    // pixels each output pixel covers; enlarging (small pixel art) repeats pixels, keeping edges
    // crisp. Areas the picture does not cover stay black.
    function placeGray(src, sw, sh, w, h, fit) {
        const out = new Float32Array(w * h);
        let sx = 0, sy = 0, cw = sw, ch = sh;      // source rectangle
        let dx = 0, dy = 0, dw = w, dh = h;        // destination rectangle
        if (fit === "fit") {
            const s = Math.min(w / sw, h / sh);
            dw = Math.max(1, Math.round(sw * s));
            dh = Math.max(1, Math.round(sh * s));
            dx = Math.floor((w - dw) / 2);
            dy = Math.floor((h - dh) / 2);
        } else if (fit === "fill") {
            const s = Math.max(w / sw, h / sh);
            cw = Math.min(sw, w / s);
            ch = Math.min(sh, h / s);
            sx = (sw - cw) / 2;
            sy = (sh - ch) / 2;
        } else if (fit !== "stretch") {
            throw new Error(`unknown shape ${fit}`);
        }
        const stepX = cw / dw, stepY = ch / dh;
        for (let j = 0; j < dh; j++) {
            const y0 = sy + j * stepY, y1 = y0 + stepY;
            let ya = Math.floor(y0), yb = Math.ceil(y1) - 1;
            if (stepY < 1) ya = yb = Math.min(sh - 1, Math.floor(y0 + stepY / 2));
            yb = Math.min(sh - 1, Math.max(ya, yb));
            for (let i = 0; i < dw; i++) {
                const x0 = sx + i * stepX, x1 = x0 + stepX;
                let xa = Math.floor(x0), xb = Math.ceil(x1) - 1;
                if (stepX < 1) xa = xb = Math.min(sw - 1, Math.floor(x0 + stepX / 2));
                xb = Math.min(sw - 1, Math.max(xa, xb));
                let sum = 0, n = 0;
                for (let y = ya; y <= yb; y++) {
                    const row = y * sw;
                    for (let x = xa; x <= xb; x++) { sum += src[row + x]; n++; }
                }
                out[(dy + j) * w + dx + i] = sum / n;
            }
        }
        return out;
    }

    // Brightness and contrast run from -100 to 100; 0 leaves the picture as it is.
    function adjustGray(gray, brightness, contrast, invert) {
        const c = contrast * 2.55;
        const f = (259 * (c + 255)) / (255 * (259 - c));
        const b = brightness * 1.28;
        const out = new Float32Array(gray.length);
        for (let k = 0; k < gray.length; k++) {
            let v = f * (gray[k] - 128) + 128 + b;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            out[k] = invert ? 255 - v : v;
        }
        return out;
    }

    // Grey (0..255) -> 1 per lit pixel. "threshold" is a hard cut at half brightness; "pattern"
    // is the 4 x 4 ordered dither the pad's own animations use; "diffuse" is Floyd-Steinberg
    // error diffusion, scanning alternate rows in opposite directions.
    function ditherGray(gray, w, h, mode) {
        const bits = new Uint8Array(w * h);
        if (mode === "threshold") {
            for (let k = 0; k < bits.length; k++) bits[k] = gray[k] >= 128 ? 1 : 0;
        } else if (mode === "pattern") {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    bits[y * w + x] = gray[y * w + x] > (BAYER4[y & 3][x & 3] + 0.5) * 16 ? 1 : 0;
                }
            }
        } else if (mode === "diffuse") {
            const e = Float32Array.from(gray);
            for (let y = 0; y < h; y++) {
                const ltr = (y & 1) === 0;
                const dir = ltr ? 1 : -1;
                for (let n = 0; n < w; n++) {
                    const x = ltr ? n : w - 1 - n;
                    const k = y * w + x;
                    const lit = e[k] >= 128;
                    bits[k] = lit ? 1 : 0;
                    const err = e[k] - (lit ? 255 : 0);
                    const xn = x + dir, xp = x - dir;
                    if (xn >= 0 && xn < w) e[k + dir] += err * 7 / 16;
                    if (y + 1 < h) {
                        if (xp >= 0 && xp < w) e[k + w - dir] += err * 3 / 16;
                        e[k + w] += err * 5 / 16;
                        if (xn >= 0 && xn < w) e[k + w + dir] += err * 1 / 16;
                    }
                }
            }
        } else {
            throw new Error(`unknown dithering ${mode}`);
        }
        return bits;
    }

    function normalizeOptions(o, frameCount) {
        const opt = Object.assign({}, DEFAULT_OPTIONS, o || {});
        if (!FIT_MODES.includes(opt.fit)) throw new Error(`unknown shape ${opt.fit}`);
        if (!DITHER_MODES.includes(opt.dither)) throw new Error(`unknown dithering ${opt.dither}`);
        opt.speed = Number(opt.speed) > 0 ? Number(opt.speed) : 1;
        const last = opt.last === null || opt.last === undefined ? frameCount - 1 : opt.last;
        opt.first = Math.max(0, Math.min(frameCount - 1, Math.floor(Number(opt.first) || 0)));
        opt.last = Math.max(opt.first, Math.min(frameCount - 1, Math.floor(Number(last))));
        return opt;
    }

    // One grey frame (as kept by load) -> page-order black-and-white bytes.
    function frameToPages(frame, opt) {
        const placed = placeGray(frame.gray, frame.width, frame.height, opt.width, opt.height, opt.fit);
        const adjusted = adjustGray(placed, opt.brightness, opt.contrast, opt.invert);
        const bits = ditherGray(adjusted, opt.width, opt.height, opt.dither);
        return codec.pagesFromBits(bits, opt.width, opt.height);
    }

    // RGBA (straight alpha) -> grey composited on black, as the screen shows transparency.
    function grayFromRgba(rgba, n) {
        const gray = new Uint8Array(n);
        for (let k = 0, p = 0; k < n; k++, p += 4) {
            const a = rgba[p + 3] / 255;
            gray[k] = Math.round((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * a);
        }
        return gray;
    }

    // Size to keep a decoded frame at: big enough to cover 128 x 64 without enlarging, so every
    // shape mode can be made from it, and never bigger than MAX_CACHE_SIDE.
    function cacheSize(w, h) {
        let s = Math.min(1, Math.max(codec.WIDTH / w, codec.HEIGHT / h));
        const longest = Math.max(w, h) * s;
        if (longest > MAX_CACHE_SIDE) s *= MAX_CACHE_SIDE / longest;
        return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
    }

    // ------------------------------------------------------------------ Converter

    class Converter {
        constructor() {
            this.frames = [];     // [{ gray, width, height, delayMs }]
            this.info = null;
        }

        // bytes: ArrayBuffer of the file; type: its MIME type. progress(done, total, stage)
        async load(bytes, type, { progress, cancelled } = {}) {
            if (typeof g.ImageDecoder === "undefined") {
                throw new Error("This browser cannot decode pictures for the pad; use Chrome or Edge");
            }
            if (!(await g.ImageDecoder.isTypeSupported(type))) {
                throw new Error(`This browser cannot read ${type || "this kind of"} files; use a GIF, PNG, JPEG or WebP`);
            }
            const decoder = new g.ImageDecoder({ data: bytes, type });
            // A damaged file rejects both promises; neither may go unhandled
            const ready = decoder.tracks.ready, completed = decoder.completed;
            ready.catch(() => {});
            completed.catch(() => {});
            try {
                await ready;
                await completed;
                const track = decoder.tracks.selectedTrack;
                const total = Math.min(track ? track.frameCount : 1, MAX_FRAMES);
                if (total < 1) throw new Error("the file holds no pictures");
                const frames = [];
                let canvas = null, ctx = null, srcW = 0, srcH = 0;
                for (let i = 0; i < total; i++) {
                    if (cancelled && cancelled()) throw new CancelledError();
                    const { image } = await decoder.decode({ frameIndex: i });
                    try {
                        if (!canvas) {
                            srcW = image.displayWidth;
                            srcH = image.displayHeight;
                            const size = cacheSize(srcW, srcH);
                            canvas = new g.OffscreenCanvas(size.width, size.height);
                            ctx = canvas.getContext("2d", { willReadFrequently: true });
                            ctx.imageSmoothingEnabled = true;
                            ctx.imageSmoothingQuality = "high";
                        }
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                        const us = image.duration;
                        let delayMs = us ? Math.round(us / 1000) : DEFAULT_DELAY_MS;
                        if (delayMs < MIN_DELAY_MS) delayMs = DEFAULT_DELAY_MS;
                        frames.push({ gray: grayFromRgba(data, canvas.width * canvas.height),
                                      width: canvas.width, height: canvas.height, delayMs });
                    } finally {
                        image.close();
                    }
                    if (progress) progress(i + 1, total, "Reading");
                    if (i % 4 === 3) await nextTurn();
                }
                this.frames = frames;
                this.info = {
                    width: srcW, height: srcH, frameCount: frames.length,
                    sourceFrames: track ? track.frameCount : 1,
                    durationMs: frames.reduce((t, f) => t + f.delayMs, 0),
                };
                return this.info;
            } finally {
                decoder.close();
            }
        }

        // Frames from plain grey pictures, without decoding a file (tests).
        setFrames(frames) {
            this.frames = frames.map(f => ({ gray: f.gray, width: f.width, height: f.height, delayMs: f.delayMs || DEFAULT_DELAY_MS }));
            this.info = { width: frames[0].width, height: frames[0].height, frameCount: frames.length,
                          sourceFrames: frames.length, durationMs: this.frames.reduce((t, f) => t + f.delayMs, 0) };
            return this.info;
        }

        async render(options, { progress, cancelled } = {}) {
            if (!this.frames.length) throw new Error("load a picture first");
            const opt = normalizeOptions(options, this.frames.length);
            const total = opt.last - opt.first + 1;
            const frames = [];
            const delays = [];
            for (let i = opt.first; i <= opt.last; i++) {
                if (cancelled && cancelled()) throw new CancelledError();
                const f = this.frames[i];
                frames.push(frameToPages(f, opt));
                delays.push(Math.max(MIN_DELAY_MS, Math.min(65535, Math.round(f.delayMs / opt.speed))));
                const done = i - opt.first + 1;
                if (progress) progress(done, total, "Converting");
                if (done % 8 === 0) await nextTurn();
            }
            const packed = codec.packFrames(frames);
            return {
                width: opt.width, height: opt.height, frames, delays,
                packedBytes: packed.length,
                footprint: codec.clipFootprint(frames.length, packed.length),
            };
        }
    }

    // ------------------------------------------------------------------ Engine

    // Runs a Converter in a worker when one starts, otherwise on the page. One job at a time:
    // starting a job, or cancel(), stops the one in progress (its promise rejects with
    // { cancelled: true }).
    class Engine {
        // createWorker(url) makes the worker; tests pass one that fails, to check the page fallback.
        constructor({ workerUrl = "js/gif_worker.js", useWorker = true, createWorker = null } = {}) {
            this.workerUrl = workerUrl;
            this.createWorker = createWorker || (url => new g.Worker(url));
            this.useWorker = useWorker && (!!createWorker || typeof g.Worker !== "undefined");
            this.worker = null;
            this.local = null;
            this.job = null;
            this.nextId = 1;
            this.loadArgs = null;
            this.mode = null;          // "worker" or "page" once the first job started
        }

        cancel() {
            const job = this.job;
            if (!job) return;
            this.job = null;
            if (job.worker && this.worker) this.worker.postMessage({ cmd: "cancel", id: job.id });
            job.cancelled = true;
            job.reject(new CancelledError());
        }

        load(bytes, type, progress) {
            this.loadArgs = { bytes, type };
            return this._run("load", { bytes, type }, progress);
        }

        render(options, progress) {
            return this._run("render", { options }, progress);
        }

        _startWorker() {
            if (this.worker || !this.useWorker) return this.worker;
            try {
                this.worker = this.createWorker(this.workerUrl);
            } catch (e) {
                this.useWorker = false;
                return null;
            }
            this.worker.onmessage = e => this._onMessage(e.data);
            this.worker.onerror = e => {
                if (e && e.preventDefault) e.preventDefault();
                this._workerFailed();
            };
            return this.worker;
        }

        // The worker could not load or crashed: carry on in the page, redoing the job in progress.
        _workerFailed() {
            if (this.worker) this.worker.terminate();
            this.worker = null;
            this.useWorker = false;
            const job = this.job;
            if (!job || !job.worker) return;
            job.worker = false;
            this._runLocal(job);
        }

        _run(cmd, args, progress) {
            this.cancel();
            const job = { id: this.nextId++, cmd, args, progress, cancelled: false, worker: false };
            const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
            this.job = job;
            const worker = this._startWorker();
            if (worker) {
                job.worker = true;
                this.mode = "worker";
                const msg = Object.assign({ cmd, id: job.id }, args);
                // A copy of the file goes to the worker, so the page can still fall back to it
                worker.postMessage(cmd === "load" ? Object.assign(msg, { bytes: args.bytes.slice(0) }) : msg);
            } else {
                this._runLocal(job);
            }
            return promise;
        }

        async _runLocal(job) {
            this.mode = "page";
            if (!this.local) this.local = new Converter();
            const hooks = {
                progress: (d, t, stage) => { if (this.job === job && job.progress) job.progress(d, t, stage); },
                cancelled: () => job.cancelled,
            };
            try {
                // After a worker failure the page has not read the file yet
                if (job.cmd === "render" && !this.local.frames.length && this.loadArgs) {
                    await this.local.load(this.loadArgs.bytes, this.loadArgs.type, hooks);
                }
                const result = job.cmd === "load"
                    ? await this.local.load(job.args.bytes, job.args.type, hooks)
                    : await this.local.render(job.args.options, hooks);
                if (this.job === job) { this.job = null; job.resolve(result); }
            } catch (e) {
                if (this.job === job) { this.job = null; job.reject(e); }
            }
        }

        _onMessage(m) {
            const job = this.job;
            if (!job || !job.worker || m.id !== job.id) return;    // an answer to a cancelled job
            if (m.type === "progress") {
                if (job.progress) job.progress(m.done, m.total, m.stage);
                return;
            }
            this.job = null;
            if (m.type === "error") {
                job.reject(m.cancelled ? new CancelledError() : new Error(m.message));
            } else if (m.type === "loaded") {
                job.resolve(m.info);
            } else if (m.type === "rendered") {
                const r = m.result;
                const size = codec.pageBytes(r.width, r.height);
                const all = new Uint8Array(r.frameData);
                r.frames = [];
                for (let k = 0; k < r.delays.length; k++) r.frames.push(all.subarray(k * size, (k + 1) * size));
                delete r.frameData;
                job.resolve(r);
            }
        }
    }

    DP.gifConvert = {
        MAX_FRAMES, MIN_DELAY_MS, DEFAULT_DELAY_MS, FIT_MODES, DITHER_MODES, DEFAULT_OPTIONS,
        placeGray, adjustGray, ditherGray, normalizeOptions, frameToPages, grayFromRgba, cacheSize,
        Converter, Engine, CancelledError,
    };
})(typeof window !== "undefined" ? window : self);
