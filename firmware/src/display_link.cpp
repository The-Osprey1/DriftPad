#include "display_link.h"

#include <cstring>

namespace display_link {
namespace {

// Full barrier: DMB on the RP2040, a fence on the host; also a compiler barrier.
inline void barrier() { __sync_synchronize(); }

constexpr uint8_t READ_ATTEMPTS = 8;

// Sequence lock. Odd while publish() is writing; 0 until the first publish.
volatile uint32_t s_seq = 0;
Snapshot s_buffer;

// Written by core 0 only
volatile uint32_t s_posted[REQUEST_COUNT];
volatile int32_t  s_arg[REQUEST_COUNT];
volatile uint32_t s_stamp[REQUEST_COUNT];
uint32_t          s_order = 0;
volatile uint32_t s_published = 0;

// Written by core 1 only
volatile uint32_t s_served[REQUEST_COUNT];
volatile uint8_t  s_scanCount = 0;
volatile uint8_t  s_scanFound[SCAN_MAX];
volatile uint32_t s_reads = 0;
volatile uint32_t s_retries = 0;
volatile uint32_t s_stale = 0;

} // namespace

void reset() {
    s_seq = 0;
    memset(&s_buffer, 0, sizeof(s_buffer));
    for (uint8_t i = 0; i < REQUEST_COUNT; ++i) {
        s_posted[i] = 0;
        s_arg[i] = 0;
        s_stamp[i] = 0;
        s_served[i] = 0;
    }
    s_scanCount = 0;
    s_order = 0;
    s_published = s_reads = s_retries = s_stale = 0;
    barrier();
}

void publish(const Snapshot& s) {
    const uint32_t seq = s_seq;
    s_seq = seq + 1;            // odd: a copy started now must be retried
    barrier();
    memcpy(&s_buffer, &s, sizeof(s_buffer));
    barrier();
    s_seq = seq + 2 == 0 ? 2 : seq + 2;   // even again; 0 is reserved for "nothing published"
    s_published = s_published + 1;
}

bool read(Snapshot& out) {
    for (uint8_t attempt = 0; attempt < READ_ATTEMPTS; ++attempt) {
        const uint32_t before = s_seq;
        barrier();
        if (before == 0) return false;
        if ((before & 1u) == 0) {
            Snapshot copy;
            memcpy(&copy, &s_buffer, sizeof(copy));
            barrier();
            if (s_seq == before) {
                memcpy(&out, &copy, sizeof(out));
                s_reads = s_reads + 1;
                return true;
            }
        }
        s_retries = s_retries + 1;
    }
    return false;
}

uint32_t post(Request r, int32_t arg) {
    const uint8_t i = (uint8_t)r;
    if (i >= REQUEST_COUNT) return 0;
    s_arg[i] = arg;
    s_stamp[i] = ++s_order;
    barrier();                  // argument and stamp are visible before the ticket that announces them
    uint32_t ticket = s_posted[i] + 1;
    if (ticket == 0) ticket = 1;
    s_posted[i] = ticket;
    return ticket;
}

bool isServed(Request r, uint32_t ticket) {
    const uint8_t i = (uint8_t)r;
    if (i >= REQUEST_COUNT || ticket == 0) return false;
    const bool done = (int32_t)(s_served[i] - ticket) >= 0;
    barrier();                  // results written before markServed() are read after this
    return done;
}

uint8_t scanResult(uint8_t* found, uint8_t max) {
    barrier();
    const uint8_t n = s_scanCount;
    for (uint8_t i = 0; i < n && i < max && i < SCAN_MAX; ++i) found[i] = s_scanFound[i];
    return n;
}

uint32_t pending(Request r, int32_t* arg, uint32_t* stamp) {
    const uint8_t i = (uint8_t)r;
    if (i >= REQUEST_COUNT) return 0;
    const uint32_t posted = s_posted[i];
    barrier();
    if (posted == s_served[i]) return 0;
    if (arg != nullptr) *arg = s_arg[i];
    if (stamp != nullptr) *stamp = s_stamp[i];
    return posted;
}

void markServed(Request r, uint32_t ticket) {
    const uint8_t i = (uint8_t)r;
    if (i >= REQUEST_COUNT || ticket == 0) return;
    barrier();                  // everything the request produced is visible before its ticket
    s_served[i] = ticket;
}

void setScanResult(const uint8_t* found, uint8_t count) {
    const uint8_t n = count < SCAN_MAX ? count : SCAN_MAX;
    for (uint8_t i = 0; i < n; ++i) s_scanFound[i] = found[i];
    s_scanCount = count;        // the real count, even when more answered than fit
}

#ifdef DISPLAY_LINK_TEST_HOOKS
void testSetSequence(uint32_t v) { s_seq = v; }
#endif

void noteStaleFrame() { s_stale = s_stale + 1; }

Stats stats() {
    Stats s;
    s.published = s_published;
    s.reads = s_reads;
    s.retries = s_retries;
    s.staleFrames = s_stale;
    return s;
}

} // namespace display_link
