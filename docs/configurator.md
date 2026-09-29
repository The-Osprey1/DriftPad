# Configurator

`configurator/index.html` is one page that talks to the pad over WebSerial (Chrome, Edge or Opera). It
needs no install and loads nothing from the network; open the file directly, or run
`python tools/serve_configurator.py` and use `http://127.0.0.1:8791` when a browser or tool will not
open files. `keymap.html` only redirects to `index.html#keys`.

## Pages

| Tab | What it does |
|---|---|
| Keys | The pad as it sits on the desk. Pick a layer and a key, choose what it sends (or press it on your keyboard), give it a 4-character label; arrows, Home and End move between keys. **Write** sends only the keys that changed. Keymaps can be exported and imported as JSON |
| Sensitivity | Actuation and Rapid Trigger sensitivity (limits come from the pad's `INFO`), Rapid Trigger on/off, live key travel |
| Device | Firmware version and build, keyboard output state, **Standalone mode** (keyboard output on at power-up; needs valid calibration), calibration wizard, Save, Revert, factory reset, backup and restore. Below: Simulate a key, Raw sensor samples, Scan timing, screensaver and display commands, restart into the bootloader, serial log |

## What it promises

- A value is shown as **on the pad** only when a correlated reply or a fresh `GET_CONFIG` says so;
  everything else is "not written" or "unsaved" and stays that way in the page.
- After a timeout or a garbled reply the page reads the pad back and reclassifies what actually
  arrived, so a lost reply is neither retried blindly nor reported as failure.
- Unplugging is announced ("Connection lost"); reconnecting re-reads the pad and keeps pending edits.
- Firmware it does not understand (protocol other than 2) is refused before anything is written.
- A backup holds keymaps and sensitivity settings; restore validates the file and reports written,
  failed and mismatched keys. Calibration belongs to one pad's sensors and is never restored.
- Open `index.html?simulate=1` to use an in-browser pad with no hardware. It is marked "SIMULATED
  DEVICE", keeps its state in memory and never touches your saved keymap draft.

## Under the hood

Classic scripts on `window.DriftPad` (`contract`, `protocol`, `transport`, `device`, `draft`,
`backup`, `keycodes`, `app`); `fake_device.js` is the in-browser pad speaking the protocol
([serial-protocol.md](serial-protocol.md)), which the tests compare with the compiled firmware line
by line. Tests are in `configurator/tests/` (`run.html` opens them in any browser) and run headless
from `tests/test_configurator_js.py`; see [testing.md](testing.md). The page announces connection
state, write results and key selection through live regions; a real screen-reader pass is item HW-32
of [hardware-acceptance.md](hardware-acceptance.md).
