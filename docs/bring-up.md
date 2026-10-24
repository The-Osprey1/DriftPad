# First checks on the assembled pad

Work through these in order. Keep keyboard output off while checking sensors. The browser's
`?simulate=1` mode tests the interface only; use the ordinary configurator for the physical pad.

## OLED repair on the Driftpad-fix2 board

The board inspected during September 2026 troubleshooting had R8 in series with SDA and R7 in
series with SCL, each populated with 4.7 kOhm. Direct signal bypasses restored the OLED. R8 is on
the front and R7 on the back at the same board position; both use 0603 footprints. This finding
applies to that board revision, whose source files are outside this repository.

With USB and any other power disconnected, replace each series resistor with a 0 Ohm 0603
resistor. Remove the temporary signal bypass wires once the replacement connections are sound.
Check the following paths with a meter before powering up:

| OLED header | Destination | Expected path after repair |
|---|---|---|
| 1, GND | Pico GND | Near zero resistance |
| 2, VCC | Pico 3V3 OUT, physical pin 36 | Near zero resistance |
| 3, SCL | Pico GP1, physical pin 2 | Near zero resistance through R7 |
| 4, SDA | Pico GP0, physical pin 1 | Near zero resistance through R8 |

Check for accidental solder bridges between adjacent pads. The zero-ohm parts join each signal's
two trace segments; they are not pull-ups. Actual I2C pull-ups connect signals to 3.3 V and must
remain in place. A continuity buzzer alone cannot identify a resistor's value; measure resistance.

Power up and check that the OLED lights. The current startup animation lasts about six seconds
and a detected press can skip it. The green Pico heartbeat does not confirm OLED communication.
The expected OLED address is `0x3C`; a detected address confirms communication, while viewing
the actual screen confirms rendering. See [hardware.md](hardware.md) for firmware pin assignments.

## Check each sensor before calibration

Standby stays on the layer/key screen. There the knob does what the active layer's knob mode says,
only while keyboard output is on: at first it is a volume control (turning sends volume up or down,
a press sends mute). A pop-up on the screen says what each turn or press sent. Holding the knob for
one second opens the settings menu: a press then selects Rapid Trigger sensitivity, actuation, Rapid
Trigger on/off, layer, screen theme, knob mode, then the key screen again, turning adjusts the selected setting, and
holding again closes the menu. Selected settings screens stay visible;
they do not time out or cycle automatically.
After 2 minutes without a key press or knob input, the screensaver starts by itself (any key or
the knob brings the key screen back). Choose the time (or Never) and the animation on the
configurator's **Screen** tab. It does not start while the pad is uncalibrated, so the calibration
hint stays visible. Idle never turns the display off.

1. Connect the physical pad in the configurator and leave keyboard output off. Turn off any
   injected key simulation in Device before checking physical movement.
2. Open **Keys** and select the top-left key, Key 0. The editor identifies its row and column and
   shows live estimated travel, pressed/released state, and whether it sends to the computer.
3. Press that physical key slowly and release it. Check that its reading changes and returns near
   its original rest reading. Before calibration, the displayed millimetres are only a rough
   diagnostic estimate; do not require a precise 4.00 mm reading.
4. Repeat for all 16 keys, row by row. Check that the key you press corresponds to the selected
   position. Use the [key-to-sensor/channel table](hardware.md#key-to-multiplexer-channel-map)
   when a position is unresponsive or appears swapped.
5. For a stuck or noisy reading, use **Device → Raw sensor samples**, select that key and capture
   at rest, then capture while holding it fully down. Compare the means and the noise. Check its
   sensor supply, ground, output joint, magnet alignment and mux connection if there is little
   change, a rail reading or unstable values. Raw samples are ADC counts, not millimetres.

Movement and host keyboard output are separate checks. A sensor can respond while output is
blocked because calibration is missing. The rest-noise and range requirements are described in
[calibration.md](calibration.md); do not change firmware thresholds to hide a weak sensor.

## Calibrate, save and verify persistence

1. Open **Device → Calibration → Start**, with all keys released. Keep them still during the rest
   phase, then fully press and release every key during the travel phase.
2. Once all 16 keys are marked complete, choose **Finish**, then **Save**. If a key does not
   complete, investigate that position before retrying.
3. Disconnect USB, reconnect and connect the configurator again. Confirm calibration is valid
   for all 16 keys, there are no reported load errors, and the pad reports its settings saved.
4. Turn keyboard output on and test individual presses and releases in a blank text editor.
   Check numbers and Enter; verify Esc and macro/function keys with an appropriate key viewer,
   since those keys may produce no visible text. Check that no key remains held after release.
5. Test the encoder and layer changes. If turning or pressing the knob does nothing on the OLED,
   watch the knob line under the pad on the configurator's Keys page: A and B should switch
   between high and low while turning (4 steps per click), and the switch should read closed
   while pressed. No change there means the signal never reaches GP20, GP21 or GP2; check the
   knob's ground and signal wires. Enable and save standalone mode only if keyboard output
   should start automatically at future power-ups.

Record the results in the [hardware acceptance procedure](hardware-acceptance.md). Passing these
first checks does not establish timing, noise, depth accuracy or power-cut reliability.

## Check channel isolation before tuning Rapid Trigger

Once all sensors and their local supply capacitors are populated, capture each released key's
raw baseline and noise. Hold a different key fully down, repeat the capture, and release it.
Repeat across the board, especially for channels adjacent in the mux scan order. Released
channels should remain within their measured rest-noise band rather than following another
key's position. Repeat with the OLED active and with the panel asleep to check display coupling.

The inspected PCB has a shared 4.7 nF capacitor C2 on the mux output; the firmware currently
allows 2 microseconds between selecting a channel and reading it. Channel isolation must be
measured on the assembled board before changing that delay or adding filtering. An external
measurement or a controlled comparison build may be needed if a released channel follows
another key. Stronger smoothing alone does not establish correct ADC acquisition.
