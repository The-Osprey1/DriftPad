// Encoder wiring test. Prints the raw A, B and switch levels every 250 ms.
// Build and upload with: pio run -e pin_test -t upload
#include <Arduino.h>

#include "pins.h"

void setup() {
    Serial.begin(115200);

    // Same pull-ups as the main firmware, so idle reads HIGH and active reads LOW
    pinMode(ENCODER_A_PIN, INPUT_PULLUP);
    pinMode(ENCODER_B_PIN, INPUT_PULLUP);
    pinMode(ENCODER_SW_PIN, INPUT_PULLUP);
}

void loop() {
    const auto a = digitalRead(ENCODER_A_PIN);
    const auto b = digitalRead(ENCODER_B_PIN);
    const auto sw = digitalRead(ENCODER_SW_PIN);

    Serial.print("A: ");
    Serial.print(a);

    Serial.print(" B: ");
    Serial.print(b);

    Serial.print(" SW: ");
    Serial.println(sw);

    delay(250);
}
