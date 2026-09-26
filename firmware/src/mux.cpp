#include "mux.h"
#include <Arduino.h>

void muxInit() {
    pinMode(MUX_S0_PIN, OUTPUT);
    pinMode(MUX_S1_PIN, OUTPUT);
    pinMode(MUX_S2_PIN, OUTPUT);
    pinMode(MUX_S3_PIN, OUTPUT);

    digitalWrite(MUX_S0_PIN, LOW);
    digitalWrite(MUX_S1_PIN, LOW);
    digitalWrite(MUX_S2_PIN, LOW);
    digitalWrite(MUX_S3_PIN, LOW);

    pinMode(MUX_COM_PIN, INPUT);
    analogReadResolution(12); // 12-bit ADC (0 - 4095)
}

void muxSelect(uint8_t channel) {
    digitalWrite(MUX_S0_PIN, (channel & 0x01) ? HIGH : LOW);
    digitalWrite(MUX_S1_PIN, (channel & 0x02) ? HIGH : LOW);
    digitalWrite(MUX_S2_PIN, (channel & 0x04) ? HIGH : LOW);
    digitalWrite(MUX_S3_PIN, (channel & 0x08) ? HIGH : LOW);
}

uint16_t muxReadChannel(uint8_t channel) {
    muxSelect(channel);
    delayMicroseconds(2); // Settle time for 74HC4067 Ron + track capacitance
    return analogRead(MUX_COM_PIN);
}

void muxReadAllKeys(uint16_t* rawOut) {
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        rawOut[i] = muxReadChannel(KEY_MUX_CHANNELS[i]);
    }
}
