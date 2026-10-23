// For host builds without the firmware keyboard HAL (the pre-fix revision): TinyUSB's weak
// default transfer callbacks, which do nothing.
#include "tusb.h"

extern "C" void tud_hid_report_complete_cb(uint8_t, const uint8_t*, uint16_t) {}
extern "C" void tud_hid_report_failed_cb(uint8_t, hid_report_type_t, const uint8_t*, uint16_t) {}
