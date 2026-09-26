#ifndef PINS_H
#define PINS_H

#include <cstdint>

/**
 * @file pins.h
 * @brief Pin definitions for DriftPad V2 (RP2040).
 *
 * Mapped directly from the Driftpad-fix2 KiCad PCB layout.
 */

// Rotary Encoder
constexpr uint8_t ENCODER_A_PIN   = 20; // GP20
constexpr uint8_t ENCODER_B_PIN   = 21; // GP21
constexpr uint8_t ENCODER_SW_PIN  = 4;  // GP4 (fallback/rework pin)

// SSD1306 128x64 OLED (I2C0)
constexpr uint8_t OLED_SDA_PIN    = 0;  // GP0
constexpr uint8_t OLED_SCL_PIN    = 1;  // GP1
constexpr uint8_t OLED_I2C_ADDR   = 0x3C;

// CD74HC4067 16-Channel Analog Multiplexer
constexpr uint8_t MUX_S0_PIN      = 14; // GP14
constexpr uint8_t MUX_S1_PIN      = 15; // GP15
constexpr uint8_t MUX_S2_PIN      = 16; // GP16
constexpr uint8_t MUX_S3_PIN      = 17; // GP17
constexpr uint8_t MUX_COM_PIN     = 26; // GP26 / ADC0

// Total Keys in 4x4 Grid
constexpr uint8_t NUM_KEYS        = 16;

/**
 * Key Index ordering (Row-major 0..15):
 * Row 0:  [0] Esc     [1] 7       [2] 8       [3] 9
 * Row 1:  [4] Macro1  [5] 4       [6] 5       [7] 6
 * Row 2:  [8] Macro2  [9] 1      [10] 2      [11] 3
 * Row 3: [12] Macro3 [13] Macro4 [14] 0      [15] Enter
 *
 * Channel mapping from KiCad PCB traces:
 */
constexpr uint8_t KEY_MUX_CHANNELS[NUM_KEYS] = {
    10, // Key  0: Esc    (U14 -> AMUX_10)
     9, // Key  1: 7      (U9  -> AMUX_9)
     6, // Key  2: 8      (U13 -> AMUX_6)
     4, // Key  3: 9      (U4  -> AMUX_4)
    11, // Key  4: Macro1 (U18 -> AMUX_11)
     8, // Key  5: 4      (U5  -> AMUX_8)
     7, // Key  6: 5      (U17 -> AMUX_7)
     5, // Key  7: 6      (U8  -> AMUX_5)
    12, // Key  8: Macro2 (U6  -> AMUX_12)
    14, // Key  9: 1      (U15 -> AMUX_14)
     0, // Key 10: 2      (U3  -> AMUX_0)
     2, // Key 11: 3      (U12 -> AMUX_2)
    13, // Key 12: Macro3 (U10 -> AMUX_13)
    15, // Key 13: Macro4 (U19 -> AMUX_15)
     1, // Key 14: 0      (U7  -> AMUX_1)
     3  // Key 15: Enter  (U16 -> AMUX_3)
};

#endif