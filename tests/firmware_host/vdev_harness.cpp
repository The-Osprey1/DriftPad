// C ABI over the current firmware image (main.cpp setup()/loop() and every module it links, with
// the OLED stubbed) running on the host fakes: tests/device_host.py drives it through the fake
// USB serial port and reads the engine's effective state here.
#include <cstring>
#include "Arduino.h"
#include "hall.h"
#include "config.h"
#include "keyboard_output.h"
#include "encoder_menu.h"
#include "pins.h"

extern "C" void host_clock_set_us(uint64_t us);
extern "C" void host_clock_advance_us(uint64_t us);
extern "C" void usbfake_reset();
extern "C" void usbfake_run_task();
extern "C" void mux_fake_set_all(uint16_t value);
extern "C" void mux_fake_set(uint8_t channel, uint16_t value);
extern "C" void serial_fake_reset();

void setup();
void loop();

extern "C" {

// Power-on: fresh RAM state for the host fakes, flash (EEPROM sector) kept
// Power cycle: the firmware starts again from setup(). Flash (settings) and the physical key
// positions (the mux inputs) are kept; USB re-enumerates; time keeps moving forward (static state
// that setup() does not initialise would otherwise see the clock run backwards).
void vd_boot() {
    host_clock_advance_us(1000000);
    usbfake_reset();
    serial_fake_reset();
    setup();
}

// One loop() iteration per 100 us of fake time
void vd_loop(int n) {
    for (int i = 0; i < n; ++i) {
        loop();
        host_clock_advance_us(100);
        usbfake_run_task();
    }
}

void  vd_set_travel(int key, float mm) {
    float raw = 2048.0f + mm * 250.0f;
    mux_fake_set(KEY_MUX_CHANNELS[key], (uint16_t)(raw + 0.5f));
}
float vd_engine_actuation() { return HallKey::getActuationPoint(); }
float vd_engine_rt_sens() { return HallKey::getRtSensitivity(); }
int   vd_engine_rt_enabled() { return HallKey::isRapidTrigger() ? 1 : 0; }
int   vd_active_layer() { return configGet().activeLayer; }
int   vd_engine_code(int key) { return HallManager::getKey((uint8_t)key).getHidKeyCode(); }
int   vd_dirty() { return configIsDirty() ? 1 : 0; }
int   vd_output_enabled() { return KeyboardOutput::isEnabled() ? 1 : 0; }
int   vd_is_pressed(int key) { return HallManager::getKey((uint8_t)key).isPressed() ? 1 : 0; }
int   vd_encoder_apply(int page, int delta) { return encoderMenuApply((MenuMode)page, delta) ? 1 : 0; }

}

extern "C" int vd_normalize_label(const char* in, char* out5) {
    return configNormalizeLabel(in, out5) ? 1 : 0;
}

extern "C" int vd_cal_key_plausible(int rest, int range, int polarity) {
    KeyCalibration k = { (uint16_t)rest, (uint16_t)range, (int8_t)polarity, 0 };
    return calibrationKeyPlausible(k) ? 1 : 0;
}
