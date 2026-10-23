#ifndef ENCODER_MENU_H
#define ENCODER_MENU_H

#include <cstdint>
#include "oled.h"

/**
 * @file encoder_menu.h
 * @brief What one encoder detent does to the settings in each tuning-menu page.
 *
 * Changes go through the config mutators with the limits and encoder steps of
 * settings_limits.h, exactly like the serial protocol, and are applied immediately (saving is
 * scheduled by main.cpp). oled.cpp owns the menu page and the display; this file holds no state.
 */

// Returns true if a setting changed (false for a page with no setting or a zero delta)
bool encoderMenuApply(MenuMode page, int32_t delta);

#endif // ENCODER_MENU_H
