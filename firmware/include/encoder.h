#ifndef ENCODER_H
#define ENCODER_H

#include <cstdint>

/**
 * @file encoder.h
 * @brief Rotary encoder driver for navigation and live parameter adjustment.
 */

void encoderInit();
void encoderUpdate();

// Absolute position
int32_t encoderGetPosition();

// Relative change since last call
int32_t encoderGetDelta();

// Push switch state (debounced)
bool encoderIsPressed();
bool encoderWasClicked();

#endif // ENCODER_H