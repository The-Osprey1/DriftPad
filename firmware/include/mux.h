#ifndef MUX_H
#define MUX_H

#include <cstdint>
#include "pins.h"

/**
 * @file mux.h
 * @brief Driver for CD74HC4067 16-channel analog multiplexer on RP2040.
 */

/**
 * @brief Initialize multiplexer address GPIOs and ADC.
 */
void muxInit();

/**
 * @brief Select a multiplexer channel (0-15).
 * @param channel Channel index 0..15
 */
void muxSelect(uint8_t channel);

/**
 * @brief Read analog value for a given channel.
 * @param channel Channel index 0..15
 * @return 12-bit ADC value (0-4095)
 */
uint16_t muxReadChannel(uint8_t channel);

/**
 * @brief Fast sweep of all key channels in order of KEY_MUX_CHANNELS.
 * @param rawOut Buffer of at least NUM_KEYS elements.
 */
void muxReadAllKeys(uint16_t* rawOut);

#endif // MUX_H