#include "media_keys.h"
#include "keyboard_output.h"
#include "keyboard_output_hal.h"
#include "config.h"

namespace MediaKeys {
namespace {

enum class Kind : uint8_t { None = 0, Media, Key, Wheel, Button };

struct Action {
    Kind     kind;
    uint8_t  modifiers;   // Key: HID modifier bits
    uint16_t code;        // Media: consumer usage; Key: keyboard usage; Wheel: steps (int8); Button: bits
};

constexpr uint8_t QUEUE_LEN = 16;   // a fast spin; more than this is dropped, not saved for later
Action   s_queue[QUEUE_LEN];
uint8_t  s_head = 0;
uint8_t  s_count = 0;
Kind     s_down = Kind::None;       // what was pressed and not released yet
uint8_t  s_knobSeq = 0;
uint8_t  s_knobAction = 0;

void noteKnob(uint8_t mode, uint8_t what) {
    s_knobSeq++;
    s_knobAction = (uint8_t)(((mode & 0x07) << 3) | what | (KeyboardOutput::isEnabled() ? 0 : 0x80));
}

bool idle() {
    return hidEndpointFree() && KeyboardOutput::deliveryState() == KeyboardOutput::Delivery::Confirmed;
}

void push(const Action& a, uint8_t count) {
    if (!KeyboardOutput::isEnabled()) return;
    while (count-- > 0 && s_count < QUEUE_LEN) {
        s_queue[(uint8_t)((s_head + s_count) % QUEUE_LEN)] = a;
        s_count++;
    }
}

uint8_t clamp255(int32_t clicks) {
    const uint32_t n = (uint32_t)(clicks > 0 ? clicks : -clicks);
    return (uint8_t)(n > 255 ? 255 : n);
}

// Keyboard usages and modifier bits of the key-combination modes
constexpr uint8_t CTRL = 0x01;
constexpr uint8_t KEY_Z = 0x1D, KEY_Y = 0x1C, KEY_0 = 0x27, KEY_MINUS = 0x2D, KEY_EQUAL = 0x2E;
constexpr uint8_t KEY_ENTER = 0x28, KEY_RIGHT = 0x4F, KEY_LEFT = 0x50;

} // namespace

void init() {
    s_head = 0;
    s_count = 0;
    s_down = Kind::None;
}

void tap(uint16_t usage, uint8_t count) {
    push(Action{Kind::Media, 0, usage}, count);
}

void tapKey(uint8_t modifiers, uint8_t usage, uint8_t count) {
    push(Action{Kind::Key, modifiers, usage}, count);
}

void scroll(int8_t steps) {
    const int8_t one = steps > 0 ? 1 : -1;
    push(Action{Kind::Wheel, 0, (uint16_t)(uint8_t)one}, clamp255(steps));
}

void click(uint8_t buttons) {
    push(Action{Kind::Button, 0, buttons}, 1);
}

void knobTurn(uint8_t mode, int32_t clicks) {
    if (clicks == 0) return;
    const bool cw = clicks > 0;
    noteKnob(mode, cw ? 1 : 0);
    const uint8_t n = clamp255(clicks);
    switch ((KnobMode)mode) {
        case KnobMode::Media:  tap(cw ? NEXT_TRACK : PREV_TRACK, n); break;
        case KnobMode::Scroll: push(Action{Kind::Wheel, 0, (uint16_t)(uint8_t)(int8_t)(cw ? -1 : 1)}, n); break;   // clockwise scrolls down
        case KnobMode::Zoom:   tapKey(CTRL, cw ? KEY_EQUAL : KEY_MINUS, n); break;
        case KnobMode::Arrows: tapKey(0, cw ? KEY_RIGHT : KEY_LEFT, n); break;
        case KnobMode::Undo:   tapKey(CTRL, cw ? KEY_Y : KEY_Z, n); break;
        case KnobMode::Volume:
        default:               tap(cw ? VOLUME_UP : VOLUME_DOWN, n); break;
    }
}

void knobPress(uint8_t mode) {
    noteKnob(mode, 2);
    switch ((KnobMode)mode) {
        case KnobMode::Media:  tap(PLAY_PAUSE); break;
        case KnobMode::Scroll: click(MOUSE_MIDDLE); break;
        case KnobMode::Zoom:   tapKey(CTRL, KEY_0); break;
        case KnobMode::Arrows: tapKey(0, KEY_ENTER); break;
        case KnobMode::Undo:   break;   // a press could too easily undo or redo by accident
        case KnobMode::Volume:
        default:               tap(MUTE); break;
    }
}

void service() {
    if (!hidLinkUp()) {
        // Suspended or unplugged: the host forgets what was held, and stale taps are dropped
        if (s_down == Kind::Key) KeyboardOutput::knobRelease();
        s_down = Kind::None;
        s_count = 0;
        return;
    }
    if (!KeyboardOutput::isEnabled()) s_count = 0;   // nothing new; what is down still goes up
    if (!idle()) return;
    if (s_down != Kind::None) {
        // A held volume key repeats on the host, so the release goes out first, always
        switch (s_down) {
            case Kind::Media:  hidConsumerRelease(); break;
            case Kind::Key:    KeyboardOutput::knobRelease(); break;
            case Kind::Button: hidMouseButtons(0); break;
            default: break;
        }
        s_down = Kind::None;
        return;
    }
    if (s_count == 0) return;
    const Action a = s_queue[s_head];
    s_head = (uint8_t)((s_head + 1) % QUEUE_LEN);
    s_count--;
    switch (a.kind) {
        case Kind::Media:
            hidConsumerPress(a.code);
            s_down = Kind::Media;
            break;
        case Kind::Key:
            // Refused (output just went off, or a 7th usage): this tap is dropped
            if (KeyboardOutput::knobPress(a.modifiers, (uint8_t)a.code)) s_down = Kind::Key;
            break;
        case Kind::Wheel:
            hidMouseWheel((int8_t)(uint8_t)a.code);   // relative: nothing to release
            break;
        case Kind::Button:
            hidMouseButtons((uint8_t)a.code);
            s_down = Kind::Button;
            break;
        default:
            break;
    }
}

uint8_t queued() {
    return s_count;
}

uint8_t knobSeq() {
    return s_knobSeq;
}

uint8_t knobAction() {
    return s_knobAction;
}

} // namespace MediaKeys
