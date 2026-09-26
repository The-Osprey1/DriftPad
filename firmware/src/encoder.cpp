#include "encoder.h"
#include "pins.h"
#include <Arduino.h>

namespace {

int32_t s_position = 0;
int32_t s_lastReportedPosition = 0;

uint8_t s_lastState = 0;

// Button debounce
bool s_lastBtnState = false;
bool s_clicked = false;
uint32_t s_lastBtnDebounceTime = 0;
constexpr uint32_t DEBOUNCE_DELAY_MS = 25;

// Gray code state table for 4-step rotary encoders
// Prev state [1:0] << 2 | Curr state [1:0]
const int8_t QUADRATURE_TABLE[16] = {
     0, -1,  1,  0,
     1,  0,  0, -1,
    -1,  0,  0,  1,
     0,  1, -1,  0
};

} // namespace

void encoderInit() {
    pinMode(ENCODER_A_PIN, INPUT_PULLUP);
    pinMode(ENCODER_B_PIN, INPUT_PULLUP);
    pinMode(ENCODER_SW_PIN, INPUT_PULLUP);

    uint8_t a = digitalRead(ENCODER_A_PIN);
    uint8_t b = digitalRead(ENCODER_B_PIN);
    s_lastState = (a << 1) | b;
    s_position = 0;
    s_lastReportedPosition = 0;
    s_lastBtnState = (digitalRead(ENCODER_SW_PIN) == LOW);
}

void encoderUpdate() {
    uint8_t a = digitalRead(ENCODER_A_PIN);
    uint8_t b = digitalRead(ENCODER_B_PIN);
    uint8_t currState = (a << 1) | b;

    uint8_t index = (s_lastState << 2) | currState;
    int8_t step = QUADRATURE_TABLE[index];

    if (step != 0) {
        s_position += step;
        s_lastState = currState;
    }

    // Debounce button
    bool reading = (digitalRead(ENCODER_SW_PIN) == LOW);
    if (reading != s_lastBtnState) {
        if ((millis() - s_lastBtnDebounceTime) > DEBOUNCE_DELAY_MS) {
            s_lastBtnDebounceTime = millis();
            s_lastBtnState = reading;
            if (s_lastBtnState) {
                s_clicked = true;
            }
        }
    }
}

int32_t encoderGetPosition() {
    // Standard detented rotary encoders have 4 quadrature counts per click
    return s_position / 4;
}

int32_t encoderGetDelta() {
    int32_t current = encoderGetPosition();
    int32_t delta = current - s_lastReportedPosition;
    s_lastReportedPosition = current;
    return delta;
}

bool encoderIsPressed() {
    return s_lastBtnState;
}

bool encoderWasClicked() {
    if (s_clicked) {
        s_clicked = false;
        return true;
    }
    return false;
}