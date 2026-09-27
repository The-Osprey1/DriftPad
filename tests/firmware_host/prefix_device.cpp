// C ABI over the pre-fix firmware (main.cpp, config.cpp, hall.cpp of commit e2031e2) running on
// host fakes, for defect-reproduction tests: commands go in through the fake Serial, replies and
// the engine's effective settings come out.
#include <cstring>
#include "Arduino.h"
#include "hall.h"
#include "config.h"

extern "C" void host_clock_set_us(uint64_t us);
extern "C" void host_clock_advance_us(uint64_t us);
extern "C" void usbfake_reset();
extern "C" void usbfake_run_task();
extern "C" void mux_fake_set_all(uint16_t value);
extern "C" void serial_fake_reset();

void setup();
void loop();

extern "C" {

// Power cycle: the firmware starts again from setup(). Flash (settings) and the physical key
// positions (the mux inputs) are kept; USB re-enumerates; time keeps moving forward (static state
// that setup() does not initialise would otherwise see the clock run backwards).
void pd_boot() {
    host_clock_advance_us(1000000);
    usbfake_reset();
    serial_fake_reset();
    setup();
}

// One loop() iteration per 100 us of fake time (the old loop scans when 1 ms has passed)
void pd_loop(int n) {
    for (int i = 0; i < n; ++i) {
        loop();
        host_clock_advance_us(100);
        usbfake_run_task();
    }
}

float pd_engine_actuation() { return HallKey::getActuationPoint(); }
float pd_engine_rt_sens() { return HallKey::getRtSensitivity(); }
int   pd_engine_rt_enabled() { return HallKey::isRapidTrigger() ? 1 : 0; }
int   pd_active_layer() { return configGet().activeLayer; }
float pd_stored_actuation() { return configGet().actuationMm; }
int   pd_key_code(int layer, int key) { return configGet().keymaps[layer][key].hidCode; }
void  pd_key_label(int layer, int key, char* out5) {
    memcpy(out5, configGet().keymaps[layer][key].label, 5);

}

}

extern "C" int pd_is_pressed(int key) { return HallManager::getKey((uint8_t)key).isPressed() ? 1 : 0; }

extern "C" void mux_fake_set(uint8_t channel, uint16_t value);

extern "C" void pd_set_travel(int key, float mm) {
    float raw = 2048.0f + mm * 250.0f;
    mux_fake_set(KEY_MUX_CHANNELS[key], (uint16_t)(raw + 0.5f));
}
