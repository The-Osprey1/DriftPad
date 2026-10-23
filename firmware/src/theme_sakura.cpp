#include "theme_sakura.h"

#include <cmath>
#include <cstring>

namespace sakura {

namespace {

constexpr uint16_t WHITE = 1;
constexpr uint16_t BLACK = 0;
constexpr float TAU = 6.2831853f;

// 桜, 16x16, bit 15 = leftmost pixel: 木 on the left, the three short strokes above 女 on the right
const uint16_t kSakuraGlyph[16] = {
    0x1010, 0x1091, 0x1052, 0xFE54, 0x1000, 0x3820, 0x3424, 0x5244,
    0x5044, 0x91FF, 0x1028, 0x1010, 0x1028, 0x1044, 0x1082, 0x1101,
};


float span(uint32_t t, uint32_t a, uint32_t b) {
    if (t <= a) return 0.0f;
    if (t >= b) return 1.0f;
    return (float)(t - a) / (float)(b - a);
}

float easeOut(float p) {
    const float q = 1.0f - p;
    return 1.0f - q * q * q;
}

uint32_t xorshift(uint32_t& s) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

// ---- the branch ---------------------------------------------------------------------------------
// Segments in drawing order with the growth fraction at which each starts and ends, so the limb
// grows from its base outwards and each twig sprouts once the limb has passed it. Coordinates from
// the base at (0, 0), growing right; y down.
struct Segment {
    int8_t x0, y0, x1, y1;
    uint8_t width;      // 2 near the base, 1 for twigs
    uint8_t from, to;   // growth window, percent
};
const Segment kBranch[] = {
    {0, 6, 18, 2, 2, 0, 30},     // the limb
    {18, 2, 34, 4, 2, 25, 52},
    {34, 4, 50, -2, 1, 48, 74},
    {50, -2, 64, 0, 1, 70, 92},
    {18, 2, 24, -8, 1, 34, 56},  // twigs
    {34, 4, 42, 14, 1, 52, 76},
    {50, -2, 54, -11, 1, 74, 94},
    {64, 0, 72, 6, 1, 88, 100},
    {8, 4, 11, 10, 1, 18, 40},
};
struct Bud {
    int8_t x, y;
    uint8_t radius;
    uint8_t at;         // growth percent at which it may open
};
const Bud kBuds[BLOSSOMS] = {
    {24, -9, 2, 56}, {20, -4, 1, 50}, {42, 15, 2, 76}, {38, 10, 1, 70}, {54, -12, 2, 94},
    {58, -6, 1, 90}, {72, 7, 2, 100}, {66, -2, 1, 96}, {11, 11, 2, 40}, {46, 0, 1, 72}, {30, 0, 1, 52},
};

void thickLine(Adafruit_GFX& g, float x0, float y0, float x1, float y1, uint8_t width) {
    for (uint8_t i = 0; i < width; ++i) {
        g.drawLine((int16_t)lroundf(x0), (int16_t)lroundf(y0) + i, (int16_t)lroundf(x1), (int16_t)lroundf(y1) + i, WHITE);
    }
}

// A point of the branch (from its base, as drawn) on screen, seen from `v`
void place(const View& v, float px, float py, float* sx, float* sy) {
    const float c = cosf(v.angle), s = sinf(v.angle);
    const float x = px * v.scale, y = py * v.scale;
    const float xr = x * c - y * s;
    *sx = v.x + (v.mirrored ? -xr : xr);
    *sy = v.y + x * s + y * c;
}

// Petal sprites by tumble phase: a petal turns as it falls, so its outline changes
void drawPetalShape(Adafruit_GFX& g, int16_t x, int16_t y, uint8_t shape) {
    switch (shape & 3) {
        case 0: g.drawPixel(x + 1, y, WHITE); g.drawFastHLine(x, y + 1, 2, WHITE); break;   // .# / ##
        case 1: g.drawFastHLine(x, y, 2, WHITE); g.drawPixel(x, y + 1, WHITE); break;       // ## / #.
        case 2: g.drawFastHLine(x, y, 3, WHITE); break;                                      // ###
        default: g.drawFastVLine(x + 1, y, 2, WHITE); break;                                 // edge on
    }
}

} // namespace

// ---- small pieces -------------------------------------------------------------------------------

void drawSeal(Adafruit_GFX& g, int16_t x, int16_t y) {
    g.fillRect(x, y, SEAL_SIZE, SEAL_SIZE, WHITE);
    for (int16_t r = 0; r < 16; ++r) {
        for (int16_t c = 0; c < 16; ++c) {
            if (kSakuraGlyph[r] & (0x8000u >> c)) g.drawPixel(x + 2 + c, y + 2 + r, BLACK);
        }
    }
    // A hand stamp is never perfectly even: two worn corners
    g.drawPixel(x, y, BLACK);
    g.drawPixel(x + SEAL_SIZE - 1, y + SEAL_SIZE - 1, BLACK);
}

void drawBlossom(Adafruit_GFX& g, int16_t cx, int16_t cy, float open, uint8_t radius) {
    if (open <= 0.0f) return;
    if (open < 0.35f || radius < 1) {   // a bud
        g.drawPixel(cx, cy, WHITE);
        return;
    }
    const float r = radius * (0.5f + 0.5f * (open > 1.0f ? 1.0f : open));
    const int16_t petal = radius >= 4 ? 2 : 1;   // seen close up, the petals are larger
    for (uint8_t i = 0; i < 5; ++i) {
        const float a = -TAU / 4 + i * TAU / 5;
        const int16_t px = cx + (int16_t)lroundf(cosf(a) * r);
        const int16_t py = cy + (int16_t)lroundf(sinf(a) * r);
        if (radius >= 2) g.fillCircle(px, py, petal, WHITE);
        else g.drawPixel(px, py, WHITE);
    }
    if (radius >= 2) g.drawPixel(cx, cy, BLACK);   // the dark heart
    else g.drawPixel(cx, cy, WHITE);
}

// ---- petals -------------------------------------------------------------------------------------

void Petals::clear() {
    for (Petal& p : m_p) p.live = false;
}

float Petals::frand() {
    return (xorshift(m_rng) & 0xFFFF) / 65535.0f;
}

Petals::Petal* Petals::slot() {
    for (Petal& p : m_p) {
        if (!p.live) return &p;
    }
    // Full: reuse the oldest
    Petal* oldest = &m_p[0];
    for (Petal& p : m_p) {
        if (p.ageMs > oldest->ageMs) oldest = &p;
    }
    return oldest;
}

void Petals::burst(float x, float y, uint8_t count) {
    for (uint8_t i = 0; i < count; ++i) {
        Petal* p = slot();
        const float a = -TAU / 4 + (frand() - 0.5f) * 2.2f;   // mostly upwards
        const float speed = 34.0f + frand() * 26.0f;           // px/s
        *p = {x, y, cosf(a) * speed, sinf(a) * speed, frand() * 4.0f, 0, (uint16_t)(700 + frand() * 500), true};
    }
}

void Petals::drop(float x, float y) {
    Petal* p = slot();
    *p = {x, y, (frand() - 0.5f) * 4.0f, 4.0f + frand() * 4.0f, frand() * 4.0f, 0, 0, true};
}

void Petals::step(uint32_t dtMs, float wind) {
    if (dtMs > 200) dtMs = 200;   // after a stall, never one huge jump
    const float dt = dtMs / 1000.0f;
    for (Petal& p : m_p) {
        if (!p.live) continue;
        p.ageMs = (uint16_t)((uint32_t)p.ageMs + dtMs > 60000 ? 60000 : p.ageMs + dtMs);
        // Air drag pulls the speed towards a slow fall carried by the wind; each petal sways
        const float targetVx = wind + sinf(p.phase * 1.7f) * 4.0f;
        const float targetVy = 9.0f;
        const float k = dt * 2.5f > 1.0f ? 1.0f : dt * 2.5f;
        p.vx += (targetVx - p.vx) * k;
        p.vy += (targetVy - p.vy) * k;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.phase += dt * (2.0f + (p.vx > 0 ? p.vx : -p.vx) * 0.08f);
        if (p.lifeMs && p.ageMs >= p.lifeMs) p.live = false;
        if (p.y > m_bottom || p.x < m_left || p.x > m_right) p.live = false;
    }
}

void Petals::draw(Adafruit_GFX& g) const {
    for (const Petal& p : m_p) {
        if (!p.live) continue;
        // A short-lived petal blinks out over its last 150 ms instead of vanishing at once
        if (p.lifeMs && p.ageMs + 150 > p.lifeMs && ((p.ageMs / 50) & 1)) continue;
        drawPetalShape(g, (int16_t)lroundf(p.x), (int16_t)lroundf(p.y), (uint8_t)p.phase);
    }
}

void Petals::draw(Adafruit_GFX& g, const Camera& cam, float depth) const {
    for (const Petal& p : m_p) {
        if (!p.live) continue;
        float x, y;
        cam.project(p.x, p.y, depth, &x, &y);
        drawPetalShape(g, (int16_t)lroundf(x), (int16_t)lroundf(y), (uint8_t)p.phase);
    }
}

void Camera::project(float x, float y, float depth, float* sx, float* sy) const {
    const float z = zoomAt(depth);
    *sx = focusX + (x - focusX) * z;
    *sy = focusY + (y - focusY) * z;
}

uint8_t Petals::live() const {
    uint8_t n = 0;
    for (const Petal& p : m_p) n += p.live ? 1 : 0;
    return n;
}

// ---- the branch ---------------------------------------------------------------------------------

void blossomAt(uint8_t i, const View& v, int16_t* x, int16_t* y) {
    const Bud& b = kBuds[i % BLOSSOMS];
    float sx, sy;
    place(v, b.x, b.y, &sx, &sy);
    *x = (int16_t)lroundf(sx);
    *y = (int16_t)lroundf(sy);
}

void blossomAt(uint8_t i, int16_t ox, int16_t oy, bool mirrored, int16_t* x, int16_t* y) {
    blossomAt(i, View{(float)ox, (float)oy, 1.0f, 0.0f, mirrored}, x, y);
}

void drawBranch(Adafruit_GFX& g, const View& v, float grow, float bloom, float sway) {
    const float growPct = grow * 100.0f;
    for (const Segment& s : kBranch) {
        if (growPct <= s.from) continue;
        float p = (growPct - s.from) / (float)(s.to - s.from);
        if (p > 1.0f) p = 1.0f;
        const float x1 = s.x0 + (s.x1 - s.x0) * p;
        const float y1 = s.y0 + (s.y1 - s.y0) * p;
        // Only the thin outer twigs sway
        const float tip = s.width == 1 ? sway * p : 0.0f;
        float ax, ay, bx, by;
        place(v, s.x0, s.y0, &ax, &ay);
        place(v, x1 + tip, y1, &bx, &by);
        const long w = lroundf(s.width * v.scale);
        thickLine(g, ax, ay, bx, by, (uint8_t)(w < 1 ? 1 : w > 4 ? 4 : w));
    }
    for (uint8_t i = 0; i < BLOSSOMS; ++i) {
        const Bud& b = kBuds[i];
        if (growPct < b.at) continue;
        // Blossoms open one after another as `bloom` rises
        const float open = bloom * (BLOSSOMS + 2) - i;
        float x, y;
        place(v, b.x + sway * (b.radius == 1 ? 1.0f : 0.5f), b.y, &x, &y);
        const long r = lroundf(b.radius * v.scale);
        drawBlossom(g, (int16_t)lroundf(x), (int16_t)lroundf(y), open, (uint8_t)(r < 1 ? 1 : r > 4 ? 4 : r));
    }
}

void drawBranch(Adafruit_GFX& g, int16_t ox, int16_t oy, bool mirrored, float grow, float bloom, float sway) {
    drawBranch(g, View{(float)ox, (float)oy, 1.0f, 0.0f, mirrored}, grow, bloom, sway);
}

void drawSprig(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, uint32_t nowMs) {
    const float t = nowMs / 1000.0f;
    int16_t px = x, py = y;
    for (int16_t i = 1; i < w; ++i) {
        const int16_t cy = y + (int16_t)lroundf(sinf(i * 0.11f) * 1.2f);
        g.drawLine(px, py, x + i, cy, WHITE);
        px = x + i;
        py = cy;
    }
    // Three blossoms and a bud, breathing a little in turn
    static const float kAt[] = {0.18f, 0.5f, 0.82f};
    for (uint8_t i = 0; i < 3; ++i) {
        const int16_t bx = x + (int16_t)(w * kAt[i]);
        const int16_t by = y + (int16_t)lroundf(sinf(bx * 0.11f) * 1.2f) - 3;
        const float breathe = 0.85f + 0.15f * sinf(t * 1.3f + i * 2.1f);
        drawBlossom(g, bx, by, breathe, 2);
        g.drawPixel(bx, by + 2, WHITE);   // its stem
    }
    g.drawPixel(x + w - 2, y - 2, WHITE);
}

void drawCardFrame(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, int16_t h, bool pressed) {
    if (pressed) {
        g.fillRect(x, y, w, h, WHITE);
        g.drawRect(x + 2, y + 2, w - 4, h - 4, BLACK);
        g.drawPixel(x, y, BLACK);                  // worn corners, like the seal
        g.drawPixel(x + w - 1, y + h - 1, BLACK);
        return;
    }
    g.drawRect(x, y, w, h, WHITE);
    // The inner border stops short of the corners
    g.drawFastHLine(x + 4, y + 2, w - 8, WHITE);
    g.drawFastHLine(x + 4, y + h - 3, w - 8, WHITE);
    g.drawFastVLine(x + 2, y + 4, h - 8, WHITE);
    g.drawFastVLine(x + w - 3, y + 4, h - 8, WHITE);
}

void drawShoji(Adafruit_GFX& g, uint32_t elapsed, uint32_t total, uint8_t layer, const char* name) {
    if (elapsed >= total) return;
    const uint32_t slide = total / 4;
    float closed;
    if (elapsed < slide) closed = easeOut((float)elapsed / slide);
    else if (elapsed > total - slide) closed = easeOut((float)(total - elapsed) / slide);
    else closed = 1.0f;
    const int16_t edge = (int16_t)lroundf(64.0f * closed);   // each door's leading edge from its side
    if (edge <= 0) return;

    // Left door spans [0, edge), right door [128 - edge, 128); each keeps its lattice fixed to it
    for (uint8_t side = 0; side < 2; ++side) {
        const int16_t x0 = side == 0 ? edge - 64 : 128 - edge;   // where the 64-px door starts
        const int16_t vis0 = side == 0 ? 0 : 128 - edge;
        const int16_t vis1 = side == 0 ? edge : 128;
        g.fillRect(vis0, 0, vis1 - vis0, 64, BLACK);
        auto vline = [&](int16_t dx) {
            const int16_t xx = x0 + dx;
            if (xx >= vis0 && xx < vis1) g.drawFastVLine(xx, 0, 64, WHITE);
        };
        vline(0);
        vline(63);
        for (int16_t dx = 16; dx < 64; dx += 16) vline(dx);
        for (int16_t yy : {0, 15, 31, 47, 63}) g.drawFastHLine(vis0, yy, vis1 - vis0, WHITE);
    }
    if (closed < 1.0f) return;

    // Doors shut: the layer on a paper strip across the seam
    char tag[12];
    snprintf(tag, sizeof(tag), "LAYER %u", (unsigned)layer + 1);
    const int16_t nameW = (int16_t)strlen(name) * 12 - 2;
    const int16_t w = (nameW > 56 ? nameW : 56) + 16;
    const int16_t x = 64 - w / 2;
    g.fillRect(x, 18, w, 29, BLACK);
    g.drawRect(x, 18, w, 29, WHITE);
    g.setTextWrap(false);
    g.setTextColor(WHITE);
    g.setTextSize(1);
    g.setCursor(64 - ((int16_t)strlen(tag) * 6 - 1) / 2, 21);
    g.print(tag);
    g.setTextSize(2);
    g.setCursor(64 - nameW / 2, 31);
    g.print(name);
    g.setTextSize(1);
}

// ---- the title ----------------------------------------------------------------------------------

void drawIntro(Adafruit_GFX& g, uint32_t t, const char* status) {
    // The branch grows from the left edge, its blossoms open, and petals start to let go
    constexpr int16_t BX = -2, BY = 24;
    const float grow = easeOut(span(t, 0, 1800));
    const float bloom = span(t, 1100, 2700);
    const float sway = t > 2700 ? sinf((t - 2700) / 900.0f) * 1.0f : 0.0f;
    drawBranch(g, BX, BY, false, grow, bloom, sway);

    // A few petals, on fixed paths so the title is the same every time
    if (t > 2300) {
        for (uint8_t i = 0; i < 5; ++i) {
            const uint32_t start = 2300 + i * 520;
            if (t < start) continue;
            const float s = (t - start) / 1000.0f;
            int16_t bx, by;
            blossomAt((uint8_t)(i * 2 + 1) % BLOSSOMS, BX, BY, false, &bx, &by);
            const float x = bx + s * 9.0f + sinf(s * 3.0f + i) * 3.0f;
            const float y = by + s * 11.0f;
            if (y < 64) drawPetalShape(g, (int16_t)x, (int16_t)y, (uint8_t)(s * 3.0f + i));
        }
    }

    // The seal stamps in: a larger outline closes onto the seal's place, then the seal is there
    constexpr int16_t SX = 101, SY = 5;
    if (t >= 2500) {
        const float p = span(t, 2500, 2800);
        if (p < 1.0f) {
            const int16_t grow2 = (int16_t)lroundf((1.0f - p) * 6.0f);
            g.drawRect(SX - grow2, SY - grow2, SEAL_SIZE + 2 * grow2, SEAL_SIZE + 2 * grow2, WHITE);
        } else {
            drawSeal(g, SX, SY);
        }
    }

    // The name in tracked capitals under the seal, one letter at a time, with a brush stroke
    if (t >= 2800) {
        static const char kName[] = "DRIFTPAD";
        const uint8_t shown = (uint8_t)((t - 2800) / 70 > 8 ? 8 : (t - 2800) / 70);
        g.setTextWrap(false);
        g.setTextColor(WHITE);
        g.setTextSize(1);
        for (uint8_t i = 0; i < shown; ++i) {
            g.setCursor(72 + i * 7, 35);
            g.print(kName[i]);
        }
        const int16_t stroke = (int16_t)lroundf(span(t, 3300, 3800) * 55.0f);
        if (stroke > 0) {
            g.drawFastHLine(72, 45, stroke, WHITE);
            if (stroke > 6) g.drawFastHLine(74, 46, stroke - 6, WHITE);   // the brush thins out
        }
    }

    // The pad's status, typed in, with a blinking cursor once it is complete
    if (t >= 3800 && status) {
        const int16_t len = (int16_t)strlen(status);
        int16_t typed = (int16_t)((t - 3800) / 45);
        if (typed > len) typed = len;
        const int16_t sx = 64 - len * 6 / 2;
        g.setTextSize(1);
        for (int16_t i = 0; i < typed; ++i) {
            g.setCursor(sx + i * 6, 55);
            g.print(status[i]);
        }
        if (typed < len || ((t / 400) & 1)) g.fillRect(sx + typed * 6, 55, 5, 7, WHITE);
    }
}

// ---- the screensaver ----------------------------------------------------------------------------

float Scene::frand() {
    return (xorshift(m_rng) & 0xFFFF) / 65535.0f;
}

namespace {

float smooth(float p) { return p * p * (3.0f - 2.0f * p); }

// A drifting shape's x in the scene: comes in from the right, leaves on the left, comes round again.
// The span is wide enough that a moving camera never sees it wrap.
float drift(uint32_t tMs, float speedPxPerS, float offset) {
    constexpr float LEFT = -80.0f, SPAN = 300.0f;
    float x = fmodf(offset - tMs / 1000.0f * speedPxPerS, SPAN);
    if (x < 0) x += SPAN;
    return LEFT + x;
}

// A wisp of cloud: three thin strokes, stepped like a brush drawn sideways, scaled by `z`. The dark
// around each stroke hides whatever is behind it, so the moon disappears behind the wisp.
void drawWisp(Adafruit_GFX& g, float x, float y, float z) {
    static const int8_t kStroke[3][2] = {{0, 26}, {6, 16}, {2, 9}};   // x offset, length
    for (uint8_t pass = 0; pass < 2; ++pass) {
        for (uint8_t i = 0; i < 3; ++i) {
            const int16_t sx = (int16_t)lroundf(x + kStroke[i][0] * z), sy = (int16_t)lroundf(y + i * 2 * z);
            const int16_t len = (int16_t)lroundf(kStroke[i][1] * z);
            if (pass == 0) g.fillRect(sx - 1, sy - 1, len + 2, 3, BLACK);
            else g.drawFastHLine(sx, sy, len, WHITE);
        }
    }
}

} // namespace

Camera Scene::camera() const {
    // Far, push in, close, pull back, then again
    const uint32_t phase = m_t % CYCLE_MS;
    float zoom;
    if (phase < HOLD_MS) {
        zoom = ZOOM_FAR;
    } else if (phase < HOLD_MS + ZOOM_MS) {
        zoom = ZOOM_FAR + (ZOOM_CLOSE - ZOOM_FAR) * smooth((float)(phase - HOLD_MS) / ZOOM_MS);
    } else if (phase < 2 * HOLD_MS + ZOOM_MS) {
        zoom = ZOOM_CLOSE;
    } else {
        zoom = ZOOM_CLOSE + (ZOOM_FAR - ZOOM_CLOSE) * smooth((float)(phase - 2 * HOLD_MS - ZOOM_MS) / ZOOM_MS);
    }
    return Camera{zoom, FOCUS_X, FOCUS_Y};
}

View Scene::branchView() const {
    // The branch is rigid, so the camera's view of it is again a placement: where its base lands,
    // scaled by the zoom
    const Camera c = camera();
    float x, y;
    c.project(BRANCH_X, BRANCH_Y, DEPTH_BRANCH, &x, &y);
    return View{x, y, c.zoomAt(DEPTH_BRANCH), 0.0f, true};
}

void Scene::reset(uint32_t seed) {
    m_rng = seed ? seed : 1;
    m_petals.clear();
    m_petals.seed(seed ^ 0x9e3779b9u);
    m_petals.setBounds(-60.0f, 200.0f, 120.0f);   // the scene is wider than the screen
    m_t = 0;
    m_dropAcc = 0;
    m_wind = -2.0f;
    for (SkyStar& s : m_stars) {
        s.x = (uint8_t)(frand() * 127.0f);
        s.y = (uint8_t)(2.0f + frand() * 30.0f);
        s.period20 = (uint8_t)(80 + frand() * 120);           // 1.6 .. 4 s
        s.phase20 = (uint8_t)(frand() * s.period20);
        if (frand() < 0.25f) s.y |= 0x80;                       // a bright one
    }
    m_nextGust = 4000 + (uint32_t)(frand() * 4000);
    m_gustEnd = 0;
    // Start with petals already in the air, as if the scene had been going for a while
    for (uint8_t i = 0; i < 10; ++i) {
        m_petals.drop(20.0f + frand() * 120.0f, frand() * 60.0f);
    }
}

void Scene::advance(uint32_t dtMs) {
    m_t += dtMs;
    // Wind: a light breeze to the left, with a gust now and then
    if (m_t >= m_nextGust && m_gustEnd == 0) {
        m_gustEnd = m_t + 1200 + (uint32_t)(frand() * 1200);
    }
    float target = -2.0f;
    if (m_gustEnd) {
        target = -14.0f;
        if (m_t >= m_gustEnd) {
            m_gustEnd = 0;
            m_nextGust = m_t + 5000 + (uint32_t)(frand() * 6000);
        }
    }
    const float k = dtMs / 600.0f > 1.0f ? 1.0f : dtMs / 600.0f;
    m_wind += (target - m_wind) * k;

    // Petals let go of the blossoms, more of them in a gust; others drift in from above. They live in
    // the scene, so the camera sees them move with the branch.
    m_dropAcc += dtMs;
    const uint32_t every = m_gustEnd ? 140 : 420;
    const View atRest{BRANCH_X, BRANCH_Y, 1.0f, 0.0f, true};
    while (m_dropAcc >= every) {
        m_dropAcc -= every;
        if (frand() < 0.6f) {
            int16_t x, y;
            blossomAt((uint8_t)(frand() * BLOSSOMS), atRest, &x, &y);
            m_petals.drop(x, y);
        } else {
            m_petals.drop(20.0f + frand() * 130.0f, -24.0f);
        }
    }
    m_petals.step(dtMs, m_wind);
}

void Scene::render(Adafruit_GFX& g) const {
    const Camera cam = camera();
    float x, y;

    // Stars, the farthest layer: they barely move
    for (const SkyStar& s : m_stars) {
        const uint32_t period = s.period20 * 20u;
        const uint32_t p = (m_t + s.phase20 * 20u) % period;
        if (p >= period * 3 / 4) continue;   // each dims out for a quarter of its period
        cam.project(s.x, s.y & 0x7F, DEPTH_STARS, &x, &y);
        const int16_t sx = (int16_t)lroundf(x), sy = (int16_t)lroundf(y);
        g.drawPixel(sx, sy, WHITE);
        if ((s.y & 0x80) && p < period / 3) {   // the bright ones flare into a small cross
            g.drawPixel(sx - 1, sy, WHITE); g.drawPixel(sx + 1, sy, WHITE);
            g.drawPixel(sx, sy - 1, WHITE); g.drawPixel(sx, sy + 1, WHITE);
        }
    }

    // The crescent moon: the outer disc minus a second one pushed up and to the right; its dark side
    // is only hinted at by a dotted edge
    cam.project(MOON_X, MOON_Y, DEPTH_MOON, &x, &y);
    const int16_t mx = (int16_t)lroundf(x), my = (int16_t)lroundf(y);
    const int16_t r = (int16_t)lroundf(11.0f * cam.zoomAt(DEPTH_MOON)), cut = r - 1;
    const int16_t cx = mx + r / 2 + 1, cy = my - r / 4;
    for (int16_t yy = -r; yy <= r; ++yy) {
        for (int16_t xx = -r; xx <= r; ++xx) {
            if (xx * xx + yy * yy > r * r) continue;
            const int16_t ix = mx + xx - cx, iy = my + yy - cy;
            if (ix * ix + iy * iy <= cut * cut) continue;
            g.drawPixel(mx + xx, my + yy, WHITE);
        }
    }
    for (uint8_t i = 0; i < 48; i += 3) {
        const float a = i * TAU / 48;
        const int16_t ex = mx + (int16_t)lroundf(cosf(a) * r), ey = my + (int16_t)lroundf(sinf(a) * r);
        const int16_t ix = ex - cx, iy = ey - cy;
        if (ix * ix + iy * iy <= cut * cut) g.drawPixel(ex, ey, WHITE);
    }

    // Wisps of cloud, nearer than the moon: they drift across it
    const float cz = cam.zoomAt(DEPTH_CLOUDS);
    cam.project(drift(m_t, 2.0f, 110.0f), MOON_Y + 4, DEPTH_CLOUDS, &x, &y);
    drawWisp(g, x, y, cz);
    cam.project(drift(m_t, 3.2f, 260.0f), 40.0f, DEPTH_CLOUDS, &x, &y);
    drawWisp(g, x, y, cz);

    // A faint horizon of distant hills, nearer still
    for (int16_t hx = -60; hx < 190; hx += 2) {
        const float hy = 58.0f + sinf(hx * 0.05f) * 2.0f + sinf(hx * 0.13f + 1.0f);
        cam.project(hx, hy, DEPTH_HILLS, &x, &y);
        g.drawPixel((int16_t)lroundf(x), (int16_t)lroundf(y), WHITE);
    }

    // The branch and its petals, nearest: they move fully with the camera
    const float sway = sinf(m_t / 700.0f) * 0.8f + m_wind * 0.08f;
    drawBranch(g, branchView(), 1.0f, 1.0f, sway);
    m_petals.draw(g, cam, DEPTH_BRANCH);
}

} // namespace sakura
