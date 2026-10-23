#ifndef THEME_SAKURA_H
#define THEME_SAKURA_H

#include <cstdint>
#include <Adafruit_GFX.h>

/**
 * @file theme_sakura.h
 * @brief The Cherry blossom theme's artwork, drawn through Adafruit_GFX.
 *
 * oled.cpp decides when each piece is shown (theme 1); this module only draws. Everything is white
 * on black on the 128x64 panel, and every animation is driven by elapsed milliseconds, never by the
 * frame count, so the frame rate cannot change its speed. Core 1 only.
 *
 * The 桜 ("cherry blossom") in the seal is an original 16x16 drawing, not taken from a font.
 */
namespace sakura {

constexpr int16_t SEAL_SIZE = 20;   // the seal is a filled square with the character knocked out

// The seal (hanko): a filled square with 桜 cut out of it, top-left at (x, y)
void drawSeal(Adafruit_GFX& g, int16_t x, int16_t y);

// A blossom of five petals around a dark heart. open: 0 (bud) .. 1 (full); radius 1..3
void drawBlossom(Adafruit_GFX& g, int16_t cx, int16_t cy, float open, uint8_t radius);

// Falling petals. A petal tumbles (its shape cycles) while the wind and its own sway carry it.
class Petals {
public:
    static constexpr uint8_t MAX = 28;
    void clear();
    void seed(uint32_t s) { m_rng = s ? s : 1; }
    // A handful of petals thrown up and out from (x, y), as from a pressed key; they live briefly
    void burst(float x, float y, uint8_t count);
    // One petal letting go of a branch at (x, y)
    void drop(float x, float y);
    void step(uint32_t dtMs, float wind);
    void draw(Adafruit_GFX& g) const;
    uint8_t live() const;

private:
    struct Petal {
        float x, y, vx, vy, phase;
        uint16_t ageMs, lifeMs;   // lifeMs 0 = until it leaves the screen
        bool live;
    };
    Petal* slot();
    float frand();   // 0 .. 1
    Petal m_p[MAX] = {};
    uint32_t m_rng = 1;
};

// The branch: a hand-drawn limb with twigs and eleven blossoms. Grown to `grow` (0..1) from its base,
// blossoms opened to `bloom` (0..1, each opening in turn), tips swaying by `sway` px. Drawn from
// (ox, oy); mirrored grows leftwards from a base on the right.
void drawBranch(Adafruit_GFX& g, int16_t ox, int16_t oy, bool mirrored, float grow, float bloom, float sway);
// Where blossom `i` (0..BLOSSOMS-1) of a branch drawn at (ox, oy) sits, for petals to fall from
constexpr uint8_t BLOSSOMS = 11;
void blossomAt(uint8_t i, int16_t ox, int16_t oy, bool mirrored, int16_t* x, int16_t* y);

// Standby: a sprig across the bottom of the left panel, from x to x + w around row y
void drawSprig(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, uint32_t nowMs);

// The key card as a seal: a double border; pressed, a solid stamp with a dark inner border
void drawCardFrame(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, int16_t h, bool pressed);

// A layer change: paper doors (shoji) slide shut, show the layer on a paper strip, slide open again.
// elapsed and total in ms; layer is 0-based.
void drawShoji(Adafruit_GFX& g, uint32_t elapsed, uint32_t total, uint8_t layer, const char* name);

// The power-up title at t ms (the same length as the Drift title): a branch grows and blossoms, the
// seal stamps in, the name appears, then the pad's status line types in. status: the state line.
void drawIntro(Adafruit_GFX& g, uint32_t t, const char* status);

// The Sakura screensaver: a moon, a branch reaching in from the right, petals on gusts of wind
class Scene {
public:
    void reset(uint32_t seed);
    void advance(uint32_t dtMs);
    void render(Adafruit_GFX& g) const;
    const Petals& petals() const { return m_petals; }

private:
    float frand();
    Petals m_petals;
    uint32_t m_t = 0;
    uint32_t m_rng = 1;
    uint32_t m_dropAcc = 0;
    uint32_t m_nextGust = 0;
    uint32_t m_gustEnd = 0;
    float m_wind = 0.0f;
};

} // namespace sakura

#endif // THEME_SAKURA_H
