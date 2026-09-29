#include "commands.h"

#include <Arduino.h>
#include <cstring>

#include "build_info.h"
#include "calibration.h"
#include "config.h"
#include "hall.h"
#include "keyboard_output.h"
#include "oled.h"
#include "display_link.h"
#include "settings_limits.h"

namespace commands {
namespace {

using proto::Args;
using proto::HandlerResult;
using proto::JsonWriter;
using proto::ParseResult;
using proto::Reply;
namespace err = proto::err;

proto::TxQueue* s_tx = nullptr;
Timing*         s_timing = nullptr;

// Telemetry subscription (STREAM)
bool     s_streaming = false;
uint8_t  s_streamHz = limits::STREAM_HZ_DEFAULT;
uint32_t s_nextFrameMs = 0;
uint32_t s_frameSeq = 0;
uint32_t s_framesDropped = 0;

// RAW <key>: one second of one key's raw samples at the scan rate, sent in chunks
constexpr uint16_t RAW_CAPTURE_LEN = 1000;
constexpr uint16_t RAW_CHUNK = 100;
uint16_t s_raw[RAW_CAPTURE_LEN];
uint16_t s_rawCount = 0;
uint16_t s_rawSent = 0;
int8_t   s_rawKey = -1;
bool     s_rawCapturing = false;

bool s_bootselRequested = false;

// Calibration: what power-up found, and the output state to restore after a guided session
BootReport s_boot = { CalState::Missing, 0, 0, 0, 0 };
bool       s_calSession = false;
bool       s_hostEdits = false;   // a command changed settings that are not saved yet
bool       s_outputBeforeCal = false;
KeyboardOutput::Reason s_reasonBeforeCal = KeyboardOutput::Reason::DisabledDefault;

char s_eventBuf[proto::MAX_EVENT_LEN];
proto::EventWriter s_events(s_eventBuf, sizeof(s_eventBuf));

// Commands that change something (settings, layer, keymap, calibration) count as user activity for
// the OLED. Read-only queries (PING, INFO, STATUS, GET_CONFIG, STREAM) do not: a configurator tab or
// a script polling in the background must not hold the screensaver off while the pad sits idle.
// Posting the request is all core 0 does; core 1 wakes the display.
void wakeDisplay() {
    Timing::Scoped t(*s_timing, Timing::Op::DisplayRequest);
    oledWake();
}

// OLED_TEST and OLED_SCAN are served by core 1; their replies are deferred until it has.
constexpr uint32_t DISPLAY_REPLY_TIMEOUT_MS = 1500;   // a scan of a stuck bus can take longer
uint32_t s_displayTicket = 0;

bool pollOledTest(Reply& r, void*) {
    if (!oledRequestServed(OledRequest::TestPattern, s_displayTicket)) return false;
    r.ok().key("display").str("test_pattern");
    return true;
}

bool pollOledScan(Reply& r, void*) {
    if (!oledRequestServed(OledRequest::BusScan, s_displayTicket)) return false;
    uint8_t found[display_link::SCAN_MAX];
    const uint8_t n = oledBusScanResult(found, sizeof(found));
    JsonWriter& w = r.ok();
    w.key("devices").beginArray();
    for (uint8_t i = 0; i < n && i < sizeof(found); ++i) w.u32(found[i]);
    w.endArray();
    if (n > sizeof(found)) w.key("more").u32(n - sizeof(found));
    return true;
}

void writeKeyList(JsonWriter& w, const char* key, uint16_t mask) {
    w.key(key).beginArray();
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        if (mask & (1u << i)) w.u32(i);
    }
    w.endArray();
}

const char* deliveryName(KeyboardOutput::Delivery d) {
    switch (d) {
        case KeyboardOutput::Delivery::Confirmed: return "confirmed";
        case KeyboardOutput::Delivery::InFlight:  return "in_flight";
        case KeyboardOutput::Delivery::Pending:   return "pending";
    }
    return "pending";
}

void writeOutput(JsonWriter& w) {
    KeyboardOutput::Stats st = KeyboardOutput::stats();
    w.key("output").beginObject();
    w.key("enabled").boolean(KeyboardOutput::isEnabled());
    w.key("reason").str(KeyboardOutput::reasonName(KeyboardOutput::reason()));
    writeKeyList(w, "active_keys", KeyboardOutput::activeKeysMask());
    writeKeyList(w, "suppressed_keys", KeyboardOutput::suppressedKeysMask());
    w.key("overflow").u32(st.overflowBlocked);
    w.key("delivery").str(deliveryName(KeyboardOutput::deliveryState()));
    w.endObject();
}

void writeSettingsState(JsonWriter& w) {
    const LoadReport& lr = configLoadReport();
    w.key("settings").beginObject();
    w.key("dirty").boolean(configIsDirty());
    w.key("source").str(settingsSourceName(lr.source));
    w.key("seq").u32(configSettingsSeq());
    w.key("load_errors").beginArray();
    for (uint16_t bit = 1; bit != 0; bit <<= 1) {
        if (lr.errors & bit) w.str(loadErrorName(bit));
    }
    w.endArray();
    w.endObject();
}

void writeLimit(JsonWriter& w, const char* key, uint16_t lo, uint16_t hi, uint16_t def) {
    w.key(key).beginObject();
    w.key("min").mm(lo).key("max").mm(hi).key("default").mm(def).key("step").mm(limits::UI_STEP_CMM);
    w.endObject();
}

CalState currentCalState() {
    if (Calibration::isActive()) return CalState::InProgress;
    return calibrationEvaluate(configGet().calibration);
}

KeyboardOutput::Reason disabledReasonFor(CalState st) {
    switch (st) {
        case CalState::Missing:    return KeyboardOutput::Reason::CalibrationMissing;
        case CalState::Invalid:    return KeyboardOutput::Reason::CalibrationInvalid;
        case CalState::InProgress: return KeyboardOutput::Reason::CalibrationInProgress;
        default:                   return KeyboardOutput::Reason::DisabledDefault;
    }
}

void writeCalibration(JsonWriter& w) {
    const CalibrationData& cal = configGet().calibration;
    uint8_t plausible = 0;
    if (cal.state == (uint8_t)CalState::Valid) {
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            if (calibrationKeyPlausible(cal.keys[i])) plausible++;
        }
    }
    w.key("calibration").beginObject();
    w.key("state").str(calStateName(currentCalState()));
    w.key("keys_valid").u32(plausible);
    writeKeyList(w, "held_at_boot", s_boot.heldMask);
    writeKeyList(w, "drift", s_boot.driftMask);
    writeKeyList(w, "faults", HallManager::faultMask());
    w.endObject();
}

void writeCalProgress(JsonWriter& w) {
    Calibration::Progress p = Calibration::progress();
    w.key("phase").str(Calibration::phaseName(p.phase));
    writeKeyList(w, "rest_ok", p.restOkMask);
    writeKeyList(w, "rest_failed", p.restFailedMask);
    writeKeyList(w, "travel_done", p.travelDoneMask);
    w.key("elapsed_ms").u32(p.elapsedMs);
}

// Ends a guided session that did not finish: the previous output state comes back (keys that are
// down stay suppressed until released, see KeyboardOutput::setEnabled)
void endCalibrationSession() {
    if (!s_calSession) return;
    s_calSession = false;
    KeyboardOutput::setEnabled(s_outputBeforeCal, s_reasonBeforeCal);
}

// Mutating replies: the effective state after the change, not the request's text
void writeApplied(JsonWriter& w) {
    s_hostEdits = true;
    w.key("applied").boolean(true);
    w.key("persisted").boolean(!configIsDirty());
    w.key("dirty").boolean(configIsDirty());
}

HandlerResult badValue(Reply& r, ParseResult pr, const char* msg) {
    r.error(pr, msg);
    return HandlerResult::Done;
}

HandlerResult rangeError(Reply& r, ParseResult pr, const char* what, uint16_t lo, uint16_t hi) {
    JsonWriter& w = r.error(pr, what);
    if (pr == ParseResult::OutOfRange) w.key("min").mm(lo).key("max").mm(hi);
    return HandlerResult::Done;
}

HandlerResult configError(Reply& r, ConfigStatus st, const char* msg) {
    r.error(configStatusCode(st), msg);
    return HandlerResult::Done;
}

// ---- queries ---------------------------------------------------------------------------------

HandlerResult cmdPing(const Args&, Reply& r, void*) {
    r.ok().key("type").str("pong");
    return HandlerResult::Done;
}

HandlerResult cmdInfo(const Args&, Reply& r, void*) {
    JsonWriter& w = r.ok();
    w.key("type").str("info");
    w.key("device").str(build_info::DEVICE);
    w.key("hw").str(build_info::HARDWARE);
    w.key("fw").str(build_info::FW_VERSION);
    w.key("protocol").u32(build_info::PROTOCOL);
    w.key("build").str(build_info::BUILD_ID);
    w.key("build_date").str(build_info::BUILD_DATE);
    w.key("features").beginArray();
    static const char* const FEATURES[] = { "keymap", "layers", "rapid_trigger", "telemetry", "timing",
                                            "raw", "sim", "display", "guided_calibration", "boot_output",
                                            "settings_ab" };
    for (const char* f : FEATURES) w.str(f);
    w.endArray();
    w.key("limits").beginObject();
    writeLimit(w, "actuation", limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM, limits::ACTUATION_DEFAULT_CMM);
    writeLimit(w, "rt_sens", limits::RT_SENS_MIN_CMM, limits::RT_SENS_MAX_CMM, limits::RT_SENS_DEFAULT_CMM);
    w.key("layers").u32(NUM_LAYERS);
    w.key("keys").u32(NUM_KEYS);
    w.key("label_max").u32(limits::LABEL_MAX_LEN);
    w.key("label_chars").str("printable ASCII except \" \\ @");
    w.key("code_max").u32(limits::CODE_MAX);
    w.key("line_max").u32(limits::LINE_MAX_LEN);
    w.key("stream_hz_max").u32(limits::STREAM_HZ_MAX);
    w.endObject();
    writeCalibration(w);
    writeOutput(w);
    writeSettingsState(w);
    w.key("uptime_ms").u32(millis());
    return HandlerResult::Done;
}

HandlerResult cmdGetConfig(const Args&, Reply& r, void*) {
    const DeviceSettings& c = configGet();
    JsonWriter& w = r.ok();
    w.key("type").str("config");
    w.key("actuation").mm(c.actuationCmm);
    w.key("rt_sens").mm(c.rtSensCmm);
    w.key("rt_enabled").boolean(c.rtEnabled);
    w.key("active_layer").u32(c.activeLayer);
    w.key("boot_output").boolean(c.bootOutput);
    w.key("dirty").boolean(configIsDirty());
    w.key("settings_seq").u32(configSettingsSeq());
    w.key("layers").beginArray();
    for (uint8_t l = 0; l < NUM_LAYERS; ++l) {
        w.beginArray();
        for (uint8_t k = 0; k < NUM_KEYS; ++k) {
            w.beginObject();
            w.key("idx").u32(k).key("code").u32(c.keymaps[l][k].hidCode);
            w.key("label").str(c.keymaps[l][k].label);
            w.endObject();
        }
        w.endArray();
    }
    w.endArray();
    return HandlerResult::Done;
}

HandlerResult cmdStatus(const Args&, Reply& r, void*) {
    JsonWriter& w = r.ok();
    w.key("type").str("status");
    w.key("active_layer").u32(configGet().activeLayer);
    w.key("last_key").i32(HallManager::getLastActiveKey());
    w.key("keys").beginArray();
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        HallKey& k = HallManager::getKey(i);
        w.beginObject();
        w.key("idx").u32(i);
        w.key("pressed").boolean(k.isPressed());
        w.key("travel").mm((int32_t)(k.getTravelMm() * 100.0f + 0.5f));
        w.key("label").str(k.getLabel());
        w.endObject();
    }
    w.endArray();
    writeOutput(w);
    w.key("calibration").beginObject().key("state").str(calStateName(currentCalState())).endObject();
    w.key("sim_mask").u32(HallManager::simMask());
    w.key("dirty").boolean(configIsDirty());
    return HandlerResult::Done;
}

HandlerResult cmdStream(const Args& a, Reply& r, void*) {
    bool on;
    ParseResult pr = proto::parseBool(a[0], on);
    if (pr != ParseResult::Ok) return badValue(r, pr, "STREAM takes 0 or 1");
    uint8_t hz = limits::STREAM_HZ_DEFAULT;
    if (a.count > 1) {
        uint32_t v;
        pr = proto::parseUint(a[1], 1, limits::STREAM_HZ_MAX, v);
        if (pr != ParseResult::Ok) {
            JsonWriter& w = r.error(pr, "rate must be 1 to the maximum stream rate");
            if (pr == ParseResult::OutOfRange) w.key("min").u32(1).key("max").u32(limits::STREAM_HZ_MAX);
            return HandlerResult::Done;
        }
        hz = (uint8_t)v;
    }
    s_streaming = on;
    s_streamHz = hz;
    s_nextFrameMs = millis();
    r.ok().key("streaming").boolean(s_streaming).key("hz").u32(s_streamHz);
    return HandlerResult::Done;
}

// ---- settings --------------------------------------------------------------------------------

HandlerResult cmdSetActuation(const Args& a, Reply& r, void*) {
    wakeDisplay();
    uint16_t cmm;
    ParseResult pr = proto::parseCmm(a[0], limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM, cmm);
    if (pr != ParseResult::Ok) {
        return rangeError(r, pr, "actuation must be a distance in mm with at most 2 decimals, within the limits",
                          limits::ACTUATION_MIN_CMM, limits::ACTUATION_MAX_CMM);
    }
    ConfigStatus st = configSetActuationCmm(cmm);
    if (st != ConfigStatus::Ok) return configError(r, st, "actuation rejected");
    JsonWriter& w = r.ok();
    w.key("actuation").mm(configGet().actuationCmm);
    writeApplied(w);
    return HandlerResult::Done;
}

HandlerResult cmdSetRtSens(const Args& a, Reply& r, void*) {
    wakeDisplay();
    uint16_t cmm;
    ParseResult pr = proto::parseCmm(a[0], limits::RT_SENS_MIN_CMM, limits::RT_SENS_MAX_CMM, cmm);
    if (pr != ParseResult::Ok) {
        return rangeError(r, pr, "RT sensitivity must be a distance in mm with at most 2 decimals, within the limits",
                          limits::RT_SENS_MIN_CMM, limits::RT_SENS_MAX_CMM);
    }
    ConfigStatus st = configSetRtSensCmm(cmm);
    if (st != ConfigStatus::Ok) return configError(r, st, "RT sensitivity rejected");
    JsonWriter& w = r.ok();
    w.key("rt_sens").mm(configGet().rtSensCmm);
    writeApplied(w);
    return HandlerResult::Done;
}

HandlerResult cmdSetRtEnable(const Args& a, Reply& r, void*) {
    wakeDisplay();
    bool on;
    ParseResult pr = proto::parseBool(a[0], on);
    if (pr != ParseResult::Ok) return badValue(r, pr, "SET_RT_ENABLE takes 0 or 1");
    configSetRtEnabled(on);
    JsonWriter& w = r.ok();
    w.key("rt_enabled").boolean(configGet().rtEnabled);
    writeApplied(w);
    return HandlerResult::Done;
}

HandlerResult cmdSetLayer(const Args& a, Reply& r, void*) {
    wakeDisplay();
    uint32_t layer;
    ParseResult pr = proto::parseUint(a[0], 0, NUM_LAYERS - 1, layer);
    if (pr != ParseResult::Ok) return badValue(r, pr, "layer must be 0, 1 or 2");
    ConfigStatus st = configSetActiveLayer((uint8_t)layer);
    if (st != ConfigStatus::Ok) return configError(r, st, "layer rejected");
    JsonWriter& w = r.ok();
    w.key("active_layer").u32(configGet().activeLayer);
    writeApplied(w);
    return HandlerResult::Done;
}

HandlerResult cmdSetKey(const Args& a, Reply& r, void*) {
    wakeDisplay();
    uint32_t layer, key, code;
    ParseResult pr = proto::parseUint(a[0], 0, NUM_LAYERS - 1, layer);
    if (pr != ParseResult::Ok) return badValue(r, pr, "layer must be 0, 1 or 2");
    pr = proto::parseUint(a[1], 0, NUM_KEYS - 1, key);
    if (pr != ParseResult::Ok) return badValue(r, pr, "key must be 0 to 15");
    pr = proto::parseUint(a[2], 0, limits::CODE_MAX, code);
    if (pr != ParseResult::Ok) return badValue(r, pr, "code must be 0 to 255");
    const char* label = a.count > 3 ? a[3] : nullptr;
    ConfigStatus st = configSetKey((uint8_t)layer, (uint8_t)key, (uint8_t)code, label);
    if (st == ConfigStatus::InvalidLabel) {
        return configError(r, st, "label must be 1-4 printable ASCII characters, not \" \\ or @");
    }
    if (st == ConfigStatus::InvalidCode) return configError(r, st, "code produces no keyboard output");
    if (st != ConfigStatus::Ok) return configError(r, st, "key update rejected");
    const LayerKey& lk = configGet().keymaps[layer][key];
    JsonWriter& w = r.ok();
    w.key("layer").u32(layer).key("key").u32(key).key("code").u32(lk.hidCode).key("label").str(lk.label);
    writeApplied(w);
    return HandlerResult::Done;
}

HandlerResult cmdSetHid(const Args& a, Reply& r, void*) {
    wakeDisplay();
    bool on;
    ParseResult pr = proto::parseBool(a[0], on);
    if (pr != ParseResult::Ok) return badValue(r, pr, "SET_HID takes 0 or 1");
    const bool force = a.count > 1;
    if (force && !proto::keywordIs(a[1], "force")) {
        r.error(err::BAD_REQUEST, "the only option is FORCE");
        return HandlerResult::Done;
    }
    if (Calibration::isActive()) {
        r.error(err::BUSY, "keyboard output stays off while calibration runs (CAL FINISH or CAL CANCEL)");
        return HandlerResult::Done;
    }
    const CalState cal = currentCalState();
    if (on && cal != CalState::Valid && !force) {
        JsonWriter& w = r.error(err::CALIBRATION_REQUIRED,
                                "calibrate first (CAL START), or add FORCE for bench testing");
        w.key("calibration").str(calStateName(cal));
        return HandlerResult::Done;
    }
    KeyboardOutput::Reason reason = !on ? KeyboardOutput::Reason::UserDisabled
                                  : (cal == CalState::Valid ? KeyboardOutput::Reason::Enabled
                                                            : KeyboardOutput::Reason::Forced);
    KeyboardOutput::setEnabled(on, reason);
    JsonWriter& w = r.ok();
    w.key("hid_output").boolean(KeyboardOutput::isEnabled());   // v1 field
    writeOutput(w);
    return HandlerResult::Done;
}

HandlerResult cmdSave(const Args&, Reply& r, void*) {
    wakeDisplay();
    SaveResult sr;
    {
        Timing::Scoped t(*s_timing, Timing::Op::Save);
        sr = configSave();
    }
    if (!sr.ok) {
        JsonWriter& w = r.error(sr.errorCode, "settings were not saved; the previous flash contents are unchanged or lost (see docs)");
        w.key("persisted").boolean(false).key("dirty").boolean(configIsDirty());
        return HandlerResult::Done;
    }
    s_hostEdits = false;
    JsonWriter& w = r.ok();
    w.key("persisted").boolean(true).key("dirty").boolean(configIsDirty());
    // Same names as INFO.settings.source, so a client can compare the two directly.
    w.key("slot").str(settingsSourceName(sr.slot == 0 ? SettingsSource::SlotA : SettingsSource::SlotB)).key("seq").u32(sr.seq);
    w.key("duration_ms").u32((sr.durationUs + 500) / 1000);
    return HandlerResult::Done;
}

HandlerResult cmdRevert(const Args&, Reply& r, void*) {
    wakeDisplay();
    if (Calibration::isActive()) {
        r.error(err::BUSY, "calibration is running (CAL FINISH or CAL CANCEL first)");
        return HandlerResult::Done;
    }
    const CalibrationData previous = configGet().calibration;
    if (!configRevert()) {
        r.error(err::NOT_ALLOWED, "no saved settings to revert to");
        return HandlerResult::Done;
    }
    const CalibrationData& restored = configGet().calibration;
    if (memcmp(&previous, &restored, sizeof(restored)) != 0) {
        // Restoring settings must also restore the sensing calibration they describe. Release
        // owned output before resetting the filters, and keep keys off rest silent until lifted.
        KeyboardOutput::releaseAll(HallManager::pressedMask());
        HallManager::simClearAll();
        const CalState state = calibrationEvaluate(restored);
        if (state == CalState::Valid) {
            const uint16_t offRest = Calibration::applyRuntime(restored, HallManager::lastRaw());
            for (uint8_t i = 0; i < NUM_KEYS; ++i) {
                if (offRest & (1u << i)) KeyboardOutput::suppressUntilRelease(i, true);
            }
            // A restored calibration permits output, but REVERT does not enable it by itself.
            if (KeyboardOutput::isEnabled()) {
                KeyboardOutput::setEnabled(true, KeyboardOutput::Reason::Enabled);
            } else if (KeyboardOutput::reason() == KeyboardOutput::Reason::CalibrationMissing ||
                       KeyboardOutput::reason() == KeyboardOutput::Reason::CalibrationInvalid) {
                KeyboardOutput::setEnabled(false, KeyboardOutput::Reason::DisabledDefault);
            }
        } else {
            // As for RESET ALL, keep the running baselines for diagnostics and gate output.
            KeyboardOutput::setEnabled(false, disabledReasonFor(state));
        }
    }
    s_hostEdits = false;
    JsonWriter& w = r.ok();
    w.key("applied").boolean(true).key("persisted").boolean(!configIsDirty()).key("dirty").boolean(configIsDirty());
    return HandlerResult::Done;
}

HandlerResult cmdReset(const Args& a, Reply& r, void*) {
    wakeDisplay();
    const bool all = a.count == 1;
    if (all && !proto::keywordIs(a[0], "all")) {
        r.error(err::BAD_REQUEST, "use RESET or RESET ALL");
        return HandlerResult::Done;
    }
    if (Calibration::isActive()) {
        r.error(err::BUSY, "calibration is running (CAL FINISH or CAL CANCEL first)");
        return HandlerResult::Done;
    }
    s_hostEdits = true;
    if (all) {
        // Calibration is cleared too: output goes off, the sensing keeps its running baselines
        configResetAll();
        KeyboardOutput::setEnabled(false, KeyboardOutput::Reason::CalibrationMissing);
    } else {
        configResetUser();
    }
    JsonWriter& w = r.ok();
    w.key("all").boolean(all);
    w.key("applied").boolean(true).key("persisted").boolean(!configIsDirty()).key("dirty").boolean(configIsDirty());
    return HandlerResult::Done;
}

HandlerResult cmdCalibrate(const Args&, Reply& r, void*) {
    wakeDisplay();
    if (Calibration::isActive()) {
        r.error(err::BUSY, "guided calibration is running");
        return HandlerResult::Done;
    }
    // Quick rest re-zero (v1 CALIBRATE): keys must be untouched. With valid calibration, polarity
    // and range are kept and a key found off rest in its press direction refuses the whole update.
    uint16_t rest[NUM_KEYS];
    HallManager::measureRest(rest, calib::BOOT_SAMPLES);
    CalibrationData data = configGet().calibration;
    uint16_t offRest = 0;
    const uint16_t pressed = HallManager::pressedMask();
    if (!Calibration::quickRestRecalibrate(data, rest, offRest)) {
        JsonWriter& w = r.error(err::KEYS_NOT_AT_REST,
                                "rest readings rejected; release every key or run CAL START to recalibrate travel");
        writeKeyList(w, "keys", offRest);
        return HandlerResult::Done;
    }
    // Refused above: a key that is down keeps typing. Accepted: the state machines were reset, so
    // whatever is down stays silent until released.
    KeyboardOutput::releaseAll(pressed);
    const bool valid = calibrationEvaluate(data) == CalState::Valid;
    if (valid) { configSetCalibration(data); s_hostEdits = true; }
    JsonWriter& w = r.ok();
    // Without a valid calibration only the running baselines were re-zeroed: nothing was stored
    w.key("applied").boolean(valid);
    w.key("persisted").boolean(!configIsDirty()).key("dirty").boolean(configIsDirty());
    w.key("calibration").str(calStateName(currentCalState()));
    return HandlerResult::Done;
}

HandlerResult cmdCal(const Args& a, Reply& r, void*) {
    wakeDisplay();
    const uint32_t now = millis();
    if (proto::keywordIs(a[0], "start")) {
        if (Calibration::isActive()) {
            r.error(err::BUSY, "calibration is already running");
            return HandlerResult::Done;
        }
        s_outputBeforeCal = KeyboardOutput::isEnabled();
        s_reasonBeforeCal = KeyboardOutput::reason();
        // Nothing may type while keys are pressed on purpose
        KeyboardOutput::setEnabled(false, KeyboardOutput::Reason::CalibrationInProgress);
        HallManager::simClearAll();
        Calibration::begin(now);
        s_calSession = true;
        JsonWriter& w = r.ok();
        w.key("phase").str("rest").key("rest_ms").u32(calib::REST_PHASE_MS);
        return HandlerResult::Done;
    }
    if (proto::keywordIs(a[0], "status")) {
        JsonWriter& w = r.ok();
        w.key("type").str("cal");
        writeCalProgress(w);
        return HandlerResult::Done;
    }
    if (proto::keywordIs(a[0], "cancel")) {
        Calibration::cancel();
        endCalibrationSession();
        JsonWriter& w = r.ok();
        w.key("phase").str("cancelled");
        writeOutput(w);
        return HandlerResult::Done;
    }
    if (proto::keywordIs(a[0], "finish")) {
        CalibrationData data;
        uint16_t missing = 0;
        if (!Calibration::isActive()) {
            // Nothing to finish (never started, cancelled, failed or already finished)
            JsonWriter& w = r.error(err::NOT_ALLOWED, "no calibration is running; start one with CAL START");
            w.key("phase").str(Calibration::phaseName(Calibration::progress().phase));
            return HandlerResult::Done;
        }
        if (!Calibration::finish(data, missing)) {
            JsonWriter& w = r.error(err::CALIBRATION_INCOMPLETE,
                                    "every key must be pressed to the bottom and released once");
            writeKeyList(w, "missing", missing);
            w.key("phase").str(Calibration::phaseName(Calibration::progress().phase));
            return HandlerResult::Done;
        }
        s_hostEdits = true;
        ConfigStatus st = configSetCalibration(data);
        if (st != ConfigStatus::Ok) {
            configError(r, st, "measured calibration failed validation");
            endCalibrationSession();
            return HandlerResult::Done;
        }
        // The new zero points apply now; keys still off rest stay silent until released
        const uint16_t offRest = Calibration::applyRuntime(data, HallManager::lastRaw());
        s_calSession = false;
        if (s_outputBeforeCal) {
            KeyboardOutput::setEnabled(true, KeyboardOutput::Reason::Enabled);
        } else {
            KeyboardOutput::setEnabled(false, s_reasonBeforeCal == KeyboardOutput::Reason::CalibrationMissing ||
                                                  s_reasonBeforeCal == KeyboardOutput::Reason::CalibrationInvalid
                                              ? KeyboardOutput::Reason::DisabledDefault : s_reasonBeforeCal);
        }
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            if (offRest & (1u << i)) KeyboardOutput::suppressUntilRelease(i, true);
        }
        JsonWriter& w = r.ok();
        w.key("applied").boolean(true);
        w.key("persisted").boolean(!configIsDirty()).key("dirty").boolean(configIsDirty());
        w.key("calibration").beginObject().key("state").str(calStateName(currentCalState())).endObject();
        writeOutput(w);
        return HandlerResult::Done;
    }
    r.error(err::BAD_REQUEST, "use CAL START, CAL STATUS, CAL FINISH or CAL CANCEL");
    return HandlerResult::Done;
}

HandlerResult cmdSetBootOutput(const Args& a, Reply& r, void*) {
    wakeDisplay();
    bool on;
    ParseResult pr = proto::parseBool(a[0], on);
    if (pr != ParseResult::Ok) return badValue(r, pr, "SET_BOOT_OUTPUT takes 0 or 1");
    configSetBootOutput(on);
    JsonWriter& w = r.ok();
    w.key("boot_output").boolean(configGet().bootOutput);
    writeApplied(w);
    return HandlerResult::Done;
}

// ---- diagnostics -----------------------------------------------------------------------------

HandlerResult cmdSim(const Args& a, Reply& r, void*) {
    wakeDisplay();
    if (Calibration::isActive()) {
        r.error(err::BUSY, "calibration is running");
        return HandlerResult::Done;
    }
    if (a.count == 1) {
        if (!proto::keywordIs(a[0], "off")) {
            r.error(err::BAD_REQUEST, "use SIM <key> <mm>, SIM <key> OFF or SIM OFF");
            return HandlerResult::Done;
        }
        HallManager::simClearAll();
        r.ok().key("sim_mask").u32(HallManager::simMask());
        return HandlerResult::Done;
    }
    uint32_t key;
    ParseResult pr = proto::parseUint(a[0], 0, NUM_KEYS - 1, key);
    if (pr != ParseResult::Ok) return badValue(r, pr, "key must be 0 to 15");
    if (proto::keywordIs(a[1], "off")) {
        HallManager::simClear((uint8_t)key);
        r.ok().key("key").u32(key).key("sim_mask").u32(HallManager::simMask());
        return HandlerResult::Done;
    }
    uint16_t cmm;
    pr = proto::parseCmm(a[1], 0, 400, cmm);
    if (pr != ParseResult::Ok) return rangeError(r, pr, "travel must be 0.00 to 4.00 mm", 0, 400);
    HallManager::simSet((uint8_t)key, limits::cmmToMm(cmm), millis());
    HallKey& k = HallManager::getKey((uint8_t)key);
    JsonWriter& w = r.ok();
    w.key("type").str("sim_event");
    w.key("key").u32(key);
    w.key("travel").mm((int32_t)(k.getTravelMm() * 100.0f + 0.5f));
    w.key("pressed").boolean(k.isPressed());
    w.key("sim_mask").u32(HallManager::simMask());
    return HandlerResult::Done;
}

HandlerResult cmdScanRate(const Args&, Reply& r, void*) {
    wakeDisplay();
    JsonWriter& w = r.ok();
    w.key("type").str("scan_rate");
    s_timing->writeScanRateFields(w, true);
    return HandlerResult::Done;
}

HandlerResult cmdTiming(const Args& a, Reply& r, void*) {
    wakeDisplay();
    if (a.count == 1) {
        if (!proto::keywordIs(a[0], "reset")) {
            r.error(err::BAD_REQUEST, "use TIMING or TIMING RESET");
            return HandlerResult::Done;
        }
        s_timing->reset();
        r.ok().key("reset").boolean(true);
        return HandlerResult::Done;
    }
    JsonWriter& w = r.ok();
    w.key("type").str("timing");
    s_timing->writeTimingFields(w, millis(), s_tx);
    w.key("telemetry_dropped").u32(s_framesDropped);
    return HandlerResult::Done;
}

HandlerResult cmdRaw(const Args& a, Reply& r, void*) {
    wakeDisplay();
    uint32_t key;
    ParseResult pr = proto::parseUint(a[0], 0, NUM_KEYS - 1, key);
    if (pr != ParseResult::Ok) return badValue(r, pr, "key must be 0 to 15");
    s_rawKey = (int8_t)key;
    s_rawCount = 0;
    s_rawSent = 0;
    s_rawCapturing = true;
    r.ok().key("key").u32(key).key("samples").u32(RAW_CAPTURE_LEN).key("rate_hz").u32(1000);
    return HandlerResult::Done;
}

// ---- display (v1 behaviour; the display itself is not part of the protocol contract) --------

HandlerResult cmdFullscreen(const Args& a, Reply& r, void*) {
    wakeDisplay();
    if (a.count == 0) {
        oledSetFullScreen(!oledIsFullScreen());
    } else {
        bool on;
        ParseResult pr = proto::parseBool(a[0], on);
        if (pr != ParseResult::Ok) return badValue(r, pr, "FULLSCREEN takes 0 or 1");
        oledSetFullScreen(on);
    }
    r.ok().key("fullscreen").boolean(oledIsFullScreen());
    return HandlerResult::Done;
}

HandlerResult cmdScreensaver(const Args&, Reply& r, void*) {
    oledTriggerScreensaver();
    r.ok().key("screensaver").boolean(true);
    return HandlerResult::Done;
}

HandlerResult cmdAnim(const Args& a, Reply& r, void*) {
    int32_t idx = -1;   // no argument: cycle through all animations
    if (a.count == 1) {
        uint32_t v;
        ParseResult pr = proto::parseUint(a[0], 0, OLED_ANIM_COUNT - 1, v);
        if (pr != ParseResult::Ok) return badValue(r, pr, "animation must be 0 to 5 (omit it to cycle)");
        idx = (int32_t)v;
    }
    oledSetScreensaverAnim((int8_t)idx);
    oledTriggerScreensaver();
    r.ok().key("anim").i32(idx);
    return HandlerResult::Done;
}

HandlerResult cmdSleep(const Args&, Reply& r, void*) {
    oledSleep();
    r.ok().key("sleep").boolean(true);
    return HandlerResult::Done;
}

HandlerResult cmdWake(const Args&, Reply& r, void*) {
    oledWake();
    r.ok().key("wake").boolean(true);
    return HandlerResult::Done;
}

HandlerResult cmdOledTest(const Args&, Reply& r, void*) {
    wakeDisplay();
    const HandlerResult result = r.defer(pollOledTest, nullptr, DISPLAY_REPLY_TIMEOUT_MS, err::DISPLAY_TIMEOUT,
                                         "the display core did not draw the test pattern in time");
    if (result == HandlerResult::Deferred) s_displayTicket = oledPost(OledRequest::TestPattern);
    return result;
}

HandlerResult cmdOledScan(const Args&, Reply& r, void*) {
    wakeDisplay();
    const HandlerResult result = r.defer(pollOledScan, nullptr, DISPLAY_REPLY_TIMEOUT_MS, err::DISPLAY_TIMEOUT,
                                         "the display core did not finish the I2C scan in time");
    if (result == HandlerResult::Deferred) s_displayTicket = oledPost(OledRequest::BusScan);
    return result;
}

HandlerResult cmdBootsel(const Args&, Reply& r, void*) {
    // The reply is flushed by main before the reboot (see main.cpp)
    KeyboardOutput::setEnabled(false, KeyboardOutput::Reason::UserDisabled);
    s_bootselRequested = true;
    r.ok().key("bootsel").boolean(true);
    return HandlerResult::Done;
}

const proto::CommandDef TABLE[] = {
    { "PING",          nullptr,   0, 0, cmdPing },
    { "INFO",          "HELLO",   0, 0, cmdInfo },
    { "GET_CONFIG",    nullptr,   0, 0, cmdGetConfig },
    { "STATUS",        nullptr,   0, 0, cmdStatus },
    { "STREAM",        nullptr,   1, 2, cmdStream },
    { "SET_ACTUATION", nullptr,   1, 1, cmdSetActuation },
    { "SET_RT_SENS",   nullptr,   1, 1, cmdSetRtSens },
    { "SET_RT_ENABLE", nullptr,   1, 1, cmdSetRtEnable },
    { "SET_LAYER",     nullptr,   1, 1, cmdSetLayer },
    { "SET_KEY",       nullptr,   3, 4, cmdSetKey },
    { "SET_HID",       "HID|OUTPUT", 1, 2, cmdSetHid },
    { "SAVE",          nullptr,   0, 0, cmdSave },
    { "REVERT",        nullptr,   0, 0, cmdRevert },
    { "RESET",         nullptr,   0, 1, cmdReset },
    { "CALIBRATE",     nullptr,   0, 0, cmdCalibrate },
    { "CAL",           nullptr,   1, 1, cmdCal },
    { "SET_BOOT_OUTPUT", nullptr, 1, 1, cmdSetBootOutput },
    { "SIM",           nullptr,   1, 2, cmdSim },
    { "SCAN_RATE",     nullptr,   0, 0, cmdScanRate },
    { "TIMING",        nullptr,   0, 1, cmdTiming },
    { "RAW",           nullptr,   1, 1, cmdRaw },
    { "FULLSCREEN",    nullptr,   0, 1, cmdFullscreen },
    { "SCREENSAVER",   nullptr,   0, 0, cmdScreensaver },
    { "ANIM",          nullptr,   0, 1, cmdAnim },
    { "SLEEP",         nullptr,   0, 0, cmdSleep },
    { "WAKE",          nullptr,   0, 0, cmdWake },
    { "OLED_TEST",     nullptr,   0, 0, cmdOledTest },
    { "OLED_SCAN",     nullptr,   0, 0, cmdOledScan },
    { "BOOTSEL",       nullptr,   0, 0, cmdBootsel },
};

void sendTelemetry(uint32_t nowMs) {
    Timing::Scoped t(*s_timing, Timing::Op::Telemetry);
    JsonWriter& w = s_events.begin("telemetry");
    w.key("seq").u32(s_frameSeq++);
    w.key("t").u32(nowMs);
    w.key("layer").u32(configGet().activeLayer);
    w.key("pressed").u32(HallManager::pressedMask());
    w.key("active").u32(KeyboardOutput::activeKeysMask());
    w.key("sim").u32(HallManager::simMask());
    w.key("travel").beginArray();
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        w.i32((int32_t)(HallManager::getKey(i).getTravelMm() * 100.0f + 0.5f));
    }
    w.endArray();
    w.key("dirty").boolean(configIsDirty());
    if (!s_events.send(*s_tx)) s_framesDropped++;
}

bool sendRawChunk() {
    uint16_t n = (uint16_t)(s_rawCount - s_rawSent);
    if (n > RAW_CHUNK) n = RAW_CHUNK;
    JsonWriter& w = s_events.begin("raw");
    w.key("key").u32((uint32_t)s_rawKey).key("rate_hz").u32(1000);
    w.key("offset").u32(s_rawSent).key("total").u32(RAW_CAPTURE_LEN);
    w.key("samples").beginArray();
    for (uint16_t i = 0; i < n; ++i) w.u32(s_raw[s_rawSent + i]);
    w.endArray();
    if (!s_events.send(*s_tx)) return false;   // retried on a later slice
    s_rawSent = (uint16_t)(s_rawSent + n);
    return true;
}

} // namespace

void init(proto::TxQueue& tx, Timing& timing) {
    s_tx = &tx;
    s_timing = &timing;
    s_hostEdits = false;
    s_streaming = false;
    s_streamHz = limits::STREAM_HZ_DEFAULT;
    s_frameSeq = 0;
    s_framesDropped = 0;
    s_rawCapturing = false;
    s_rawKey = -1;
    s_rawCount = s_rawSent = 0;
    s_bootselRequested = false;
    s_calSession = false;
    Calibration::reset();
}

void onBoot(const BootReport& report) {
    s_boot = report;
    if (report.state == CalState::Valid && configGet().bootOutput) {
        KeyboardOutput::setEnabled(true, KeyboardOutput::Reason::Enabled);
        for (uint8_t i = 0; i < NUM_KEYS; ++i) {
            if (report.heldMask & (1u << i)) KeyboardOutput::suppressUntilRelease(i, true);
        }
    } else {
        KeyboardOutput::setEnabled(false, report.state == CalState::Valid ? KeyboardOutput::Reason::DisabledDefault
                                                                          : disabledReasonFor(report.state));
    }
}

const proto::CommandDef* table() { return TABLE; }
uint8_t tableSize() { return (uint8_t)(sizeof(TABLE) / sizeof(TABLE[0])); }

void onScan() {
    if (Calibration::isActive()) {
        Timing::Scoped t(*s_timing, Timing::Op::Calibration);
        Calibration::onScan(HallManager::lastRaw(), millis());
        // A failed/timed-out session must restore output before the scheduler handles the next
        // command. Otherwise a same-loop REVERT, RESET ALL or SET_HID 0 could be undone later by
        // service() restoring the session's old enabled state.
        if (!Calibration::isActive()) endCalibrationSession();
    }
    if (s_rawCapturing && s_rawCount < RAW_CAPTURE_LEN) {
        s_raw[s_rawCount++] = HallManager::lastRaw()[(uint8_t)s_rawKey];
    }
}

void service(uint32_t nowMs) {
    if (Calibration::takeEvent()) {
        JsonWriter& w = s_events.begin("cal");
        writeCalProgress(w);
        s_events.send(*s_tx);
        // A session that ended on its own (rest phase failed, inactivity timeout) gives the
        // keyboard back as it was
        if (!Calibration::isActive() && Calibration::progress().phase != Calibration::Phase::Done) {
            endCalibrationSession();
        }
        return;
    }
    if (s_rawCapturing && s_rawSent < s_rawCount &&
        (s_rawCount == RAW_CAPTURE_LEN || (uint16_t)(s_rawCount - s_rawSent) >= RAW_CHUNK)) {
        if (sendRawChunk() && s_rawSent == RAW_CAPTURE_LEN) s_rawCapturing = false;
        return;
    }
    if (s_streaming && (int32_t)(nowMs - s_nextFrameMs) >= 0) {
        s_nextFrameMs = nowMs + 1000u / s_streamHz;
        sendTelemetry(nowMs);
    }
}

void onHostDisconnected() {
    s_streaming = false;
    s_rawCapturing = false;
}

void queueBootEvent() {
    JsonWriter& w = s_events.begin("boot");
    w.key("device").str(build_info::DEVICE).key("fw").str(build_info::FW_VERSION);
    w.key("protocol").u32(build_info::PROTOCOL).key("build").str(build_info::BUILD_ID);
    w.key("settings_source").str(settingsSourceName(configLoadReport().source));
    w.key("calibration").str(calStateName(currentCalState()));
    w.key("output_enabled").boolean(KeyboardOutput::isEnabled());
    s_events.send(*s_tx);
}

bool streaming() { return s_streaming; }

bool takeBootselRequest() {
    bool r = s_bootselRequested;
    s_bootselRequested = false;
    return r;
}

bool hostEditsUnsaved() {
    return s_hostEdits;
}

} // namespace commands
