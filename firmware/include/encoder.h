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

/**
 * @brief Checks for a short press: released before the long-press time.
 *
 * Fires on release and clears once read.
 */
bool encoderTakeShortPress();

/**
 * @brief Checks for a long press: held for one second.
 *
 * Fires once while still held (the release then fires nothing) and clears once read.
 */
bool encoderTakeLongPress();

/**
 * @brief Raw pin levels from the last update, for wiring checks.
 *
 * @return Bit 0 = A, bit 1 = B, bit 2 = switch; a set bit means the pin reads HIGH
 *         (contact open, since the inputs use pull-ups).
 */
uint8_t encoderRawLevels();

/**
 * @brief Quadrature steps counted since boot, 4 per detent on a standard encoder.
 *
 * @return Signed step count; unlike encoderGetPosition() it shows every edge, even part of a detent.
 */
int32_t encoderStepCount();

/**
 * @brief Debounced presses of the push switch since boot.
 *
 * @return Press count.
 */
uint32_t encoderPressCount();

#endif // ENCODER_H
