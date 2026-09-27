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

void pd_boot() {
    host_clock_set_us(1000000);
    usbfake_reset();
    mux_fake_set_all(2048);
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
