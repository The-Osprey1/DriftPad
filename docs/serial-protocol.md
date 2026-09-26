# Serial command reference

DriftPad exposes a line-based text protocol over its USB serial port at **115200 baud**. The [web configurator](../configurator/index.html) uses it, and you can use it from any serial terminal or script.

- Send one command per line, terminated by `\n` or `\r`. Lines longer than 128 characters are truncated.
- Replies are single-line JSON. Most commands answer with `{"status":"ok", ...}` or `{"status":"error","msg":"..."}`.
- Any command except `SLEEP`, `SCREENSAVER` and `ANIM` wakes the OLED.
- Commands that change settings save them to flash immediately.

The handler lives in `processCommand()` in [`firmware/src/main.cpp`](../firmware/src/main.cpp).

## Queries

| Command | Reply |
|---|---|
| `PING` | `{"type":"pong"}` |
| `GET_CONFIG` | `{"type":"config", ...}` with actuation, RT sensitivity, RT enabled, active layer and all three keymaps |
| `STATUS` | `{"type":"status", ...}` with the active layer, last active key and per-key `pressed`, `travel` and `label` |
| `STREAM <0\|1>` | Turns `STATUS` telemetry at ~30 Hz on or off |

## Settings

| Command | Range | Effect |
|---|---|---|
| `SET_ACTUATION <mm>` | 0.10 to 3.80 | Actuation point for all keys |
| `SET_RT_SENS <mm>` | 0.05 to 2.00 | Rapid Trigger sensitivity |
| `SET_RT_ENABLE <0\|1>` | | Turns Rapid Trigger off or on |
| `SET_LAYER <n>` | 0 to 2 | Switches the active keymap layer |
| `SET_KEY <layer> <key> <hid> [label]` | layer 0 to 2, key 0 to 15 | Remaps one key. `hid` is an Arduino `Keyboard` key code; `label` is up to 4 characters for the OLED |
| `SET_HID <0\|1>` (alias `HID`) | | Enables or disables USB keyboard output. Useful while testing so key presses don't type into your computer |
| `SAVE` | | Writes the current settings to flash |
| `RESET` | | Restores factory defaults and saves them |
| `CALIBRATE` | | Re-measures every key's rest baseline (keys must be untouched) and saves it |

## Display

| Command | Effect |
|---|---|
| `FULLSCREEN [0\|1]` | Sets full-screen mode, or toggles it with no argument |
| `SCREENSAVER` | Starts the screensaver now |
| `ANIM [n]` | Forces screensaver animation `n` (0 to 2) and starts it. With no argument the firmware picks the animation itself |
| `SLEEP` / `WAKE` | Turns the OLED off or on |
| `OLED_SCAN` | Scans the I2C bus and reports what it finds |
| `OLED_TEST` | Draws a test pattern |

## Testing and maintenance

| Command | Effect |
|---|---|
| `SIM <key> <mm>` | Injects a simulated travel for one key, bypassing the sensor. Replies with a `sim_event` showing the resulting travel and pressed state |
| `BOOTSEL` | Reboots into the RP2040 USB bootloader for flashing |

[`tools/demo_oled.py`](../tools/demo_oled.py) is a working example that drives the display using `SIM`.
