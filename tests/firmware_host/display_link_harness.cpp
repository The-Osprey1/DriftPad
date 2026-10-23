// C ABI over firmware/src/display_link.cpp for tests/test_display_link.py. Two host threads play
// core 0 (writer / poster) and core 1 (reader / server). Every snapshot is built from one number
// n, so a torn copy (fields from two publishes) is detectable. naive_* runs the same stress over a
// plain shared buffer without the sequence lock: the control that shows tearing is observable here.
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <thread>
#include "display_link.h"

using namespace display_link;

namespace {

Snapshot make(uint32_t n) {
    Snapshot s;
    memset(&s, 0, sizeof(s));
    for (uint8_t i = 0; i < NUM_KEYS; ++i) {
        KeyView& k = s.keys[i];
        k.travelMm = (float)(n + i);   // exact below 2^24
        k.pressCount = (uint8_t)(n + i);
        k.releaseCount = (uint8_t)(n * 3u + i);
        k.pressed = ((n + i) & 1u) != 0;
        snprintf(k.label, sizeof(k.label), "%04u", (unsigned)((n + i) % 10000u));
    }
    s.lastActiveKey = (int8_t)(n % NUM_KEYS);
    s.activeLayer = (uint8_t)(n % 3u);
    s.rapidTrigger = (n & 2u) != 0;
    s.actuationMm = (float)(n % 4096u);
    s.rtSensMm = (float)(n % 2048u);
    return s;
}

// The n the snapshot was built from, or -1 when its fields come from different publishes
int64_t decode(const Snapshot& s) {
    const uint32_t n = (uint32_t)s.keys[0].travelMm;
    Snapshot want = make(n);
    return memcmp(&want, &s, sizeof(s)) == 0 ? (int64_t)n : -1;
}

Snapshot g_naive;   // control: no sequence lock

} // namespace

extern "C" {

void dl_reset() { reset(); }
void dl_set_sequence(uint32_t v) { testSetSequence(v); }
int  dl_snapshot_size() { return (int)sizeof(Snapshot); }
void dl_publish(uint32_t n) { publish(make(n)); }

// -2 nothing published / every attempt raced, -1 torn, else n
int64_t dl_read() {
    Snapshot s;
    if (!read(s)) return -2;
    return decode(s);
}

uint32_t dl_post(int r, int32_t arg) { return post((Request)r, arg); }
uint32_t dl_pending(int r, int32_t* arg) { return pending((Request)r, arg); }
uint32_t dl_stamp(int r) { uint32_t st = 0; pending((Request)r, nullptr, &st); return st; }
void     dl_mark_served(int r, uint32_t ticket) { markServed((Request)r, ticket); }
int      dl_is_served(int r, uint32_t ticket) { return isServed((Request)r, ticket) ? 1 : 0; }
void     dl_set_scan(const uint8_t* found, uint8_t count) { setScanResult(found, count); }
int      dl_scan_result(uint8_t* found, uint8_t max) { return scanResult(found, max); }
void     dl_note_stale() { noteStaleFrame(); }
void     dl_stats(uint32_t out[4]) {
    Stats s = stats();
    out[0] = s.published; out[1] = s.reads; out[2] = s.retries; out[3] = s.staleFrames;
}

// Writer publishes 1..writes while the reader copies continuously. out: reads, torn, backwards
// (a copy older than one already seen), failed reads.
void dl_stress(uint32_t writes, uint32_t out[4]) {
    reset();
    std::atomic<bool> done{false};
    uint32_t reads = 0, torn = 0, backwards = 0, failed = 0;
    std::thread reader([&] {
        int64_t last = 0;
        while (!done.load(std::memory_order_acquire) || reads == 0) {
            Snapshot s;
            if (!read(s)) { failed++; continue; }
            int64_t n = decode(s);
            reads++;
            if (n < 0) torn++;
            else if (n < last) backwards++;
            else last = n;
        }
    });
    for (uint32_t n = 1; n <= writes; ++n) publish(make(n));
    done.store(true, std::memory_order_release);
    reader.join();
    out[0] = reads; out[1] = torn; out[2] = backwards; out[3] = failed;
}

// Control: the same stress with a plain memcpy to a shared buffer. out: reads, torn.
void dl_naive_stress(uint32_t writes, uint32_t out[2]) {
    std::atomic<bool> done{false};
    uint32_t reads = 0, torn = 0;
    memset(&g_naive, 0, sizeof(g_naive));
    std::thread reader([&] {
        while (!done.load(std::memory_order_acquire)) {
            Snapshot s;
            memcpy(&s, (const void*)&g_naive, sizeof(s));
            __sync_synchronize();
            if (s.keys[0].label[0] == 0) continue;   // nothing written yet
            reads++;
            if (decode(s) < 0) torn++;
        }
    });
    for (uint32_t n = 1; n <= writes; ++n) {
        Snapshot s = make(n);
        memcpy((void*)&g_naive, &s, sizeof(s));
        __sync_synchronize();
    }
    done.store(true, std::memory_order_release);
    reader.join();
    out[0] = reads; out[1] = torn;
}

// Poster posts `posts` requests of kind r (argument = sequence number) while the server serves
// them. out: final posted ticket, final served ticket, times the server saw an argument older
// than the one before (arguments must never go backwards), serve calls.
void dl_request_stress(int r, uint32_t posts, uint32_t out[4]) {
    reset();
    std::atomic<bool> done{false};
    uint32_t lastTicket = 0, backwards = 0, serves = 0;
    std::thread server([&] {
        int32_t lastArg = -1;
        for (;;) {
            int32_t arg = 0;
            uint32_t t = pending((Request)r, &arg);
            if (t != 0) {
                if (arg < lastArg) backwards++;
                lastArg = arg;
                markServed((Request)r, t);
                serves++;
            } else if (done.load(std::memory_order_acquire)) {
                if (pending((Request)r, nullptr) == 0) break;
            }
        }
    });
    for (uint32_t i = 1; i <= posts; ++i) lastTicket = post((Request)r, (int32_t)i);
    done.store(true, std::memory_order_release);
    server.join();
    out[0] = lastTicket;
    out[1] = isServed((Request)r, lastTicket) ? lastTicket : 0;
    out[2] = backwards;
    out[3] = serves;
}

}
