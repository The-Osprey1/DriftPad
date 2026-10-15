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

On **Keys**, the selected key shows live estimated travel, pressed/released state, and whether it
is sending to the computer. Movement remains visible with keyboard output disabled, so sensors
can be checked before calibration. Browser simulation and injected simulated keys are explicitly
labelled; they do not verify physical sensing. Reconnecting or returning to the page waits for a
new reading. For the first physical checks, see [bring-up.md](bring-up.md).

- A value is shown as **on the pad** only when a correlated reply or a fresh `GET_CONFIG` says so;
  everything else is "not written" or "unsaved" and stays that way in the page.
- After a timeout or a garbled reply the page reads the pad back and reclassifies what actually
  arrived, so a lost reply is neither retried blindly nor reported as failure.
- Unplugging is announced ("Connection lost"); reconnecting re-reads the pad and keeps pending edits.
- Firmware it does not understand (protocol other than 2) is refused before anything is written.
- A backup holds keymaps and sensitivity settings; restore validates the file and reports written,
  failed and mismatched keys. Calibration belongs to one pad's sensors and is never restored.
- Guided calibration needs a 600-count full-press range on every key; it refuses weaker readings
  because those cannot reach the whole travel scale. The thresholds and output lifecycle are in
  [calibration.md](calibration.md).
- Open `index.html?simulate=1` to use an in-browser pad with no hardware. It is marked "SIMULATED
  DEVICE", keeps its state in memory and never touches your saved keymap draft.

The Device page updates its saved-state message whenever the pad reports a change: a new applied
edit immediately replaces the previous Saved confirmation with Unsaved. Local edits waiting to be
written or applied remain explicitly excluded from a save. A failed save stays visible until a
successful retry, and reconnecting reads the current state again.

Blocked keyboard output names the next action: Start calibration for missing/invalid calibration,
complete the marked keys and Finish during calibration, or Turn keyboard output on when disabled.
An incomplete calibration names the keys to press fully and release; the same instruction appears
in each marked key's accessible label.

## Display controls

In **Device → Advanced diagnostics → Display**, choose **Shuffle all** or a single animation:
Starfield, Plasma, Tesseract, Drift grid, Magnetic pulse, or Lava lamp. Choosing an option changes
only the browser selection; **Play screensaver** sends the request. **Stop screensaver** returns
to the selected screen. **Display off** turns the OLED off. None of these commands changes keymaps,
calibration, keyboard output, or saved sensitivity settings.

Idle leaves the selected screen in place. Screensaver playback starts only when explicitly
requested; Shuffle all changes animations during that requested playback. A fixed selection keeps
its animation. Turn or press the rotary to wake the display: the first input only wakes it, so it
does not also adjust a setting or advance a page.

Controls stay disabled while a display request is pending. New firmware reports the display core's
applied mode through `INFO` and `STATUS`; the page reads it back after a command before confirming
the change. An accepted request whose display state has not arrived stays explicitly unconfirmed.
**Refresh display status** reads the mode again without waking the display or restarting playback,
including after a physical key or rotary has woken it. Reports describe firmware state; they do not
prove what is physically visible on the OLED. Older protocol-2 firmware still accepts the controls,
but the page labels its reply as a request acknowledgment and cannot confirm playback or its order.
Disconnecting clears the previous report and operation feedback; reconnecting reads the device again.

## Under the hood

Classic scripts on `window.DriftPad` (`contract`, `protocol`, `transport`, `device`, `draft`,
`backup`, `keycodes`, `app`); `fake_device.js` is the in-browser pad speaking the protocol
([serial-protocol.md](serial-protocol.md)), which the tests compare with the compiled firmware line
by line. Tests are in `configurator/tests/` (`run.html` opens them in any browser) and run headless
from `tests/test_configurator_js.py`; see [testing.md](testing.md). The page announces connection
state, write results and key selection through live regions; a real screen-reader pass is item HW-32
of [hardware-acceptance.md](hardware-acceptance.md).
