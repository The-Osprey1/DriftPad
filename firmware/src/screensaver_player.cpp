#include "screensaver_player.h"

namespace screensaver {

uint32_t Player::random() {
    // This generator belongs to the playlist. Animated particles can consume their
    // own random values without changing which screensaver comes next.
    m_rng ^= m_rng << 13;
    m_rng ^= m_rng >> 17;
    m_rng ^= m_rng << 5;
    return m_rng;
}

void Player::refill() {
    for (int8_t i = 0; i < COUNT; ++i) m_bag[i] = i;
    for (int8_t i = COUNT - 1; i > 0; --i) {
        const uint8_t other = static_cast<uint8_t>(random() % (i + 1));
        const int8_t tmp = m_bag[i];
        m_bag[i] = m_bag[other];
        m_bag[other] = tmp;
    }

    // Keep every animation in the bag while avoiding a repeat across two bags.
    if (m_bag[0] == m_shown) {
        const uint8_t other = 1 + static_cast<uint8_t>(random() % (COUNT - 1));
        const int8_t tmp = m_bag[0];
        m_bag[0] = m_bag[other];
        m_bag[other] = tmp;
    }
    m_bagPos = 0;
}

int8_t Player::next() {
    if (m_bagPos >= COUNT) refill();
    return m_bag[m_bagPos++];
}

void Player::start(uint32_t now, int8_t selected, uint32_t seed) {
    m_rng = seed ? seed : 0x6d2b79f5u;
    m_shuffle = selected < 0 || selected >= COUNT;
    m_shown = -1;
    m_incoming = -1;
    m_bagPos = COUNT;
    m_shownSince = now;
    m_transitionSince = now;
    m_labelSince = now;
    m_shown = m_shuffle ? next() : selected;
}

void Player::advance(uint32_t now) {
    if (m_shown < 0 || !m_shuffle) return;

    if (m_incoming >= 0) {
        if (static_cast<uint32_t>(now - m_transitionSince) < TRANSITION_MS) return;
        m_shown = m_incoming;
        m_incoming = -1;
        m_shownSince = m_transitionSince + TRANSITION_MS;
        // The incoming label appeared halfway through the wipe, not at its end.
        m_labelSince = m_transitionSince + TRANSITION_MS / 2;
    }

    if (static_cast<uint32_t>(now - m_shownSince) >= DWELL_MS) {
        m_incoming = next();
        m_transitionSince = now;
    }
    // A delayed frame can finish one wipe and start the next, but never walks a
    // potentially unbounded backlog or skips through multiple unseen animations.
}

uint32_t Player::transitionElapsed(uint32_t now) const {
    if (m_incoming < 0) return 0;
    const uint32_t age = now - m_transitionSince;
    return age < TRANSITION_MS ? age : TRANSITION_MS;
}

uint32_t Player::labelAge(uint32_t now) const {
    if (m_incoming >= 0 && static_cast<uint32_t>(now - m_transitionSince) >= TRANSITION_MS / 2) {
        return now - (m_transitionSince + TRANSITION_MS / 2);
    }
    return now - m_labelSince;
}

} // namespace screensaver
