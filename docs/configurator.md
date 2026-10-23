# Configurator

`configurator/index.html` is one page that talks to the pad over WebSerial (Chrome, Edge or Opera). It
needs no install and loads nothing from the network; open the file directly, or run
`python tools/serve_configurator.py` and use `http://127.0.0.1:8791` when a browser or tool will not
open files. The same page is published at https://the-osprey1.github.io/DriftPad/, with a **Download firmware**
button in place of Back to Studio (`scripts/build-site.cjs`). `keymap.html` only redirects to `index.html#keys`.

## Pages

| Tab | What it does |
|---|---|
| Keys | The pad as it sits on the desk, with a live knob line under it (A, B and switch levels, steps and presses) for checking the encoder wiring. Pick a layer and a key, choose what it sends (or press it on your keyboard), tick Ctrl, Shift, Alt or Win to hold them with it (Ctrl + C), give it a 4-character label; arrows, Home and End move between keys. **Write** sends only the keys that changed. Keymaps can be exported and imported as JSON |
| Sensitivity | Actuation and Rapid Trigger sensitivity (limits come from the pad's `INFO`), Rapid Trigger on/off, live key travel |
| Device | Firmware version and build, keyboard output state, **Standalone mode** (keyboard output on at power-up; needs valid calibration), calibration wizard, Save, Revert, factory reset, backup and restore. Below: Simulate a key, Raw sensor samples, Scan timing, screensaver and display commands, restart into the bootloader, serial log |
| Screen | **Screensaver**: when it starts by itself (Never, 1, 2, 5, 10 or 30 minutes idle) and which animation it plays, with Play now and Save. **Screen Lab** (a preview; nothing is sent to the pad): load a GIF or picture, convert it to the 128 × 64 black-and-white screen and see it in three possible places. See below |

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

After the idle time chosen on the **Screen** tab (factory: 2 minutes, Shuffle all) the pad starts its
screensaver by itself; **Never** turns that off. Those two choices are stored settings, applied at once
and kept by **Save to the pad**, and included in backups. The selection here only chooses what
**Play screensaver** plays now. Shuffle all changes animations during playback. A fixed selection keeps
its animation. Turn or press the knob to wake the display. In the settings menu the first input only wakes it, so it
does not also adjust a setting or advance a page; outside the menu, volume and mute still apply.

Controls stay disabled while a display request is pending. New firmware reports the display core's
applied mode through `INFO` and `STATUS`; the page reads it back after a command before confirming
the change. An accepted request whose display state has not arrived stays explicitly unconfirmed.
**Refresh display status** reads the mode again without waking the display or restarting playback,
including after a physical key or rotary has woken it. Reports describe firmware state; they do not
prove what is physically visible on the OLED. Older protocol-2 firmware still accepts the controls,
but the page labels its reply as a request acknowledgment and cannot confirm playback or its order.
Disconnecting clears the previous report and operation feedback; reconnecting reads the device again.

## Screen Lab

The **Screen** tab tries your own GIF (or a PNG, JPEG or WebP picture) on the pad's screen before
the pad can store one. Drop a file on it or click to choose one. Nothing leaves the browser.

- **Shape:** Fit (the whole picture, with black bars), Fill (crop the edges) or Stretch. A picture
  smaller than the screen is enlarged with whole pixels, so pixel art stays crisp.
- **Shading:**
  - **Pattern** (the default) uses the same 4 × 4 ordered pattern as the pad's own animations. It
    stays steady from frame to frame and packs small.
  - **Smooth** (Floyd–Steinberg error diffusion) shows the finest detail in a still picture, but
    its speckle changes every frame, so a moving GIF shimmers and needs up to ten times the memory.
  - **Sharp** is black or white only, for logos and pixel art.
- **Brightness**, **Contrast**, **Invert**, **Speed** (0.5× to 2×) and **Frames** (keep only part
  of the GIF).
- **Size:** what the clip would take of the pad's planned 1 MB for animations. It is computed with
  the packing the pad will use (`configurator/js/anim_codec.js`): frame 0 is stored whole and every
  later frame as its difference from the frame before, then run-length packed. Clips take whole
  4 KB flash sectors.
- **On the pad:** the GIF plays in three mockups, drawn pixel for pixel with the pad's 5 × 7 font:
  as a **screensaver**, as an idle **home screen** under the layer strip, and as a small **layer
  picture** in place of the key map.

Decoding uses the browser's own `ImageDecoder`, and conversion runs in a Web Worker
(`js/gif_worker.js`), so a long GIF never stalls the page or the serial link. A progress bar shows
the frame being converted, with **Cancel**. When no worker can start, the same code runs on the page,
yielding between frames. At most 1,000 frames are read.

## Under the hood

Classic scripts on `window.DriftPad` (`contract`, `protocol`, `transport`, `device`, `draft`,
`backup`, `keycodes`, `app`); `fake_device.js` is the in-browser pad speaking the protocol
([serial-protocol.md](serial-protocol.md)), which the tests compare with the compiled firmware line
by line. Tests are in `configurator/tests/` (`run.html` opens them in any browser) and run headless
from `tests/test_configurator_js.py`; see [testing.md](testing.md). The page announces connection
state, write results and key selection through live regions; a real screen-reader pass is item HW-32
of [hardware-acceptance.md](hardware-acceptance.md).
