// Host stand-in for arduino-pico's <Print.h>, only so the real Adafruit_GFX compiles on the host.
#pragma once
#include "Arduino.h"
class __FlashStringHelper;
#ifndef radians
#define radians(deg) ((deg) * 0.017453292519943295)
#endif
