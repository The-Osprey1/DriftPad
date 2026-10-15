// Force-included only into the build of an older main.cpp (tests/device_host.py
// device_with_main_from): that loop still called oledUpdate(), which rendered on core 0 when core 1
// did not run. On the host the display is a stub either way, so the call does nothing.
#pragma once
inline void oledUpdate(bool force = false) { (void)force; }
