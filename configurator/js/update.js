/*
 * update.js - updating the pad's firmware from this page without opening the case.
 *
 * The published site carries its verified firmware (driftpad.uf2) and that build's manifest
 * (firmware/build_manifest.json), both added by .github/workflows/pages.yml. An update is:
 *   1. BOOTSEL over serial: the pad restarts into its USB bootloader and shows up as the RPI-RP2
 *      drive, as if its button had been held while plugging it in;
 *   2. the user copies driftpad.uf2 onto that drive (a page cannot write to a drive by itself), and
 *      the pad restarts with the new firmware; its settings and calibration are kept, since the
 *      file never reaches the settings sectors (docs/flash-layout.md);
 *   3. the browser reports the pad's serial port again (navigator.serial "connect"), and the page
 *      reconnects to it without asking, because the user already chose that port.
 * The physical button is only needed for a pad without working DriftPad firmware.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};

    const FILE = "driftpad.uf2";
    const MANIFEST = "firmware/build_manifest.json";

    // The firmware this site offers: {fw, build, date}, or null when the page has none (opened from
    // the repository or the desktop app, or the manifest is missing or malformed)
    async function loadSiteFirmware(fetchFn) {
        if (typeof fetchFn !== "function") return null;
        try {
            const r = await fetchFn(MANIFEST, { cache: "no-store" });
            if (!r || !r.ok) return null;
            const m = await r.json();
            if (!m || typeof m.build_id !== "string" || !m.build_id || typeof m.fw_version !== "string") return null;
            return { fw: m.fw_version, build: m.build_id, date: typeof m.commit_date === "string" ? m.commit_date : null };
        } catch (e) {
            return null;
        }
    }

    // What the pad runs (INFO build and build_date, the git commit and its ISO date) against what the
    // site offers: "current" (the same build), "update" (the site's commit is newer), "older" (the
    // pad runs a newer commit than the site's), "different" (another build of unknown age) or
    // "unknown" (the pad's build is not known)
    function compare(info, site) {
        if (!info || !site || typeof info.build !== "string" || !info.build || info.build === "unknown") return "unknown";
        if (info.build === site.build) return "current";
        const padDate = Date.parse(info.build_date), siteDate = Date.parse(site.date);
        if (Number.isFinite(padDate) && Number.isFinite(siteDate) && padDate !== siteDate) return siteDate > padDate ? "update" : "older";
        return "different";
    }

    DP.update = Object.freeze({ FILE, MANIFEST, loadSiteFirmware, compare });
})(typeof window !== "undefined" ? window : globalThis);
