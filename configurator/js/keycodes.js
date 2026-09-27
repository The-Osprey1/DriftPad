/*
 * keycodes.js - key catalog (Arduino Keyboard codes, arduino-pico HID_Keyboard.h), default keymaps
 * and assignability.
 *
 * Classic script on window.DriftPad. `ev` is the KeyboardEvent.code used for "press a key to
 * assign". Every catalog label satisfies the label rule (contract.js normalizeLabel);
 * tests/test_configurator.py and configurator/tests/keycodes.test.js check that.
 */
(function (global) {
    "use strict";
    const DP = global.DriftPad = global.DriftPad || {};

    // [category, code, name, label, KeyboardEvent.code]
    const CATALOG_ROWS = [
        ["Basic", 0, "None", "NONE", null],
        ["Basic", 0xB1, "Esc", "ESC", "Escape"],
        ["Basic", 0xB0, "Enter", "ENT", "Enter"],
        ["Basic", 0xB3, "Tab", "TAB", "Tab"],
        ["Basic", 0xB2, "Backspace", "BSPC", "Backspace"],
        ["Basic", 32, "Space", "SPCE", "Space"],
        ["Basic", 0xC1, "Caps Lock", "CAPS", "CapsLock"],
        ["Basic", 0xED, "Menu", "MENU", "ContextMenu"],
        ["Basic", 0xCE, "Print Screen", "PRSC", "PrintScreen"],
        ["Basic", 0xCF, "Scroll Lock", "SCRL", "ScrollLock"],
        ["Basic", 0xD0, "Pause", "PAUS", "Pause"],
        ["Letters", 97, "A", "A", "KeyA"],
        ["Letters", 98, "B", "B", "KeyB"],
        ["Letters", 99, "C", "C", "KeyC"],
        ["Letters", 100, "D", "D", "KeyD"],
        ["Letters", 101, "E", "E", "KeyE"],
        ["Letters", 102, "F", "F", "KeyF"],
        ["Letters", 103, "G", "G", "KeyG"],
        ["Letters", 104, "H", "H", "KeyH"],
        ["Letters", 105, "I", "I", "KeyI"],
        ["Letters", 106, "J", "J", "KeyJ"],
        ["Letters", 107, "K", "K", "KeyK"],
        ["Letters", 108, "L", "L", "KeyL"],
        ["Letters", 109, "M", "M", "KeyM"],
        ["Letters", 110, "N", "N", "KeyN"],
        ["Letters", 111, "O", "O", "KeyO"],
        ["Letters", 112, "P", "P", "KeyP"],
        ["Letters", 113, "Q", "Q", "KeyQ"],
        ["Letters", 114, "R", "R", "KeyR"],
        ["Letters", 115, "S", "S", "KeyS"],
        ["Letters", 116, "T", "T", "KeyT"],
        ["Letters", 117, "U", "U", "KeyU"],
        ["Letters", 118, "V", "V", "KeyV"],
        ["Letters", 119, "W", "W", "KeyW"],
        ["Letters", 120, "X", "X", "KeyX"],
        ["Letters", 121, "Y", "Y", "KeyY"],
        ["Letters", 122, "Z", "Z", "KeyZ"],
        ["Numbers", 48, "0", "0", "Digit0"],
        ["Numbers", 49, "1", "1", "Digit1"],
        ["Numbers", 50, "2", "2", "Digit2"],
        ["Numbers", 51, "3", "3", "Digit3"],
        ["Numbers", 52, "4", "4", "Digit4"],
        ["Numbers", 53, "5", "5", "Digit5"],
        ["Numbers", 54, "6", "6", "Digit6"],
        ["Numbers", 55, "7", "7", "Digit7"],
        ["Numbers", 56, "8", "8", "Digit8"],
        ["Numbers", 57, "9", "9", "Digit9"],
        ["Numbers", 45, "-", "-", "Minus"],
        ["Numbers", 61, "=", "=", "Equal"],
        ["Numbers", 91, "[", "[", "BracketLeft"],
        ["Numbers", 93, "]", "]", "BracketRight"],
        ["Numbers", 92, "\\ (backslash)", "BSLS", "Backslash"],
        ["Numbers", 59, ";", ";", "Semicolon"],
        ["Numbers", 39, "' (quote)", "'", "Quote"],
        ["Numbers", 96, "` (grave)", "`", "Backquote"],
        ["Numbers", 44, ",", ",", "Comma"],
        ["Numbers", 46, ".", ".", "Period"],
        ["Numbers", 47, "/", "/", "Slash"],
        ["Function", 0xC2, "F1", "F1", "F1"],
        ["Function", 0xC3, "F2", "F2", "F2"],
        ["Function", 0xC4, "F3", "F3", "F3"],
        ["Function", 0xC5, "F4", "F4", "F4"],
        ["Function", 0xC6, "F5", "F5", "F5"],
        ["Function", 0xC7, "F6", "F6", "F6"],
        ["Function", 0xC8, "F7", "F7", "F7"],
        ["Function", 0xC9, "F8", "F8", "F8"],
        ["Function", 0xCA, "F9", "F9", "F9"],
        ["Function", 0xCB, "F10", "F10", "F10"],
        ["Function", 0xCC, "F11", "F11", "F11"],
        ["Function", 0xCD, "F12", "F12", "F12"],
        ["Function", 0xF0, "F13", "F13", "F13"],
        ["Function", 0xF1, "F14", "F14", "F14"],
        ["Function", 0xF2, "F15", "F15", "F15"],
        ["Function", 0xF3, "F16", "F16", "F16"],
        ["Function", 0xF4, "F17", "F17", "F17"],
        ["Function", 0xF5, "F18", "F18", "F18"],
        ["Function", 0xF6, "F19", "F19", "F19"],
        ["Function", 0xF7, "F20", "F20", "F20"],
        ["Function", 0xF8, "F21", "F21", "F21"],
        ["Function", 0xF9, "F22", "F22", "F22"],
        ["Function", 0xFA, "F23", "F23", "F23"],
        ["Function", 0xFB, "F24", "F24", "F24"],
        ["Navigation", 0xDA, "Up", "UP", "ArrowUp"],
        ["Navigation", 0xD9, "Down", "DOWN", "ArrowDown"],
        ["Navigation", 0xD8, "Left", "LEFT", "ArrowLeft"],
        ["Navigation", 0xD7, "Right", "RGHT", "ArrowRight"],
        ["Navigation", 0xD2, "Home", "HOME", "Home"],
        ["Navigation", 0xD5, "End", "END", "End"],
        ["Navigation", 0xD3, "Page Up", "PGUP", "PageUp"],
        ["Navigation", 0xD6, "Page Down", "PGDN", "PageDown"],
        ["Navigation", 0xD1, "Insert", "INS", "Insert"],
        ["Navigation", 0xD4, "Delete", "DEL", "Delete"],
        ["Modifiers", 0x80, "Left Ctrl", "CTRL", "ControlLeft"],
        ["Modifiers", 0x81, "Left Shift", "SHFT", "ShiftLeft"],
        ["Modifiers", 0x82, "Left Alt", "ALT", "AltLeft"],
        ["Modifiers", 0x83, "Left Win/Cmd", "GUI", "MetaLeft"],
        ["Modifiers", 0x84, "Right Ctrl", "RCTL", "ControlRight"],
        ["Modifiers", 0x85, "Right Shift", "RSFT", "ShiftRight"],
        ["Modifiers", 0x86, "Right Alt", "RALT", "AltRight"],
        ["Modifiers", 0x87, "Right Win/Cmd", "RGUI", "MetaRight"],
        ["Numpad", 0xDB, "Num Lock", "NUML", "NumLock"],
        ["Numpad", 0xDC, "Numpad /", "N/", "NumpadDivide"],
        ["Numpad", 0xDD, "Numpad *", "N*", "NumpadMultiply"],
        ["Numpad", 0xDE, "Numpad -", "N-", "NumpadSubtract"],
        ["Numpad", 0xDF, "Numpad +", "N+", "NumpadAdd"],
        ["Numpad", 0xE0, "Numpad Enter", "NENT", "NumpadEnter"],
        ["Numpad", 0xEB, "Numpad .", "N.", "NumpadDecimal"],
        ["Numpad", 0xE1, "Numpad 1", "N1", "Numpad1"],
        ["Numpad", 0xE2, "Numpad 2", "N2", "Numpad2"],
        ["Numpad", 0xE3, "Numpad 3", "N3", "Numpad3"],
        ["Numpad", 0xE4, "Numpad 4", "N4", "Numpad4"],
        ["Numpad", 0xE5, "Numpad 5", "N5", "Numpad5"],
        ["Numpad", 0xE6, "Numpad 6", "N6", "Numpad6"],
        ["Numpad", 0xE7, "Numpad 7", "N7", "Numpad7"],
        ["Numpad", 0xE8, "Numpad 8", "N8", "Numpad8"],
        ["Numpad", 0xE9, "Numpad 9", "N9", "Numpad9"],
        ["Numpad", 0xEA, "Numpad 0", "N0", "Numpad0"],
    ];

    // Default layout. Must equal setDefaultKeymaps() in firmware/src/config.cpp
    // (tests/test_configurator.py parses the C++ source and compares every key).
    // Layer 0 is the physical legend printed on the pad:
    //   Esc     7       8   9
    //   Macro1  4       5   6
    //   Macro2  1       2   3
    //   Macro3  Macro4  0   Enter
    // Macro1-4 send F13-F16 so they can be bound in any app without colliding.
    const DEFAULT_KEYMAPS_ROWS = [
        // Layer 0: Numpad
        [[0xB1, "ESC"], [55, "7"], [56, "8"], [57, "9"],
         [0xF0, "M1"], [52, "4"], [53, "5"], [54, "6"],
         [0xF1, "M2"], [49, "1"], [50, "2"], [51, "3"],
         [0xF2, "M3"], [0xF3, "M4"], [48, "0"], [0xB0, "ENT"]],
        // Layer 1: Navigation
        [[0xB1, "ESC"], [0xD2, "HOME"], [0xDA, "UP"], [0xD3, "PGUP"],
         [0xB3, "TAB"], [0xD8, "LEFT"], [0xD9, "DOWN"], [0xD7, "RGHT"],
         [0xD1, "INS"], [0xD5, "END"], [0xD9, "DOWN"], [0xD6, "PGDN"],
         [0xB2, "BSPC"], [0xD4, "DEL"], [32, "SPCE"], [0xB0, "ENT"]],
        // Layer 2: WASD Gaming
        [[0xB1, "ESC"], [49, "1"], [50, "2"], [51, "3"],
         [0xB3, "TAB"], [113, "Q"], [119, "W"], [101, "E"],
         [0x81, "SHFT"], [97, "A"], [115, "S"], [100, "D"],
         [0x80, "CTRL"], [114, "R"], [32, "SPCE"], [102, "F"]],
    ];

    const LAYER_NAMES = Object.freeze(["Numpad", "Navigation", "WASD Gaming"]);

    const CATALOG = Object.freeze(CATALOG_ROWS.map(([cat, code, name, label, ev]) =>
        Object.freeze({ cat, code, name, label, ev })));
    const BY_CODE = new Map(CATALOG.map(k => [k.code, k]));
    const BY_EVENT = new Map(CATALOG.filter(k => k.ev).map(k => [k.ev, k]));
    const CATEGORIES = Object.freeze(["All", ...new Set(CATALOG.map(k => k.cat))]);

    // KeyboardLayout_en_US entries that are 0 (unmapped): arduino-pico's press() sends nothing for
    // these ASCII codes, so the firmware rejects them (invalid_code).
    function asciiMapped(code) {
        if (code === 8 || code === 9 || code === 10) return true;   // BS, TAB, LF
        return code >= 32 && code <= 126;
    }

    // Mirrors keycodeIsAssignable() (firmware/include/keycodes.h): 0 = None; 1..127 through the
    // en_US table; 128..135 modifiers; 136 would be HID usage 0 (nothing); 137..255 usages.
    function isAssignable(code) {
        if (!Number.isInteger(code) || code < 0 || code > 255) return false;
        if (code === 0) return true;
        if (code < 128) return asciiMapped(code);
        return code !== 136;
    }

    function keyName(code) {
        const k = BY_CODE.get(code);
        if (k) return k.name;
        if (code >= 33 && code <= 126) return `"${String.fromCharCode(code)}" (code ${code})`;
        return `Code ${code}`;
    }

    // Suggested OLED label for a code: the catalog label, else something that fits the rule.
    function defaultLabel(code) {
        const k = BY_CODE.get(code);
        if (k) return k.label;
        const lbl = DP.contract ? DP.contract.normalizeLabel(String(code)) : null;
        return lbl || "KEY";
    }

    function defaultKeymaps() {
        return DEFAULT_KEYMAPS_ROWS.map(layer => layer.map(([code, label]) => ({ code, label })));
    }

    function searchCatalog(query, category) {
        const q = String(query || "").trim().toLowerCase();
        return CATALOG.filter(k => (!category || category === "All" || k.cat === category) &&
            (!q || k.name.toLowerCase().includes(q) || k.label.toLowerCase().includes(q) ||
             String(k.code) === q));
    }

    DP.keycodes = Object.freeze({
        CATALOG,
        CATEGORIES,
        LAYER_NAMES,
        byCode: code => BY_CODE.get(code) || null,
        byEventCode: ev => BY_EVENT.get(ev) || null,
        isAssignable,
        keyName,
        defaultLabel,
        defaultKeymaps,
        searchCatalog,
    });
})(typeof window !== "undefined" ? window : globalThis);
