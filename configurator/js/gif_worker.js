/*
 * gif_worker.js - runs gif_convert.js's Converter off the page, so converting a long GIF never
 * stalls the page or the serial link. Engine (gif_convert.js) is the only client.
 *
 * Messages in:  { cmd: "load", id, bytes, type } | { cmd: "render", id, options } | { cmd: "cancel", id }
 * Messages out: { id, type: "progress", done, total, stage }
 *               { id, type: "loaded", info } | { id, type: "rendered", result } (frames in one buffer)
 *               { id, type: "error", message, cancelled }
 */
/* global importScripts */
importScripts("anim_codec.js", "gif_convert.js");

(function (g) {
    "use strict";
    const { Converter } = g.DriftPad.gifConvert;
    const converter = new Converter();
    let current = 0;           // id of the job running; a newer message or "cancel" stops it

    g.onmessage = async e => {
        const m = e.data;
        if (m.cmd === "cancel") {
            if (m.id === current) current = 0;
            return;
        }
        current = m.id;
        const hooks = {
            progress: (done, total, stage) => g.postMessage({ id: m.id, type: "progress", done, total, stage }),
            cancelled: () => current !== m.id,
        };
        try {
            if (m.cmd === "load") {
                const info = await converter.load(m.bytes, m.type, hooks);
                g.postMessage({ id: m.id, type: "loaded", info });
            } else if (m.cmd === "render") {
                const r = await converter.render(m.options, hooks);
                const size = r.frames.length ? r.frames[0].length : 0;
                const all = new Uint8Array(size * r.frames.length);
                r.frames.forEach((f, k) => all.set(f, k * size));
                const result = { width: r.width, height: r.height, delays: r.delays, packedBytes: r.packedBytes,
                                 footprint: r.footprint, frameData: all.buffer };
                g.postMessage({ id: m.id, type: "rendered", result }, [all.buffer]);
            }
        } catch (err) {
            g.postMessage({ id: m.id, type: "error", message: String(err && err.message || err), cancelled: !!(err && err.cancelled) });
        } finally {
            if (current === m.id) current = 0;
        }
    };
})(self);
