#ifndef SCREENSAVER_PLAYER_H
#define SCREENSAVER_PLAYER_H

#include <cstdint>

namespace screensaver {

constexpr int8_t COUNT = 7;
constexpr uint32_t DWELL_MS = 20000;
constexpr uint32_t TRANSITION_MS = 1500;

// Owns only playlist order and timing. It uses no Arduino globals, random generator,
// renderer state, or heap allocation, so screen selection cannot disturb an animation.
class Player {
public:
    // A valid index stays on that animation; -1 (or an invalid index) shuffles.
    // Every start is a restart, including calls with identical timestamps and seeds.
    void start(uint32_t now, int8_t selected, uint32_t seed);
    void advance(uint32_t now);

    int8_t shown() const { return m_shown; }
    int8_t incoming() const { return m_incoming; }
    int8_t target() const { return m_incoming >= 0 ? m_incoming : m_shown; }
    bool shuffled() const { return m_shuffle; }
    uint32_t transitionElapsed(uint32_t now) const;
    uint32_t labelAge(uint32_t now) const;

private:
    uint32_t random();
    void refill();
    int8_t next();

    uint32_t m_rng = 0x6d2b79f5u;
    uint32_t m_shownSince = 0;
    uint32_t m_transitionSince = 0;
    uint32_t m_labelSince = 0;
    int8_t m_shown = -1;
    int8_t m_incoming = -1;
    int8_t m_bag[COUNT] = {};
    uint8_t m_bagPos = COUNT;
    bool m_shuffle = false;
};

} // namespace screensaver

#endif // SCREENSAVER_PLAYER_H
