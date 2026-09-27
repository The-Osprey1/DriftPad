/*
 * harness.js - a tiny in-browser test harness for the configurator (no dependencies).
 *
 * test(name, async fn) registers a test; runTests() runs them in order and writes
 * {"passed","failed","tests":[{"name","ok","error"}],"errors":[uncaught]} into <pre id="results">,
 * which tests/test_configurator_js.py reads from headless Chrome (--dump-dom).
 */
(function (g) {
    "use strict";
    const tests = [];
    const uncaught = [];
    g.addEventListener("error", e => uncaught.push(String(e.message || e)));
    g.addEventListener("unhandledrejection", e => uncaught.push("unhandled rejection: " + String(e.reason && e.reason.message || e.reason)));

    g.test = (name, fn) => tests.push({ name, fn });
    g.assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
    g.assertEq = (actual, expected, msg) => {
        const a = JSON.stringify(actual), e = JSON.stringify(expected);
        if (a !== e) throw new Error(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
    };
    g.sleep = ms => new Promise(r => setTimeout(r, ms));
    g.waitUntil = async (fn, ms = 3000, step = 10) => {
        const t0 = Date.now();
        for (;;) {
            let ok = false;
            try { ok = !!fn(); } catch (e) { ok = false; }
            if (ok) return true;
            if (Date.now() - t0 > ms) return false;
            await g.sleep(step);
        }
    };
    g.runTests = async () => {
        const out = { passed: 0, failed: 0, tests: [], errors: uncaught };
        for (const t of tests) {
            try {
                await t.fn();
                out.passed++;
                out.tests.push({ name: t.name, ok: true });
            } catch (e) {
                out.failed++;
                out.tests.push({ name: t.name, ok: false, error: String((e && e.stack) || e) });
            }
        }
        let pre = document.getElementById("results");
        if (!pre) {
            pre = document.createElement("pre");
            pre.id = "results";
            document.body.appendChild(pre);
        }
        pre.textContent = JSON.stringify(out);
        document.title = "done";
    };
})(window);
