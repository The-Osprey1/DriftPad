// Host-build stand-in for the arduino-pico EEPROM library (libraries/EEPROM/src/EEPROM.cpp):
// a RAM copy of the last flash sector, loaded by begin() and written back by commit() only when
// something changed. The "flash" sector lives in eeprom_fake.cpp so a test can inspect it, count
// commits, and reboot the firmware over the same contents.
#ifndef DRIFTPAD_HOST_EEPROM_H
#define DRIFTPAD_HOST_EEPROM_H

#include <cstddef>
#include <cstdint>
#include <cstring>

extern "C" uint8_t* eeprom_fake_sector();      // 4096 bytes, memory-mapped flash stand-in
// Erase the sector, then program `size` bytes (the real commit()); honours injected power cuts
extern "C" void eeprom_fake_commit(const uint8_t* data, size_t size);

class EEPROMClass {
public:
    void begin(size_t size) {
        if (size == 0 || size > 4096) size = 4096;
        _size = (size + 255) & ~(size_t)255;
        memcpy(_data, eeprom_fake_sector(), _size);
        _dirty = false;
    }
    uint8_t read(int addr) { return (addr >= 0 && (size_t)addr < _size) ? _data[addr] : 0; }
    void write(int addr, uint8_t v) {
        if (addr < 0 || (size_t)addr >= _size) return;
        if (_data[addr] != v) { _data[addr] = v; _dirty = true; }
    }
    template <typename T> T& get(int addr, T& t) {
        if (addr >= 0 && (size_t)addr + sizeof(T) <= _size) memcpy(&t, _data + addr, sizeof(T));
        return t;
    }
    template <typename T> const T& put(int addr, const T& t) {
        if (addr >= 0 && (size_t)addr + sizeof(T) <= _size) {
            if (memcmp(_data + addr, &t, sizeof(T)) != 0) {
                memcpy(_data + addr, &t, sizeof(T));
                _dirty = true;
            }
        }
        return t;
    }
    bool commit() {
        if (_size == 0) return false;
        if (!_dirty) return true;
        eeprom_fake_commit(_data, _size);   // real library: erase 4 KB, program _size
        _dirty = false;
        return true;
    }
    size_t length() const { return _size; }
    const uint8_t* getConstDataPtr() const { return _data; }

private:
    uint8_t _data[4096];
    size_t  _size = 0;
    bool    _dirty = false;
};

extern EEPROMClass EEPROM;

#endif
