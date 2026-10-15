#include "tx_queue.h"

#include <cstring>

namespace proto {

TxQueue::TxQueue() : _head(0), _count(0), _midLine(false), _stats{} {}

void TxQueue::pushBytes(const uint8_t* data, size_t n) {
    size_t tail = (_head + _count) % TX_QUEUE_BYTES;
    size_t first = TX_QUEUE_BYTES - tail;
    if (first > n) first = n;
    memcpy(_buf + tail, data, first);
    if (n > first) memcpy(_buf, data + first, n - first);
    _count += n;
}

bool TxQueue::enqueue(const char* line, size_t len, TxPriority priority) {
    if (line == nullptr || len == 0 || len + 1 > TX_QUEUE_BYTES ||
        memchr(line, '\n', len) != nullptr || memchr(line, '\r', len) != nullptr) {
        _stats.linesInvalid++;
        return false;
    }

    size_t need = len + 1;
    if (priority == TxPriority::Reply) {
        if (need > freeSpace()) {
            _stats.repliesRejected++;
            return false;
        }
    } else if (need + MAX_REPLY_LEN + 1 > freeSpace()) {
        // Keep one maximum reply's worth of space free for the next command
        _stats.eventsDropped++;
        return false;
    }

    pushBytes(reinterpret_cast<const uint8_t*>(line), len);
    const uint8_t nl = '\n';
    pushBytes(&nl, 1);

    _stats.bytesQueued += (uint32_t)need;
    _stats.linesQueued++;
    if (priority == TxPriority::Reply) _stats.repliesQueued++;
    else _stats.eventsQueued++;
    if (_count > _stats.highWater) _stats.highWater = (uint32_t)_count;
    return true;
}

size_t TxQueue::drain(TxSink& sink, size_t maxBytes) {
    if (_count == 0 || maxBytes == 0) return 0;
    int avail = sink.availableForWrite();
    if (avail <= 0) return 0;

    size_t budget = _count;
    if ((size_t)avail < budget) budget = (size_t)avail;
    if (maxBytes < budget) budget = maxBytes;

    size_t total = 0;
    while (budget > 0) {
        size_t chunk = TX_QUEUE_BYTES - _head;   // contiguous run up to the wrap
        if (chunk > budget) chunk = budget;
        size_t written = sink.write(_buf + _head, chunk);
        if (written > chunk) written = chunk;
        if (written == 0) break;
        _midLine = _buf[_head + written - 1] != '\n';
        _head = (_head + written) % TX_QUEUE_BYTES;
        _count -= written;
        total += written;
        budget -= written;
        if (written < chunk) break;               // sink took less than it offered; retry later
    }
    if (_count == 0) _head = 0;
    _stats.bytesSent += (uint32_t)total;
    return total;
}

void TxQueue::clear() {
    size_t keep = 0;
    if (_midLine) {
        // Finish the line the host has already started receiving
        while (keep < _count) {
            uint8_t c = _buf[(_head + keep) % TX_QUEUE_BYTES];
            ++keep;
            if (c == '\n') break;
        }
    }
    _stats.bytesCleared += (uint32_t)(_count - keep);
    _count = keep;
    if (_count == 0) _head = 0;
}

void TxQueue::resetStats() {
    _stats = Stats{};
    _stats.highWater = (uint32_t)_count;
}

} // namespace proto
