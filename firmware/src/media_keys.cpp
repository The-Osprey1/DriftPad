#include "media_keys.h"
#include "keyboard_output.h"
#include "keyboard_output_hal.h"

namespace MediaKeys {
namespace {

constexpr uint8_t QUEUE_LEN = 16;   // a fast spin; more than this is dropped, not saved for later
uint16_t s_queue[QUEUE_LEN];
uint8_t  s_head = 0;
uint8_t  s_count = 0;
bool     s_down = false;            // a press was sent and its release has not been

bool idle() {
    return hidEndpointFree() && KeyboardOutput::deliveryState() == KeyboardOutput::Delivery::Confirmed;
}

} // namespace

void init() {
    s_head = 0;
    s_count = 0;
    s_down = false;
}

void tap(uint16_t usage, uint8_t count) {
    if (!KeyboardOutput::isEnabled()) return;
    while (count-- > 0 && s_count < QUEUE_LEN) {
        s_queue[(uint8_t)((s_head + s_count) % QUEUE_LEN)] = usage;
        s_count++;
    }
}

void service() {
    if (!hidLinkUp()) {
        // Suspended or unplugged: the host forgets a held media key, and stale taps are dropped
        s_down = false;
        s_count = 0;
        return;
    }
    if (!KeyboardOutput::isEnabled()) s_count = 0;   // nothing new; a key that is down still goes up
    if (!idle()) return;
    if (s_down) {
        // A held volume key repeats on the host, so the release goes out first, always
        hidConsumerRelease();
        s_down = false;
    } else if (s_count > 0) {
        hidConsumerPress(s_queue[s_head]);
        s_head = (uint8_t)((s_head + 1) % QUEUE_LEN);
        s_count--;
        s_down = true;
    }
}

uint8_t queued() {
    return s_count;
}

} // namespace MediaKeys
