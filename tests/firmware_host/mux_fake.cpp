// Fake CD74HC4067 + ADC for host tests: every mux channel returns a value the test sets.
#include "mux.h"

namespace {
uint16_t s_adc[16];
}

extern "C" {
void mux_fake_set(uint8_t channel, uint16_t value) {
    if (channel < 16) s_adc[channel] = value > 4095 ? 4095 : value;
}
void mux_fake_set_all(uint16_t value) {
    for (uint8_t i = 0; i < 16; ++i) mux_fake_set(i, value);
}
uint16_t mux_fake_get(uint8_t channel) { return channel < 16 ? s_adc[channel] : 0; }
}

void muxInit() {}
void muxSelect(uint8_t) {}
uint16_t muxReadChannel(uint8_t channel) { return channel < 16 ? s_adc[channel] : 0; }
void muxReadAllKeys(uint16_t* rawOut) {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) rawOut[i] = s_adc[KEY_MUX_CHANNELS[i]];
}
