#include <Arduino.h>

#include "pins.h"
#include "mux.h"
#include "hall.h"
#include "encoder.h"
#include "oled.h"
#include "display_publish.h"
#include "config.h"
#include "keyboard_output.h"
#include "commands.h"
#include "calibration.h"
#include "protocol.h"
#include "timing.h"

namespace {

// Key scan at a fixed 1 kHz. The DSP's sample-counted constants (EMI correlation lags, chatter
// window, stationary timer) are tuned for this rate.
constexpr uint32_t SCAN_PERIOD_US = 1000;
uint32_t s_nextScanUs = 0;

uint32_t hostMicros() { return micros(); }

Timing          s_timing(SCAN_PERIOD_US, hostMicros);
proto::TxQueue  s_tx;
proto::LineReader s_lineReader;
proto::Dispatcher s_dispatcher(commands::table(), commands::tableSize(), s_tx);
proto::CommandScheduler s_scheduler(s_lineReader, s_dispatcher, s_tx, &s_timing);

// Serial through the protocol queues: reads never wait, writes never exceed what the CDC FIFO can
// take (SerialUSB::write() waits up to 1 s for a host that is not reading)
class SerialRx : public proto::RxSource {
public:
    int read() override { return Serial.available() > 0 ? Serial.read() : -1; }
};

class SerialSink : public proto::TxSink {
public:
    int availableForWrite() override { return Serial ? Serial.availableForWrite() : 0; }
    size_t write(const uint8_t* data, size_t len) override { return Serial.write(data, len); }
};

SerialRx   s_rx;
SerialSink s_sink;
bool       s_hostConnected = false;

// Encoder edits are saved once the knob has been still this long, so a spin costs one flash write.
// A save pauses scanning and USB for the flash erase and program (see docs/scheduling.md), so it
// also waits until no key has changed state for KEYS_QUIET_MS: never in the middle of typing. A
// key held down without changing does not delay it.
constexpr uint32_t ENCODER_SAVE_DELAY_MS = 3000;
constexpr uint32_t KEYS_QUIET_MS = 1000;
bool s_encoderSavePending = false;
uint32_t s_lastEncoderEdit = 0;
uint16_t s_lastPressedMask = 0;
uint32_t s_lastKeyChange = 0;

void serviceHostConnection() {
    bool connected = (bool)Serial;
    if (s_hostConnected && !connected) {
        // The host closed the port: nothing queued is for the next session
        commands::onHostDisconnected();
        s_tx.clear();
        s_lineReader.reset();
    }
    s_hostConnected = connected;
}

// BOOTSEL must get its reply out before the USB device disappears
void flushTxBeforeReboot() {
    uint32_t start = millis();
    while (!s_tx.empty() && (millis() - start) < 200) {
        s_tx.drain(s_sink);
        yield();
    }
    Serial.flush();
}

} // namespace

void setup() {
    Serial.begin(115200);

    pinMode(LED_BUILTIN, OUTPUT);
    digitalWrite(LED_BUILTIN, HIGH);

    // Keyboard output starts disabled (prototype safety) and empty
    KeyboardOutput::init();

    muxInit();
    encoderInit();
    HallManager::init();
    configInit();   // stored settings, applied to the sensing engine
    oledInit();

    commands::init(s_tx, s_timing);
    s_encoderSavePending = false;
    s_lastPressedMask = 0;
    s_lastKeyChange = millis();
    s_hostConnected = false;
    s_tx.clear();
    s_tx.resetStats();
    s_lineReader.reset();
    s_timing.reset();

    // Let the sensors settle, then restore calibration against a fresh rest measurement: keys
    // held at power-up keep their stored rest and are suppressed, small drift is re-zeroed.
    // Without valid calibration every key is zeroed where it is (legacy) and output stays off.
    delay(150);
    uint16_t rest[NUM_KEYS];
    HallManager::measureRest(rest, calib::BOOT_SAMPLES);
    commands::onBoot(Calibration::applyAtBoot(configGet().calibration, rest));

    displayPublish();   // core 1 keeps the splash until the first snapshot
    commands::queueBootEvent();
    s_nextScanUs = micros();
}

void loop() {
    static uint32_t lastHeartbeat = 0;
    static bool ledState = false;

    uint32_t nowUs = micros();
    if ((int32_t)(nowUs - s_nextScanUs) >= 0) {
        s_nextScanUs += SCAN_PERIOD_US;
        if ((int32_t)(nowUs - s_nextScanUs) >= 0) {
            // Fell a full period behind: resync instead of bursting scans to catch up
            s_nextScanUs = nowUs + SCAN_PERIOD_US;
        }
        s_timing.scanBegin(nowUs);
        HallManager::updateAll();
        commands::onScan();
        s_timing.scanEnd(micros());
        {
            Timing::Scoped t(s_timing, Timing::Op::Publish);
            displayPublish();
        }
    }

    uint32_t nowMs = millis();
    const uint16_t pressed = HallManager::pressedMask();
    if (pressed != s_lastPressedMask) {
        s_lastPressedMask = pressed;
        s_lastKeyChange = nowMs;
    }

    KeyboardOutput::service();
    HallManager::simService(nowMs);
    serviceHostConnection();

    // At most one command per iteration, and only while its largest reply fits the TX queue
    s_scheduler.step(s_rx, nowMs);
    if (commands::takeBootselRequest()) {
        flushTxBeforeReboot();
        rp2040.rebootToBootloader();
    }
    commands::service(nowMs);
    {
        Timing::Scoped t(s_timing, Timing::Op::TxDrain);
        s_tx.drain(s_sink);
    }

    // Rotary encoder: the menu applies changes through the config mutators
    encoderUpdate();
    int32_t delta = encoderGetDelta();
    if (delta != 0 && oledAdjustCurrentSetting(delta)) {
        s_encoderSavePending = true;
        s_lastEncoderEdit = nowMs;
    }
    if (encoderWasClicked()) {
        oledCycleMenu();
    }
    if (s_encoderSavePending && (nowMs - s_lastEncoderEdit) >= ENCODER_SAVE_DELAY_MS &&
        (nowMs - s_lastKeyChange) >= KEYS_QUIET_MS) {
        s_encoderSavePending = false;
        SaveResult sr;
        sr.ok = true;
        if (!commands::hostEditsUnsaved()) {   // otherwise the user's own edits would be committed too
            Timing::Scoped t(s_timing, Timing::Op::Save);
            sr = configSave();
        }
        if (!sr.ok) {
            // The change is still only in RAM (INFO says dirty): try again after another rest
            s_encoderSavePending = true;
            s_lastEncoderEdit = nowMs;
        }
    }

    // Heartbeat every 2 seconds
    if (nowMs - lastHeartbeat >= 2000) {
        lastHeartbeat = nowMs;
        ledState = !ledState;
        digitalWrite(LED_BUILTIN, ledState ? HIGH : LOW);
    }
}
