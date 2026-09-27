#ifndef DISPLAY_LINK_H
#define DISPLAY_LINK_H

#include <cstdint>
#include "pins.h"

/**
 * @file display_link.h
 * @brief The only channel between core 0 (sensing, USB, protocol, settings) and core 1 (display).
 *
 * Ownership. Core 1 owns the I2C bus and the display driver completely: core 0 never calls Wire
 * or the display, and core 1 never reads HallManager, the settings or the keyboard output.
 *
 * Snapshot. Everything core 1 draws. Core 0 publishes it after every scan with a sequence lock
 * (one writer, one reader, no lock and no waiting on core 0). Core 1 copies a consistent snapshot
 * at the start of each frame; when every attempt races a publish, the frame reuses the previous
 * copy (counted in stats().staleFrames).
 *
 * Requests. Wake, sleep, screensaver, test pattern and bus scan. Each kind is a pair of
 * counters, posted by core 0 and served by core 1, so a request is never lost and no
 * read-modify-write is shared between the cores. Requests of one kind coalesce: core 1 serves
 * the newest ticket (and argument) it sees. Every post also gets an order stamp, so core 1 can
 * apply requests of different kinds (a sleep, then the wake of the next command) in the order
 * they were posted. Core 0 learns completion by comparing its ticket with the served counter;
 * the protocol defers the OLED_TEST and OLED_SCAN replies on that.
 *
 * Aligned 32-bit loads and stores are atomic on the RP2040 (Cortex-M0+). barrier() orders memory
 * accesses between the cores (DMB) and stops the compiler moving accesses across it.
 */
namespace display_link {

struct KeyView {
    float   travelMm;
    uint8_t pressCount;     // edge counters, monotonic modulo 256
    uint8_t releaseCount;
    bool    pressed;
    char    label[5];
};

struct Snapshot {
    KeyView keys[NUM_KEYS];
    int8_t  lastActiveKey;  // -1 before the first press
    uint8_t activeLayer;
    bool    rapidTrigger;
    float   actuationMm;
    float   rtSensMm;
};

enum class Request : uint8_t {
    Wake = 0,       // leave sleep / screensaver, restart the idle timers, redraw
    Sleep,          // display off
    Screensaver,    // start the screensaver now; argument: animation 0..5, or -1 to cycle
    TestPattern,    // draw the test pattern
    ScanBus,        // probe every I2C address; the result is read with scanResult()
    Count
};
constexpr uint8_t REQUEST_COUNT = (uint8_t)Request::Count;
constexpr uint8_t SCAN_MAX = 8;

struct Stats {
    uint32_t published;     // snapshots published by core 0
    uint32_t reads;         // consistent copies taken by core 1
    uint32_t retries;       // copies that raced a publish and were taken again
    uint32_t staleFrames;   // frames drawn from the previous copy (every attempt raced)
};

// Both cores idle (setup, tests): forgets the snapshot, requests and counters.
void reset();

// ---- core 0
void publish(const Snapshot& s);
// Returns the ticket of this request (never 0).
uint32_t post(Request r, int32_t arg = 0);
bool isServed(Request r, uint32_t ticket);
// After isServed(ScanBus, ticket): the addresses that answered (at most `max`), returns the count.
uint8_t scanResult(uint8_t* found, uint8_t max);

// ---- core 1
// Copies the newest consistent snapshot into `out`. False (and `out` untouched) when nothing was
// published yet or every attempt raced a publish.
bool read(Snapshot& out);
// The newest posted ticket not yet served (0 when none), with the argument and order stamp of
// the newest post (stamps increase across all kinds in posting order).
uint32_t pending(Request r, int32_t* arg = nullptr, uint32_t* stamp = nullptr);
// Marks everything up to `ticket` served. For ScanBus, call setScanResult() first.
void markServed(Request r, uint32_t ticket);
void setScanResult(const uint8_t* found, uint8_t count);
void noteStaleFrame();

Stats stats();

} // namespace display_link

#endif // DISPLAY_LINK_H
