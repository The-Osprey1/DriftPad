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

// How the screensaver's camera sees its scene. Everything is placed in scene pixels (the 128 x 64
// screen at rest, y down), each layer at a depth from 0 (infinitely far: never moves) to 1 (the
// branch and its petals: moves fully). The camera's pan, zoom and tilt apply to a layer in proportion
// to its depth, so when the camera moves, near things slide past far ones: that is the parallax.
struct Camera {
    float panX, panY;   // how far the camera has moved, in scene pixels (positive: right, down)
    float zoom;         // 1 = at rest; larger is closer
    float tilt;         // radians; positive turns the view clockwise
    float zoomAt(float depth) const { return 1.0f + (zoom - 1.0f) * depth; }
    void project(float x, float y, float depth, float* sx, float* sy) const;
};

// Falling petals. A petal tumbles (its shape cycles) while the wind and its own sway carry it.
class Petals {
public:
    static constexpr uint8_t MAX = 24;   // when full, a new petal takes the oldest one's place
    void clear();
    void seed(uint32_t s) { m_rng = s ? s : 1; }
    // A handful of petals thrown up and out from (x, y), as from a pressed key; they live briefly
    void burst(float x, float y, uint8_t count);
    // One petal letting go of a branch at (x, y)
    void drop(float x, float y);
    void step(uint32_t dtMs, float wind);
    // Petals beyond these leave (screen pixels by default; a scene with a moving camera widens them)
    void setBounds(float left, float right, float bottom) { m_left = left; m_right = right; m_bottom = bottom; }
    void draw(Adafruit_GFX& g) const;
    // Petals placed in a scene, as `cam` sees them at `depth`
    void draw(Adafruit_GFX& g, const Camera& cam, float depth) const;
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
    float m_left = -4.0f, m_right = 131.0f, m_bottom = 66.0f;
};

// A viewpoint on the branch: where its base is on screen, how close it is and how it is turned
struct View {
    float x, y;       // the base, in screen pixels (it may be off screen)
    float scale;      // 1 = as drawn; larger is closer
    float angle;      // radians; positive turns the tips downwards
    bool mirrored;    // grows leftwards from a base on the right
};

// The branch: a hand-drawn limb with twigs and eleven blossoms. Grown to `grow` (0..1) from its base,
// blossoms opened to `bloom` (0..1, each opening in turn), tips swaying by `sway` px, seen from `v`.
void drawBranch(Adafruit_GFX& g, const View& v, float grow, float bloom, float sway);
// The same at its drawn size and angle, from a base at (ox, oy)
void drawBranch(Adafruit_GFX& g, int16_t ox, int16_t oy, bool mirrored, float grow, float bloom, float sway);
// Where blossom `i` (0..BLOSSOMS-1) of the branch sits on screen, for petals to fall from
constexpr uint8_t BLOSSOMS = 11;
void blossomAt(uint8_t i, const View& v, int16_t* x, int16_t* y);
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

// The Sakura screensaver: a crescent moon with wisps of cloud and a few stars, distant hills, and a
// branch reaching in from the right with petals on gusts of wind. The camera glides between four
// views (at rest, close on the blossoms, pulled back and lower, tilted), pausing VIEW_HOLD_MS at
// each and easing to the next over VIEW_MOVE_MS, and it floats a little all the time, so the layers
// keep sliding past one another.
class Scene {
public:
    static constexpr uint8_t VIEWS = 4;
    static constexpr uint32_t VIEW_HOLD_MS = 2500;
    static constexpr uint32_t VIEW_MOVE_MS = 6500;
    // Where things are in the scene, and how far away
    static constexpr float BRANCH_X = 142.0f, BRANCH_Y = 10.0f;   // the base, off the right edge
    static constexpr float MOON_X = 28.0f, MOON_Y = 26.0f;
    // The moon and stars are infinitely far, as in life: they never move, so they show the eye what
    // the camera is doing to everything nearer
    static constexpr float DEPTH_STARS = 0.0f, DEPTH_MOON = 0.0f, DEPTH_CLOUDS = 0.3f;
    static constexpr float DEPTH_HILLS = 0.4f, DEPTH_BRANCH = 1.0f;

    void reset(uint32_t seed);
    void advance(uint32_t dtMs);
    void render(Adafruit_GFX& g) const;
    Camera camera() const;       // the camera now
    View branchView() const;     // the branch as the camera sees it
    const Petals& petals() const { return m_petals; }

private:
    float frand();
    Petals m_petals;             // in scene pixels, at the branch's depth
    uint32_t m_t = 0;
    uint32_t m_viewStart = 0;    // where in the cycle of views this session began
    uint32_t m_rng = 1;
    uint32_t m_dropAcc = 0;
    uint32_t m_nextGust = 0;
    uint32_t m_gustEnd = 0;
    float m_wind = 0.0f;
    struct SkyStar { uint8_t x, y, period20, phase20; };   // twinkle period and phase in 20 ms units; bright in bit 7 of y
    static constexpr uint8_t STARS = 8;
    SkyStar m_stars[STARS] = {};
};

} // namespace sakura

#endif // THEME_SAKURA_H
