#include "theme_space.h"

#include <cmath>
#include <cstdio>
#include <cstring>

namespace space {

namespace {

constexpr uint16_t WHITE = 1;
constexpr uint16_t BLACK = 0;
constexpr float TAU = 6.2831853f;

const uint8_t kBayer4[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

// Light from the upper left and a little in front (a unit vector)
constexpr float LIGHT_X = -0.55f, LIGHT_Y = -0.55f, LIGHT_Z = 0.63f;

float span(uint32_t t, uint32_t a, uint32_t b) {
    if (t <= a) return 0.0f;
    if (t >= b) return 1.0f;
    return (float)(t - a) / (float)(b - a);
}

float easeOut(float p) {
    const float q = 1.0f - p;
    return 1.0f - q * q * q;
}

// A well-mixed 32-bit hash: the stars and meteors are worked out from it every frame
uint32_t hash32(uint32_t x) {
    x ^= x >> 16;
    x *= 0x7feb352dU;
    x ^= x >> 15;
    x *= 0x846ca68bU;
    x ^= x >> 16;
    return x;
}

bool insideDisc(float x, float y, float cx, float cy, float r) {
    const float dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy < r * r;
}

// A point of an ellipse (radii rx, ry) at angle `a`, turned by `tilt`, around (cx, cy). sin(a) > 0
// is its near half, below the centre before the tilt.
void ellipsePoint(float cx, float cy, float rx, float ry, float tilt, float a, float* x, float* y) {
    const float ex = rx * cosf(a), ey = ry * sinf(a);
    const float c = cosf(tilt), s = sinf(tilt);
    *x = cx + ex * c - ey * s;
    *y = cy + ex * s + ey * c;
}

// One half of a planet's ring. The far half is hidden where the planet is in front of it; the near
// half crosses the planet, with a dark line each side so it stands out against the lit surface.
void drawRingHalf(Adafruit_GFX& g, float cx, float cy, float r, float rx, float ry, float tilt, bool nearHalf, bool dotted) {
    const int16_t n = (int16_t)(rx * 7.0f);
    const float c = cosf(tilt), s = sinf(tilt);
    // Walk round the ellipse by turning (cos a, sin a) one step at a time: no trigonometry per point
    const float dc = cosf(TAU / n), ds = sinf(TAU / n);
    for (uint8_t pass = nearHalf ? 0 : 1; pass < 2; ++pass) {
        float ca = 1.0f, sa = 0.0f;
        for (int16_t i = 0; i < n; ++i) {
            const float ex = rx * ca, ey = ry * sa;
            const bool skip = (dotted && (i % 3) == 1) || ((sa > 0.0f) != nearHalf);
            const float next = ca * dc - sa * ds;
            sa = sa * dc + ca * ds;
            ca = next;
            if (skip) continue;
            const int16_t px = (int16_t)lroundf(cx + ex * c - ey * s), py = (int16_t)lroundf(cy + ex * s + ey * c);
            const bool overPlanet = insideDisc(px, py, cx, cy, r + 0.5f);
            if (pass == 0) {
                if (overPlanet) {
                    g.drawPixel(px, py - 1, BLACK);
                    g.drawPixel(px, py + 1, BLACK);
                }
            } else if (nearHalf || !overPlanet) {
                g.drawPixel(px, py, WHITE);
            }
        }
    }
}

// A planet lit from the upper left, shaded with an ordered dither (a small one is lit or dark,
// with no dither). turn (radians) spins its three cloud belts, which waver with longitude so the
// turning shows; storm: a dark oval on the surface at longitude stormLon (radians), or none if
// < -100. The disc is cleared first, so whatever is behind it (stars, a moon) is hidden.
void drawPlanet(Adafruit_GFX& g, float cx, float cy, float r, float turn, float stormLon) {
    const int16_t ir = (int16_t)ceilf(r);
    const bool small = r < 8.0f;
    const float ct = cosf(turn), st = sinf(turn);
    // The storm sits a little south of the equator; where it faces now
    constexpr float STORM_NY = 0.32f;
    const float stormCos = sqrtf(1.0f - STORM_NY * STORM_NY);
    const float sl = stormLon - turn;
    const float sx = stormCos * sinf(sl), sz = stormCos * cosf(sl);
    const bool storm = stormLon > -100.0f && sz > 0.1f;
    static const float kBelt[3][3] = {{-0.48f, 0.05f, 0.0f}, {-0.08f, 0.0f, 0.06f}, {0.55f, 0.04f, -0.03f}};
    const float beltHalf = 0.6f / r;   // about a pixel wide whatever the size
    for (int16_t dy = -ir; dy <= ir; ++dy) {
        const float ny = dy / r;
        if (ny * ny > 1.0f) continue;
        const float cosLat = sqrtf(1.0f - ny * ny);
        const int16_t py = (int16_t)lroundf(cy) + dy;
        for (int16_t dx = -ir; dx <= ir; ++dx) {
            const float nx = dx / r;
            const float d2 = nx * nx + ny * ny;
            if (d2 > 1.0f) continue;
            const int16_t px = (int16_t)lroundf(cx) + dx;
            const float nz = sqrtf(1.0f - d2);
            float b = (LIGHT_X * nx + LIGHT_Y * ny + LIGHT_Z * nz) * 1.3f + 0.1f;
            if (!small && b > 0.25f) {
                // sin and cos of the longitude on the turning surface
                const float sinLon = cosLat > 0.05f ? (nx * ct + nz * st) / cosLat : 0.0f;
                const float cosLon = cosLat > 0.05f ? (nz * ct - nx * st) / cosLat : 0.0f;
                for (const auto& belt : kBelt) {
                    const float at = belt[0] + belt[1] * sinLon * 2.0f + belt[2] * cosLon * 2.0f;
                    if (fabsf(ny - at) < beltHalf) b *= 0.3f;
                }
                if (storm) {
                    const float ex = nx - sx, ey = ny - STORM_NY;
                    if (ex * ex * 0.6f + ey * ey * 1.6f < 0.018f) b *= 0.15f;
                }
            }
            const bool lit = small ? b > 0.3f : b * 16.0f > kBayer4[py & 3][px & 3] + 0.5f;
            g.drawPixel(px, py, lit ? WHITE : BLACK);
        }
    }
    // The dark side's edge, dotted, so the night side still has a shape
    const int16_t n = (int16_t)(r * 6.0f);
    for (int16_t i = 0; i < n; i += 2) {
        const float a = i * TAU / n;
        const float ex = cosf(a), ey = sinf(a);
        if (LIGHT_X * ex + LIGHT_Y * ey > -0.2f) continue;
        g.drawPixel((int16_t)lroundf(cx + ex * r), (int16_t)lroundf(cy + ey * r), WHITE);
    }
}

// A ringed planet: the far half of the ring, the planet, then the near half
void drawRingedPlanet(Adafruit_GFX& g, float cx, float cy, float r, float turn, float stormLon, float tilt) {
    const float rx = r * 1.8f, ry = r * 0.5f;
    drawRingHalf(g, cx, cy, r, rx, ry, tilt, false, false);
    drawRingHalf(g, cx, cy, r, rx * 0.86f, ry * 0.86f, tilt, false, true);
    drawPlanet(g, cx, cy, r, turn, stormLon);
    drawRingHalf(g, cx, cy, r, rx, ry, tilt, true, false);
    drawRingHalf(g, cx, cy, r, rx * 0.86f, ry * 0.86f, tilt, true, true);
}

// A small moon lit from the same side as the planet; skip: a disc it is hidden behind (r 0: none).
// A moon in front gets a dark outline so it reads against the planet.
void drawMoon(Adafruit_GFX& g, float cx, float cy, float r, bool outline, float skipX, float skipY, float skipR) {
    const int16_t ir = (int16_t)ceilf(r) + 1;
    const int16_t mx = (int16_t)lroundf(cx), my = (int16_t)lroundf(cy);
    for (int16_t dy = -ir; dy <= ir; ++dy) {
        for (int16_t dx = -ir; dx <= ir; ++dx) {
            const float d2 = (dx * dx + dy * dy) / (r * r);
            const int16_t px = mx + dx, py = my + dy;
            if (skipR > 0.0f && insideDisc(px, py, skipX, skipY, skipR)) continue;
            if (d2 > 1.0f) {
                if (outline && d2 < (r + 1.2f) * (r + 1.2f) / (r * r)) g.drawPixel(px, py, BLACK);
                continue;
            }
            const float nz = sqrtf(1.0f - d2);
            const float b = LIGHT_X * dx / r + LIGHT_Y * dy / r + LIGHT_Z * nz;
            g.drawPixel(px, py, b > 0.12f ? WHITE : BLACK);
        }
    }
}

// A streak from (x0, y0) to (x1, y1): solid at the head (x1, y1), dotted down its tail. Points
// inside the skip disc are not drawn.
void drawStreak(Adafruit_GFX& g, float x0, float y0, float x1, float y1, float skipX = 0, float skipY = 0, float skipR = 0) {
    const float dx = x1 - x0, dy = y1 - y0;
    const float len = sqrtf(dx * dx + dy * dy);
    const int16_t n = (int16_t)len;
    for (int16_t k = 0; k <= n; ++k) {
        if (k >= 3 && (k & 1)) continue;
        const float f = n > 0 ? (float)k / len : 0.0f;
        const float x = x1 - dx * f, y = y1 - dy * f;
        if (skipR > 0.0f && insideDisc(x, y, skipX, skipY, skipR)) continue;
        g.drawPixel((int16_t)lroundf(x), (int16_t)lroundf(y), WHITE);
    }
}

// Corner brackets around a box, arms `arm` px long
void drawBrackets(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, int16_t h, int16_t arm, uint16_t color) {
    g.drawFastHLine(x, y, arm, color);
    g.drawFastVLine(x, y, arm, color);
    g.drawFastHLine(x + w - arm, y, arm, color);
    g.drawFastVLine(x + w - 1, y, arm, color);
    g.drawFastHLine(x, y + h - 1, arm, color);
    g.drawFastVLine(x, y + h - arm, arm, color);
    g.drawFastHLine(x + w - arm, y + h - 1, arm, color);
    g.drawFastVLine(x + w - 1, y + h - arm, arm, color);
}

void printAt(Adafruit_GFX& g, int16_t x, int16_t y, const char* text, uint8_t size = 1) {
    g.setTextWrap(false);
    g.setTextColor(WHITE);
    g.setTextSize(size);
    g.setCursor(x, y);
    g.print(text);
    g.setTextSize(1);
}

} // namespace

// ---- small pieces -------------------------------------------------------------------------------

void drawBadge(Adafruit_GFX& g, int16_t x, int16_t y) {
    drawRingedPlanet(g, x + 10.0f, y + 10.0f, 5.5f, 0.6f, -1000.0f, -0.35f);
}

void drawCardFrame(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, int16_t h, bool pressed) {
    constexpr int16_t ARM = 6;
    if (pressed) {
        g.fillRect(x, y, w, h, WHITE);
        // Cut corners, and the viewfinder's brackets in reverse inside
        for (int16_t k = 0; k < 3; ++k) {
            g.drawFastHLine(x, y + k, 3 - k, BLACK);
            g.drawFastHLine(x + w - 3 + k, y + k, 3 - k, BLACK);
            g.drawFastHLine(x, y + h - 1 - k, 3 - k, BLACK);
            g.drawFastHLine(x + w - 3 + k, y + h - 1 - k, 3 - k, BLACK);
        }
        drawBrackets(g, x + 3, y + 3, w - 6, h - 6, ARM - 1, BLACK);
        return;
    }
    drawBrackets(g, x, y, w, h, ARM, WHITE);
    for (int16_t i = x + ARM + 1; i < x + w - ARM - 1; i += 3) {
        g.drawPixel(i, y, WHITE);
        g.drawPixel(i, y + h - 1, WHITE);
    }
    for (int16_t j = y + ARM + 1; j < y + h - ARM - 1; j += 3) {
        g.drawPixel(x, j, WHITE);
        g.drawPixel(x + w - 1, j, WHITE);
    }
}

void drawLockOn(Adafruit_GFX& g, int16_t x, int16_t y, int16_t cell, uint8_t step) {
    if (step >= LOCK_STEPS) return;
    static const uint8_t kGap[LOCK_STEPS] = {6, 4, 3, 2, 1, 1, 1, 1};   // px outside the cell
    if (step >= LOCK_STEPS - 2 && (step & 1)) return;                   // locked: it blinks out
    const int16_t k = kGap[step];
    drawBrackets(g, x - k, y - k, cell + 2 * k, cell + 2 * k, 3, WHITE);
}

void drawOrbit(Adafruit_GFX& g, int16_t x, int16_t y, int16_t w, uint32_t nowMs) {
    // A few stars across the strip, each twinkling on its own beat
    static const int8_t kStars[][2] = {{26, -5}, {35, 0}, {44, -3}, {52, 1}, {60, -5}, {67, -1}, {74, 2}, {31, 2}};
    for (uint8_t i = 0; i < sizeof kStars / sizeof kStars[0]; ++i) {
        const int16_t sx = x + (int16_t)((int32_t)kStars[i][0] * w / 76), sy = y + kStars[i][1];
        const uint32_t period = 1700 + i * 430;
        const uint32_t p = (nowMs + i * 911) % period;
        if (p < period / 6) continue;
        g.drawPixel(sx, sy, WHITE);
        if (i % 3 == 0 && p > period * 5 / 6) {   // some flare into a small cross
            g.drawPixel(sx - 1, sy, WHITE); g.drawPixel(sx + 1, sy, WHITE);
            g.drawPixel(sx, sy - 1, WHITE); g.drawPixel(sx, sy + 1, WHITE);
        }
    }

    // A small planet with a moon going round it, behind and then in front
    const float px = x + 10.0f, py = y - 3.0f;
    const float a = TAU * (nowMs % 5200) / 5200.0f;
    float mx, my;
    ellipsePoint(px, py, 15.0f, 3.5f, -0.12f, a, &mx, &my);
    const bool front = sinf(a) > 0.0f;
    const int16_t imx = (int16_t)lroundf(mx), imy = (int16_t)lroundf(my);
    if (!front && !insideDisc(imx, imy, px, py, 5.2f)) g.fillRect(imx, imy, 2, 2, WHITE);
    drawRingedPlanet(g, px, py, 4.6f, 0.0f, -1000.0f, -0.3f);
    if (front) {
        g.fillRect(imx - 1, imy - 1, 4, 4, BLACK);
        g.fillRect(imx, imy, 2, 2, WHITE);
    }

    // Now and then a meteor crosses the strip from right to left
    const uint32_t m = nowMs % 7000;
    if (m < 600) {
        const float p = m / 600.0f;
        const float hx = x + w - 4 - p * (w - 30), hy = y - 6 + p * 5.0f;
        drawStreak(g, hx + 7.0f, hy - 1.2f, hx, hy);
    }
}

void drawWarp(Adafruit_GFX& g, uint32_t elapsed, uint32_t total, uint8_t layer, const char* name) {
    if (elapsed >= total) return;
    const uint32_t edge = total / 4;
    float open;
    if (elapsed < edge) open = easeOut((float)elapsed / edge);
    else if (elapsed > total - edge) open = easeOut((float)(total - elapsed) / edge);
    else open = 1.0f;
    const float r = 74.0f * open;   // 74 covers the corners (they are 71.6 px from the centre)
    if (r < 1.0f) return;
    g.fillCircle(64, 32, (int16_t)lroundf(r), BLACK);

    // Stars rush outwards from the centre, stretching as they go
    for (uint8_t i = 0; i < 20; ++i) {
        const uint32_t h = hash32(i * 2654435761U + 17);
        const float a = (i + (h & 0xFF) / 400.0f) * TAU / 20;
        const float speed = 90.0f + (h >> 8) % 70;
        const float d = fmodf((h >> 16) % 70 + elapsed * speed / 1000.0f, 76.0f) + 3.0f;
        const float len = 2.0f + d * 0.16f;
        const float ux = cosf(a), uy = sinf(a) * 0.9f;
        for (float s = d; s < d + len; s += 1.0f) {
            if (s >= r) break;
            g.drawPixel(64 + (int16_t)lroundf(ux * s), 32 + (int16_t)lroundf(uy * s), WHITE);
        }
    }
    g.drawRect(63, 31, 2, 2, BLACK);
    if (open < 1.0f) {
        // The window's edge, dotted
        const int16_t n = (int16_t)(r * 6.0f);
        for (int16_t i = 0; i < n; i += 3) {
            const float a = i * TAU / n;
            g.drawPixel(64 + (int16_t)lroundf(cosf(a) * r), 32 + (int16_t)lroundf(sinf(a) * r), WHITE);
        }
        return;
    }

    // Wide open: the layer in a viewfinder at the centre
    char tag[12];
    snprintf(tag, sizeof(tag), "LAYER %u", (unsigned)layer + 1);
    const int16_t nameW = (int16_t)strlen(name) * 12 - 2;
    const int16_t w = (nameW > 56 ? nameW : 56) + 16;
    const int16_t bx = 64 - w / 2;
    g.fillRect(bx, 18, w, 29, BLACK);
    drawBrackets(g, bx, 18, w, 29, 5, WHITE);
    printAt(g, 64 - ((int16_t)strlen(tag) * 6 - 1) / 2, 21, tag);
    printAt(g, 64 - nameW / 2, 31, name, 2);
}

// ---- the title ----------------------------------------------------------------------------------

void drawIntro(Adafruit_GFX& g, uint32_t t, const char* status) {
    // Out of light speed: every star flies out from the centre and settles in its place, its streak
    // shortening as it slows
    constexpr float CX = 64.0f, CY = 30.0f;
    for (uint8_t i = 0; i < 30; ++i) {
        const uint32_t h = hash32(i * 0x9E3779B9U + 5);
        const float sx = (float)(h % 128), sy = (float)((h >> 8) % 52);
        const uint32_t start = (i * 53) % 500;
        const float k = easeOut(span(t, start, start + 1500));
        if (k <= 0.0f) continue;
        const float k0 = easeOut(span(t > 90 ? t - 90 : 0, start, start + 1500));
        const float x1 = CX + (sx - CX) * k, y1 = CY + (sy - CY) * k;
        const float x0 = CX + (sx - CX) * k0, y0 = CY + (sy - CY) * k0;
        drawStreak(g, x0, y0, x1, y1);
    }

    // A ringed planet rises at the lower left, turning slowly
    if (t >= 1500) {
        const float rise = easeOut(span(t, 1500, 2900));
        drawRingedPlanet(g, 25.0f, 80.0f - 42.0f * rise, 12.0f, t / 2500.0f, 2.0f, -0.22f);
    }

    // The name, one letter at a time, then an orbit line with a satellite running along it
    if (t >= 2700) {
        static const char kName[] = "DRIFTPAD";
        const uint8_t shown = (uint8_t)((t - 2700) / 70 > 8 ? 8 : (t - 2700) / 70);
        g.setTextWrap(false);
        g.setTextColor(WHITE);
        g.setTextSize(1);
        for (uint8_t i = 0; i < shown; ++i) {
            g.setCursor(60 + i * 8, 20);
            g.print(kName[i]);
        }
        const int16_t line = (int16_t)lroundf(span(t, 3250, 3700) * 61.0f);
        for (int16_t i = 0; i < line; i += 2) g.drawPixel(60 + i, 31, WHITE);
        if (t >= 3700) {
            const int16_t sat = 60 + (int16_t)(((t - 3700) / 40) % 61);
            g.fillRect(sat - 1, 30, 3, 3, WHITE);
        }
    }

    // The pad's status, typed in, with a blinking cursor once it is complete
    if (t >= 3800 && status) {
        const int16_t len = (int16_t)strlen(status);
        int16_t typed = (int16_t)((t - 3800) / 45);
        if (typed > len) typed = len;
        const int16_t sx = 64 - len * 6 / 2;
        g.fillRect(0, 54, 128, 10, BLACK);
        g.setTextSize(1);
        for (int16_t i = 0; i < typed; ++i) {
            g.setCursor(sx + i * 6, 55);
            g.print(status[i]);
        }
        if (typed < len || ((t / 400) & 1)) g.fillRect(sx + typed * 6, 55, 5, 7, WHITE);
    }
}

// ---- the screensaver ----------------------------------------------------------------------------

void Scene::moonAt(float* x, float* y, bool* inFront) const {
    const float a = TAU * (float)(m_t % MOON_ORBIT_MS) / MOON_ORBIT_MS + (m_seed % 628) / 100.0f;
    ellipsePoint(PLANET_X, PLANET_Y, 46.0f, 14.0f, RING_TILT, a, x, y);
    *inFront = sinf(a) > 0.0f;
}

float Scene::stormX() const {
    const float turn = TAU * (float)(m_t % DAY_MS) / DAY_MS;
    const float sl = 1.0f - turn;   // the storm's longitude is 1 rad on the planet
    if (cosf(sl) <= 0.1f) return -2000.0f;
    return PLANET_X + PLANET_R * sqrtf(1.0f - 0.32f * 0.32f) * sinf(sl);
}

void Scene::render(Adafruit_GFX& g) const {
    // The stars: fixed for the whole scene, a few of them twinkling
    for (uint8_t i = 0; i < 36; ++i) {
        const uint32_t h = hash32(i * 0x9E3779B9U ^ m_seed);
        const int16_t sx = (int16_t)(h % 128), sy = (int16_t)((h >> 8) % 64);
        if (insideDisc(sx, sy, PLANET_X, PLANET_Y, PLANET_R + 1.5f)) continue;
        if (i % 4 == 0) {
            const uint32_t period = 1500 + (h >> 16) % 2500;
            const uint32_t p = (m_t + (h >> 4)) % period;
            if (p < period / 4) continue;
            if (i % 8 == 0 && p > period * 7 / 8) {
                g.drawPixel(sx - 1, sy, WHITE); g.drawPixel(sx + 1, sy, WHITE);
                g.drawPixel(sx, sy - 1, WHITE); g.drawPixel(sx, sy + 1, WHITE);
            }
        }
        g.drawPixel(sx, sy, WHITE);
    }

    float mx, my;
    bool front;
    moonAt(&mx, &my, &front);
    if (!front) drawMoon(g, mx, my, 2.2f, false, PLANET_X, PLANET_Y, PLANET_R + 0.5f);

    const float turn = TAU * (float)(m_t % DAY_MS) / DAY_MS;
    drawRingedPlanet(g, PLANET_X, PLANET_Y, PLANET_R, turn, 1.0f, RING_TILT);

    if (front) drawMoon(g, mx, my, 3.2f, true, 0, 0, 0);

    // A meteor in some of the slots, from the upper left, at a time and place set by the slot
    const uint32_t slot = m_t / METEOR_SLOT_MS;
    const uint32_t h = hash32(slot * 0x85EBCA6BU ^ m_seed);
    if (h & 3) {
        const uint32_t start = (h >> 4) % (METEOR_SLOT_MS - METEOR_MS);
        const uint32_t local = m_t % METEOR_SLOT_MS;
        if (local >= start && local < start + METEOR_MS) {
            const float p = (float)(local - start) / METEOR_MS;
            const float x0 = 4.0f + (h >> 8) % 40, y0 = 2.0f + (h >> 14) % 12;
            const float hx = x0 + p * 40.0f, hy = y0 + p * 18.0f;
            const float len = 9.0f * (p < 0.5f ? 0.4f + p * 1.2f : 1.0f - (p - 0.5f) * 1.2f);
            drawStreak(g, hx - len * 0.91f, hy - len * 0.41f, hx, hy, PLANET_X, PLANET_Y, PLANET_R + 1.0f);
        }
    }
}

} // namespace space
