#ifndef THEME_SPACE_H
#define THEME_SPACE_H

#include <cstdint>
#include <Adafruit_GFX.h>

/**
 * @file theme_space.h
 * @brief The Space theme's artwork, drawn through Adafruit_GFX.
 *
 * oled.cpp decides when each piece is shown (theme 2); this module only draws. Everything is white
 * on black on the 128x64 panel and is worked out from the elapsed milliseconds (and a seed) each
 * frame, never stored: the stars, the orbits and the meteors cost no memory between frames.
 * Core 1 only.
 */
namespace space {

constexpr int16_t BADGE_SIZE = 20;   // the ringed planet beside the theme's name in the knob menu

// A ringed planet in a 20 x 20 square, top-left at (x, y)
void drawBadge(Adafruit_GFX& g, int16_t x, int16_t y);

// The key card as a viewfinder: corner brackets joined by dotted edges; pressed, a solid panel with
// cut corners and dark brackets inside it
void drawCardFrame(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, int16_t h, bool pressed);

// A key press: a target lock. Corner brackets close in on the keypad map cell at (x, y), `cell` px
// square, and blink out. step counts up from 0 to LOCK_STEPS - 1, one per frame.
constexpr uint8_t LOCK_STEPS = 8;
void drawLockOn(Adafruit_GFX& g, int16_t x, int16_t y, int16_t cell, uint8_t step);

// Standby: a small planet with a moon in orbit and a few stars, across the bottom of the left panel,
// from x to x + w around row y; now and then a meteor crosses
void drawOrbit(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, uint32_t nowMs);

// A layer change: a dark window opens from the centre with stars rushing past, shows the layer, then
// closes again. elapsed and total in ms; layer is 0-based.
void drawWarp(Adafruit_GFX& g, uint32_t elapsed, uint32_t total, uint8_t layer, const char* name);

// The power-up title at t ms (the same length as the Drift title): a jump to light speed slows to a
// still field of stars, a ringed planet rises, the name appears, then the pad's status line types
// in. status: the state line.
void drawIntro(Adafruit_GFX& g, uint32_t t, const char* status);

// The Orbit screensaver: a large ringed planet, lit from the upper left, turns slowly (its cloud
// bands and a storm drift across it) while a moon circles it, passing behind and in front. The stars
// stay still, so the eye always has a fixed point; now and then a meteor streaks past.
class Scene {
public:
    static constexpr float PLANET_X = 78.0f, PLANET_Y = 36.0f, PLANET_R = 17.0f;
    static constexpr float RING_TILT = -0.18f;          // radians; the ring's right end is higher
    static constexpr uint32_t DAY_MS = 30000;            // one turn of the planet
    static constexpr uint32_t MOON_ORBIT_MS = 24000;     // one lap of the moon
    static constexpr uint32_t METEOR_SLOT_MS = 6000;     // at most one meteor in each slot
    static constexpr uint32_t METEOR_MS = 700;

    void reset(uint32_t seed) { m_seed = seed ? seed : 1; m_t = 0; }
    void advance(uint32_t dtMs) { m_t += dtMs; }
    void render(Adafruit_GFX& g) const;

    // The moon's centre on screen and whether it is in front of the planet (for tests)
    void moonAt(float* x, float* y, bool* inFront) const;
    // The storm's place on the planet: its screen x, or a value below -1000 when on the far side
    float stormX() const;
    uint32_t time() const { return m_t; }

private:
    uint32_t m_t = 0;
    uint32_t m_seed = 1;
};

} // namespace space

#endif // THEME_SPACE_H
