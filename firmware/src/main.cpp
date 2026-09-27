#include <Arduino.h>
#include <Keyboard.h>
#include <Wire.h>
#include <cstring>

#include "pins.h"
#include "mux.h"
#include "hall.h"
#include "encoder.h"
#include "oled.h"
#include "config.h"

namespace {

bool s_streamTelemetry = false;
uint32_t s_lastStreamTime = 0;
String s_serialBuffer = "";

// Encoder edits are saved once the knob has been still this long, so a spin costs one flash write
constexpr uint32_t ENCODER_SAVE_DELAY_MS = 3000;
bool s_encoderSavePending = false;
uint32_t s_lastEncoderEdit = 0;

// Key scan timing, reported by SCAN_RATE
constexpr uint32_t SCAN_PERIOD_US = 1000;
uint32_t s_nextScanUs = 0;
uint32_t s_scanCount = 0;
uint32_t s_scanWindowStart = 0;
uint32_t s_scanRateHz = 0;
uint32_t s_lastScanUs = 0;
uint32_t s_maxScanGapUs = 0;

// RAW <key>: captures one second of a key's raw ADC samples at the scan rate for noise analysis
constexpr uint16_t RAW_CAPTURE_LEN = 1000;
uint16_t s_rawCapture[RAW_CAPTURE_LEN];
uint16_t s_rawCaptureCount = 0;
int8_t s_rawCaptureKey = -1;

void finishRawCapture() {
    Serial.printf("{\"type\":\"raw\",\"key\":%d,\"rate_hz\":1000,\"samples\":[", s_rawCaptureKey);
    for (uint16_t i = 0; i < s_rawCaptureCount; ++i) {
        Serial.print(s_rawCapture[i]);
        if (i + 1 < s_rawCaptureCount) Serial.print(',');
    }
    Serial.println(F("]}"));
    s_rawCaptureKey = -1;
}

void printJsonEscaped(const char* text) {
    if (text == nullptr) return;
    for (const char* p = text; *p != '\0'; ++p) {
        char c = *p;
        if (c == '"' || c == '\\') {
            Serial.print('\\');
            Serial.print(c);
        } else if ((uint8_t)c >= 0x20) {
            Serial.print(c);
        }
    }
}

void copyLabelSafe(char* dst, size_t dstSize, const char* src) {
    if (dst == nullptr || dstSize == 0) return;
    if (src == nullptr) {
        dst[0] = '\0';
        return;
    }

    size_t i = 0;
    for (; i + 1 < dstSize && src[i] != '\0'; ++i) {
        char c = src[i];
        if ((c >= '0' && c <= '9') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= 'a' && c <= 'z') ||
            c == '_' || c == '-') {
            dst[i] = c;
        } else {
            dst[i] = '_';
        }
    }
    dst[i] = '\0';
}

void sendConfigJson() {
    DeviceSettings& cfg = configGet();
    Serial.print(F("{\"type\":\"config\",\"actuation\":"));
    Serial.print(cfg.actuationMm, 2);
    Serial.print(F(",\"rt_sens\":"));
    Serial.print(cfg.rtSensMm, 2);
    Serial.print(F(",\"rt_enabled\":"));
    Serial.print(cfg.rtEnabled ? F("true") : F("false"));
    Serial.print(F(",\"active_layer\":"));
    Serial.print(cfg.activeLayer);
    Serial.print(F(",\"layers\":["));

    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        if (l > 0) Serial.print(F(","));
        Serial.print(F("["));
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            if (k > 0) Serial.print(F(","));
            Serial.print(F("{\"idx\":"));
            Serial.print(k);
            Serial.print(F(",\"code\":"));
            Serial.print(cfg.keymaps[l][k].hidCode);
            Serial.print(F(",\"label\":\""));
            printJsonEscaped(cfg.keymaps[l][k].label);
            Serial.print(F("\"}"));
        }
        Serial.print(F("]"));
    }
    Serial.println(F("]}"));
}

void sendStatusJson() {
    Serial.print(F("{\"type\":\"status\",\"active_layer\":"));
    Serial.print(configGet().activeLayer);
    Serial.print(F(",\"last_key\":"));
    Serial.print(HallManager::getLastActiveKey());
    Serial.print(F(",\"keys\":["));

    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (i > 0) Serial.print(F(","));
        HallKey& k = HallManager::getKey(i);
        Serial.print(F("{\"idx\":"));
        Serial.print(i);
        Serial.print(F(",\"pressed\":"));
        Serial.print(k.isPressed() ? F("true") : F("false"));
        Serial.print(F(",\"travel\":"));
        Serial.print(k.getTravelMm(), 2);
        Serial.print(F(",\"label\":\""));
        printJsonEscaped(k.getLabel());
        Serial.print(F("\"}"));
    }
    Serial.println(F("]}"));
}

void processCommand(String line) {
    line.trim();
    if (line.length() == 0) return;

    if (!line.equalsIgnoreCase("SLEEP") && !line.startsWith("SCREENSAVER") && !line.startsWith("ANIM")) {
        oledWake();
    }

    if (line.equalsIgnoreCase("PING")) {
        Serial.println(F("{\"type\":\"pong\"}"));
    }
    else if (line.equalsIgnoreCase("GET_CONFIG")) {
        sendConfigJson();
    }
    else if (line.equalsIgnoreCase("STATUS")) {
        sendStatusJson();
    }
    else if (line.startsWith("SET_ACTUATION ")) {
        float val = line.substring(14).toFloat();
        if (val >= 0.1f && val <= 3.8f) {
            HallKey::setActuationPoint(val);
            configGet().actuationMm = val;
            configSave();
            Serial.printf("{\"status\":\"ok\",\"msg\":\"Actuation set to %s mm\"}\n", String(val, 2).c_str());
            oledUpdate(true);
        } else {
            Serial.println(F("{\"status\":\"error\",\"msg\":\"Invalid actuation (0.1 - 3.8mm)\"}"));
        }
    }
    else if (line.startsWith("SET_RT_SENS ")) {
        float val = line.substring(12).toFloat();
        if (val >= HallKey::RT_SENS_MIN_MM && val <= HallKey::RT_SENS_MAX_MM) {
            HallKey::setRtSensitivity(val);
            configGet().rtSensMm = val;
            configSave();
            Serial.printf("{\"status\":\"ok\",\"msg\":\"RT sensitivity set to %s mm\"}\n", String(val, 2).c_str());
            oledUpdate(true);
        } else {
            Serial.println(F("{\"status\":\"error\",\"msg\":\"Invalid RT sensitivity (0.10 - 2.0mm)\"}"));
        }
    }
    else if (line.startsWith("SET_RT_ENABLE ")) {
        int val = line.substring(14).toInt();
        bool en = (val != 0);
        HallKey::setRapidTrigger(en);
        configGet().rtEnabled = en;
        configSave();
        Serial.printf("{\"status\":\"ok\",\"msg\":\"Rapid Trigger %s\"}\n", en ? "ENABLED" : "DISABLED");
        oledUpdate(true);
    }
    else if (line.startsWith("SET_LAYER ")) {
        int l = line.substring(10).toInt();
        if (l >= 0 && l < NUM_LAYERS) {
            configGet().activeLayer = (uint8_t)l;
            configApplyToHardware();
            configSave();
            Serial.printf("{\"status\":\"ok\",\"msg\":\"Active layer set to %d\"}\n", l);
            oledUpdate(true);
        } else {
            Serial.println(F("{\"status\":\"error\",\"msg\":\"Invalid layer index\"}"));
        }
    }
    else if (line.startsWith("SET_KEY ")) {
        // Format: SET_KEY <layer> <keyIdx> <hidCode> <label>
        char labelBuf[8] = {0};
        int layer = 0, keyIdx = 0, hidCode = 0;
        if (sscanf(line.c_str(), "SET_KEY %d %d %d %7s", &layer, &keyIdx, &hidCode, labelBuf) >= 3) {
            if (layer >= 0 && layer < NUM_LAYERS && keyIdx >= 0 && keyIdx < NUM_KEYS && hidCode >= 0 && hidCode <= 255) {
                configGet().keymaps[layer][keyIdx].hidCode = (uint8_t)hidCode;
                if (strlen(labelBuf) > 0) {
                    copyLabelSafe(
                        configGet().keymaps[layer][keyIdx].label,
                        sizeof(configGet().keymaps[layer][keyIdx].label),
                        labelBuf
                    );
                }
                configApplyToHardware();
                configSave();
                Serial.printf("{\"status\":\"ok\",\"msg\":\"Key L%d:K%d updated\"}\n", layer, keyIdx);
                oledUpdate(true);
            } else {
                Serial.println(F("{\"status\":\"error\",\"msg\":\"Invalid key update arguments\"}"));
            }
        }
    }
    else if (line.startsWith("SIM ")) {
        // Format: SIM <keyIdx> <travelMm>
        int spaceIdx = line.indexOf(' ', 4);
        if (spaceIdx > 4) {
            int keyIdx = line.substring(4, spaceIdx).toInt();
            float travelMm = line.substring(spaceIdx + 1).toFloat();
            if (keyIdx >= 0 && keyIdx < NUM_KEYS) {
                HallKey& k = HallManager::getKey((uint8_t)keyIdx);
                k.injectSimulatedTravel(travelMm);
                Serial.printf("{\"type\":\"sim_event\",\"key\":%d,\"travel\":%s,\"pressed\":%s}\n",
                    keyIdx, String(k.getTravelMm(), 2).c_str(), k.isPressed() ? "true" : "false");
                oledUpdate(true);
            }
        }
    }
    else if (line.equalsIgnoreCase("SCAN_RATE")) {
        Serial.printf("{\"type\":\"scan_rate\",\"hz\":%lu,\"max_gap_us\":%lu}\n",
            (unsigned long)s_scanRateHz, (unsigned long)s_maxScanGapUs);
        s_maxScanGapUs = 0;
    }
    else if (line.startsWith("RAW ")) {
        int keyIdx = line.substring(4).toInt();
        if (keyIdx >= 0 && keyIdx < NUM_KEYS) {
            s_rawCaptureCount = 0;
            s_rawCaptureKey = (int8_t)keyIdx;
        } else {
            Serial.println(F("{\"status\":\"error\",\"msg\":\"RAW key out of range\"}"));
        }
    }
    else if (line.startsWith("STREAM ")) {
        s_streamTelemetry = (line.substring(7).toInt() != 0);
        Serial.printf("{\"status\":\"ok\",\"streaming\":%s}\n", s_streamTelemetry ? "true" : "false");
    }
    else if (line.equalsIgnoreCase("SAVE")) {
        configSave();
        Serial.println(F("{\"status\":\"ok\",\"msg\":\"Settings saved to Flash\"}"));
    }
    else if (line.equalsIgnoreCase("RESET")) {
        configResetDefaults();
        configApplyToHardware();
        configSave();
        Serial.println(F("{\"status\":\"ok\",\"msg\":\"Factory reset complete\"}"));
        oledUpdate(true);
    }
    else if (line.equalsIgnoreCase("CALIBRATE")) {
        HallManager::calibrateAllRestBaselines(128);
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            configGet().baselines[i] = HallManager::getKey(i).getRestBaseline();
        }
        configSave();
        Serial.println(F("{\"status\":\"ok\",\"msg\":\"Rest baselines calibrated and saved to Flash\"}"));
        oledUpdate(true);
    }
    else if (line.equalsIgnoreCase("OLED_SCAN")) {
        oledScanBus();
    }
    else if (line.equalsIgnoreCase("OLED_TEST")) {
        oledTestPattern();
    }
    else if (line.startsWith("FULLSCREEN")) {
        String arg = line.substring(10);
        arg.trim();
        if (arg.length() > 0) {
            oledSetFullScreen(arg.toInt() != 0 || arg.equalsIgnoreCase("true") || arg.equalsIgnoreCase("on"));
        } else {
            oledSetFullScreen(!oledIsFullScreen());
        }
        Serial.printf("{\"status\":\"ok\",\"fullscreen\":%s}\n", oledIsFullScreen() ? "true" : "false");
    }
    else if (line.equalsIgnoreCase("SCREENSAVER")) {
        oledTriggerScreensaver();
        Serial.println(F("{\"status\":\"ok\",\"screensaver\":true}"));
    }
    else if (line.equalsIgnoreCase("SLEEP")) {
        oledSleep();
        Serial.println(F("{\"status\":\"ok\",\"sleep\":true}"));
    }
    else if (line.equalsIgnoreCase("WAKE")) {
        oledWake();
        Serial.println(F("{\"status\":\"ok\",\"wake\":true}"));
    }
    else if (line.startsWith("ANIM")) {
        String arg = line.substring(4);
        arg.trim();
        int idx = arg.length() > 0 ? arg.toInt() : -1;
        oledSetScreensaverAnim((int8_t)idx);
        oledTriggerScreensaver();
        Serial.printf("{\"status\":\"ok\",\"anim\":%d}\n", idx);
    }
    else if (line.equalsIgnoreCase("BOOTSEL")) {
        Serial.println(F("{\"status\":\"ok\",\"bootsel\":true}"));
        Serial.flush();
        delay(100);
        rp2040.rebootToBootloader();
    }
    else if (line.startsWith("SET_HID ") || line.startsWith("HID ")) {
        int space = line.indexOf(' ');
        int val = line.substring(space + 1).toInt();
        HallManager::setHidEnabled(val != 0);
        Serial.printf("{\"status\":\"ok\",\"hid_output\":%s}\n", HallManager::isHidEnabled() ? "true" : "false");
    }
    else {
        Serial.println(F("{\"status\":\"error\",\"msg\":\"Unknown command\"}"));
    }
}

} // namespace

void setup() {
    Serial.begin(115200);

    pinMode(LED_BUILTIN, OUTPUT);
    digitalWrite(LED_BUILTIN, HIGH);

    Keyboard.begin();
    Keyboard.releaseAll();

    muxInit();
    encoderInit();
    HallManager::init();
    configInit();   // Loads persistent Flash settings
    oledInit();     // Safe-zone OLED display initialization

    delay(150);
    HallManager::calibrateAllRestBaselines(64);

    oledUpdate(true);
    Serial.println(F("[SYSTEM] DriftPad Firmware v2.0 Online."));
}

void loop() {
    static uint32_t lastHeartbeat = 0;
    static bool ledState = false;

    // Heartbeat every 2 seconds
    if (millis() - lastHeartbeat >= 2000) {
        lastHeartbeat = millis();
        ledState = !ledState;
        digitalWrite(LED_BUILTIN, ledState ? HIGH : LOW);
    }

    // Process incoming Serial commands from Web Configurator or terminal
    while (Serial.available() > 0) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            if (s_serialBuffer.length() > 0) {
                processCommand(s_serialBuffer);
                s_serialBuffer = "";
            }
        } else if (s_serialBuffer.length() < 128) {
            s_serialBuffer += c;
        }
    }

    // Telemetry streaming at 30Hz if enabled
    if (s_streamTelemetry && (millis() - s_lastStreamTime >= 33)) {
        s_lastStreamTime = millis();
        sendStatusJson();
    }

    // Rotary encoder navigation
    encoderUpdate();
    int32_t delta = encoderGetDelta();
    if (delta != 0 && oledAdjustCurrentSetting(delta)) {
        s_encoderSavePending = true;
        s_lastEncoderEdit = millis();
    }
    if (encoderWasClicked()) {
        oledCycleMenu();
    }
    if (s_encoderSavePending && (millis() - s_lastEncoderEdit) >= ENCODER_SAVE_DELAY_MS) {
        s_encoderSavePending = false;
        configSave();
    }

    // Read physical switch multiplexer at a fixed 1 kHz. The DSP's sample-counted constants
    // (EMI correlation lags, chatter window, stationary timer) are tuned for this rate.
    uint32_t nowUs = micros();
    if ((int32_t)(nowUs - s_nextScanUs) >= 0) {
        s_nextScanUs += SCAN_PERIOD_US;
        if ((int32_t)(nowUs - s_nextScanUs) >= 0) {
            // Fell a full period behind: resync instead of bursting scans to catch up
            s_nextScanUs = nowUs + SCAN_PERIOD_US;
        }

        if (s_lastScanUs != 0 && nowUs - s_lastScanUs > s_maxScanGapUs) {
            s_maxScanGapUs = nowUs - s_lastScanUs;
        }
        s_lastScanUs = nowUs;
        HallManager::updateAll();
        if (s_rawCaptureKey >= 0) {
            s_rawCapture[s_rawCaptureCount++] = HallManager::getKey((uint8_t)s_rawCaptureKey).getRawAdc();
            if (s_rawCaptureCount >= RAW_CAPTURE_LEN) {
                finishRawCapture();
            }
        }
        s_scanCount++;
        if (nowUs - s_scanWindowStart >= 1000000UL) {
            s_scanRateHz = s_scanCount;
            s_scanCount = 0;
            s_scanWindowStart = nowUs;
        }
    }

    // Update safe-zone display
    oledUpdate(false);
}