// Review-only fixture controls around the production renderer; never built into the device.
#include "../../../tests/firmware_host/oled_frames.cpp"

extern "C" int oled_review_menu(int output, int dirty, uint8_t* out) {
    oled_scene(10, out);
    s_view.outputStatus = static_cast<uint8_t>(output);
    s_view.settingsDirty = dirty != 0;
    s_view.keyInputValid = output != display_link::OUTPUT_NEEDS_CAL &&
                          output != display_link::OUTPUT_CALIBRATING;
    renderFullScreen();
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}

extern "C" int oled_review_label(const char* label, int pressed, uint8_t* out) {
    oled_scene(1, out);
    strncpy(s_view.keys[5].label, label, sizeof(s_view.keys[5].label) - 1);
    s_view.keys[5].travelMm = pressed ? 1.85f : 0.7f;
    s_view.keys[5].pressed = pressed != 0;
    s_view.keys[5].pressCount = pressed ? 1 : 0;
    s_view.keys[6].travelMm = 0.0f;
    s_view.lastActiveKey = 5;
    s_focusKey = 5;
    s_prevHadFocus = true;
    s_prevFocusActuated = pressed != 0;
    s_cardPunch = 0;
    s_revealFrames = 0;
    renderFullScreen();
    memcpy(out, s_display.getBuffer(), 128 * 64 / 8);
    return 0;
}
