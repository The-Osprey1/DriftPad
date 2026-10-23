/*
 * anim_codec.js - packs black-and-white 128x64 animation frames the way the pad will store them.
 *
 * A frame is 1024 bytes in the display's own memory order (SSD1306 "pages"): byte x + 128 * page
 * holds column x of rows page * 8 .. page * 8 + 7, bit 0 at the top. The pad can copy a decoded
 * frame straight into its display buffer.
 *
 * Packing:
 * - Frame 0 is always a keyframe: the whole picture, run-length packed. Playback can start cold,
 *   and every loop restarts from it, so an error never survives a loop.
 * - Every later frame is its difference (XOR) from the frame before, run-length packed. Unchanged
 *   areas become runs of zero bytes, which pack very small.
 * - Run-length bytes: a control byte c of 0..127 is followed by c + 1 literal bytes; 128..255 is
 *   followed by one byte repeated c - 125 times (3 .. 130). Each frame's run ends exactly when
 *   its 1024 bytes are complete.
 *
 * Also used inside the conversion worker (gif_worker.js), so it touches no DOM.
 */
(function (g) {
    "use strict";
    const DP = g.DriftPad = g.DriftPad || {};

    const WIDTH = 128;
    const HEIGHT = 64;
    const FRAME_BYTES = WIDTH * HEIGHT / 8;
    const MAX_LITERAL = 128;
    const MIN_REPEAT = 3;
    const MAX_REPEAT = 130;

    // The pad's animation store (step 2 of the screen plan): 1 MB of flash, clips start on a
    // 4 KB sector, each with a header and a 2-byte delay per frame in front of its frame data.
    const STORE_BYTES = 1024 * 1024;
    const SECTOR_BYTES = 4096;
    const HEADER_BYTES = 64;

    // Bytes of a packed picture of `width` x `height` pixels in page order.
    function pageBytes(width, height) {
        return width * Math.ceil(height / 8);
    }

    // One 0/1 byte per pixel, row by row  ->  page order.
    function pagesFromBits(bits, width = WIDTH, height = HEIGHT) {
        const out = new Uint8Array(pageBytes(width, height));
        for (let y = 0; y < height; y++) {
            const row = y * width;
            const page = (y >> 3) * width;
            const mask = 1 << (y & 7);
            for (let x = 0; x < width; x++) {
                if (bits[row + x]) out[page + x] |= mask;
            }
        }
        return out;
    }

    // Page order  ->  one 0/1 byte per pixel, row by row.
    function bitsFromPages(pages, width = WIDTH, height = HEIGHT) {
        const out = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            const page = (y >> 3) * width;
            const shift = y & 7;
            for (let x = 0; x < width; x++) out[y * width + x] = (pages[page + x] >> shift) & 1;
        }
        return out;
    }

    function rleEncode(src, out) {
        let i = 0;
        let litStart = -1;
        const flushLiteral = end => {
            while (litStart >= 0 && litStart < end) {
                const n = Math.min(MAX_LITERAL, end - litStart);
                out.push(n - 1);
                for (let k = 0; k < n; k++) out.push(src[litStart + k]);
                litStart += n;
            }
            litStart = -1;
        };
        while (i < src.length) {
            let run = 1;
            while (i + run < src.length && run < MAX_REPEAT && src[i + run] === src[i]) run++;
            if (run >= MIN_REPEAT) {
                flushLiteral(i);
                out.push(run + 125, src[i]);
                i += run;
            } else {
                if (litStart < 0) litStart = i;
                i += run;
            }
        }
        flushLiteral(src.length);
    }

    // Decodes one frame's run into `dst` (length bytes) from data[pos]; returns the next position.
    function rleDecode(data, pos, dst) {
        let o = 0;
        while (o < dst.length) {
            if (pos >= data.length) throw new Error("packed animation ends inside a frame");
            const c = data[pos++];
            if (c < 128) {
                const n = c + 1;
                if (o + n > dst.length || pos + n > data.length) throw new Error("packed literal overruns the frame");
                for (let k = 0; k < n; k++) dst[o++] = data[pos++];
            } else {
                const n = c - 125;
                if (o + n > dst.length || pos >= data.length) throw new Error("packed run overruns the frame");
                dst.fill(data[pos++], o, o + n);
                o += n;
            }
        }
        return pos;
    }

    // frames: equal-length Uint8Arrays (page order). Returns the packed bytes.
    function packFrames(frames) {
        const out = [];
        let prev = null;
        for (const f of frames) {
            if (prev && f.length !== prev.length) throw new Error("every frame must be the same size");
            if (!prev) {
                rleEncode(f, out);
            } else {
                const diff = new Uint8Array(f.length);
                for (let k = 0; k < f.length; k++) diff[k] = f[k] ^ prev[k];
                rleEncode(diff, out);
            }
            prev = f;
        }
        return Uint8Array.from(out);
    }

    // The reverse of packFrames: `count` frames of `frameBytes` each.
    function unpackFrames(data, count, frameBytes = FRAME_BYTES) {
        const frames = [];
        let pos = 0;
        let prev = null;
        for (let i = 0; i < count; i++) {
            const cur = new Uint8Array(frameBytes);
            pos = rleDecode(data, pos, cur);
            if (prev) for (let k = 0; k < frameBytes; k++) cur[k] ^= prev[k];
            frames.push(cur);
            prev = cur;
        }
        if (pos !== data.length) throw new Error("packed animation has bytes after its last frame");
        return frames;
    }

    // Flash a clip of `frameCount` frames and `packedBytes` of frame data takes in the pad's store.
    function clipFootprint(frameCount, packedBytes) {
        const bytes = HEADER_BYTES + 2 * frameCount + packedBytes;
        const sectors = Math.ceil(bytes / SECTOR_BYTES);
        return { bytes, sectors, storedBytes: sectors * SECTOR_BYTES };
    }

    DP.animCodec = {
        WIDTH, HEIGHT, FRAME_BYTES, STORE_BYTES, SECTOR_BYTES, HEADER_BYTES,
        pageBytes, pagesFromBits, bitsFromPages, packFrames, unpackFrames, clipFootprint,
    };
})(typeof window !== "undefined" ? window : self);
