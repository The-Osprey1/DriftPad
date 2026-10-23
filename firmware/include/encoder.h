#ifndef ENCODER_H
#define ENCODER_H

#include <cstdint>

/**
 * @file encoder.h
 * @brief Rotary encoder interface.
 *
 * Provides functions for initializing, updating, and reading the rotary
 * encoder and its push button. Used for menu navigation and live parameter
 * adjustment.
 */

/**
 * @brief Initializes the rotary encoder GPIO pins.
 */
void encoderInit();

/**
 * @brief Updates the rotary encoder position and debounces the push button.
 *
 * Call this repeatedly from the main loop.
 */
void encoderUpdate();

/**
 * @brief Gets the current encoder position.
 *
 * @return Signed encoder position, in detents.
 */
int32_t encoderGetPosition();

/**
 * @brief Gets the change in position since the last call.
 *
 * @return Signed number of detents turned since the previous call.
 */
int32_t encoderGetDelta();

/**
 * @brief Checks whether the encoder push button is pressed.
 *
 * @return True if pressed (debounced), otherwise false.
 */
bool encoderIsPressed();

/**
 * @brief Checks whether the push button was clicked since the last call.
 *
 * Clears the click once it has been read.
 *
 * @return True once per press, otherwise false.
 */
bool encoderWasClicked();

#endif // ENCODER_H
