# Sensor calibration

Guided calibration measures rest and full-press readings separately for every Hall sensor. The
firmware uses those values to detect keys held at power-up and to estimate travel. Millimetres are a
linear estimate over a nominal 4 mm stroke; they do not replace a measured switch-depth check.

## Guided calibration

Connect in Chrome, Edge or Opera, open **Device → Calibration**, take hands off the pad, and press
**Start**. The rest phase samples for at least 500 ms. Each key's peak-to-peak rest noise must be at
most 120 ADC counts, and its mean must be inside the non-railed rest window. Keep all keys still
until the interface enters the travel phase.

Press every key fully down once and let it return to rest. Each key must move by at least 600 ADC
counts, have a consistent polarity, and return within the per-key tolerance. Once all 16 are marked
done, choose **Finish** and **Save**. Connect again and check `INFO.calibration` and
`INFO.settings.load_errors` after reboot.

The minimum 600-count excursion is shared with the travel converter's lower range bound. Without
that minimum, a 300–599-count key could be called calibrated while the DSP still scales it over a
600-count span: full press would then report less than 4 mm, making high actuation settings
unreachable. Such calibration is refused, so keyboard output stays gated until calibration is valid.
If a previously saved calibration has a smaller range after this firmware update, `INFO` reports
`calibration: invalid`; run and save guided calibration again.

## Rest noise and tolerance

The guided calibration allows at most 120 counts peak-to-peak noise in its 500 ms rest sample.
That is a go/no-go limit for the calibration procedure. Independently, the hardware acceptance
check HW-06 asks for at most 40 counts peak-to-peak in a one-second, hands-off raw capture. This
stricter hardware criterion checks normal sensor stability; passing guided calibration alone does
not pass HW-06.

For boot recovery, quick `CALIBRATE`, and travel return-to-rest checks, per-key tolerance is the
greater of 40 counts and 5% of that key's saved calibrated range. These checks reject out-of-range
rest points instead of moving a saved full-press endpoint outside the ADC range. At boot, an
implausible new rest reading keeps the saved rest point and is reported under `INFO.calibration.drift`.

## Output and persistence

Keyboard output starts off. A successful calibration does not silently turn it on. After checking
all 16 keys, use **Device → Turn keyboard output on** for the current session, or enable standalone
mode and save it to request output at later boots. Standalone mode still requires valid calibration;
keys physically held at boot remain suppressed until released.

`CALIBRATE` is the quick rest-only re-zero operation for a pad that already has a valid calibration.
It requires every key to be at rest, keeps each key's saved polarity and range, and changes the
running calibration only. On a pad without a valid calibration, it does not create one; use the
guided procedure. Neither form of calibration is saved until `SAVE`.

`CAL CANCEL` restores the previous calibration and output state. `REVERT` is refused while a
guided calibration is active. If it restores a changed calibration, the firmware reapplies that
calibration to the live sensing engine and suppresses any key already off-rest until it is released.
It does not turn on output that the user had turned off. `RESET ALL` clears calibration and gates
keyboard output.

## Verify the state

After calibration and save, `INFO` should report:

- `calibration.state`: `valid`;
- `calibration.keys_valid`: 16;
- no `calibration.faults` or `settings.load_errors`;
- `output.enabled: false` after an ordinary reboot, unless standalone output was deliberately
  enabled and saved.

See [the serial protocol](serial-protocol.md), [flash layout](flash-layout.md), and the
[hardware acceptance steps](hardware-acceptance.md). Physical depth, noise, boot, and USB behavior
still require a built pad.
