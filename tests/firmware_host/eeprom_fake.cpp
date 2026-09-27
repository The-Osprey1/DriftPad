// Flash sector behind the host EEPROM library stand-in (EEPROM.h), with power-cut injection.
#include <cstring>
#include "EEPROM.h"

EEPROMClass EEPROM;

namespace {
uint8_t  s_sector[4096];
bool     s_init = false;
uint32_t s_commits = 0;
int32_t  s_cutAfterBytes = -1;   // next commit: erase, then only this many bytes, then power loss
bool     s_powerLost = false;
}

extern "C" {

uint8_t* eeprom_fake_sector() {
    if (!s_init) {
        memset(s_sector, 0xFF, sizeof(s_sector));   // erased flash
        s_init = true;
    }
    return s_sector;
}

void eeprom_fake_commit(const uint8_t* data, size_t size) {
    if (s_powerLost) return;            // nothing happens after the power is gone
    uint8_t* sector = eeprom_fake_sector();
    memset(sector, 0xFF, 4096);         // flash_range_erase(sector)
    size_t n = size;
    if (s_cutAfterBytes >= 0) {
        if ((size_t)s_cutAfterBytes < n) n = (size_t)s_cutAfterBytes;
        s_cutAfterBytes = -1;
        s_powerLost = true;
    }
    memcpy(sector, data, n);            // flash_range_program(sector, data, size)
    s_commits++;
}

uint32_t eeprom_fake_commits() { return s_commits; }
void eeprom_fake_erase() { memset(eeprom_fake_sector(), 0xFF, 4096); s_commits = 0; s_cutAfterBytes = -1; s_powerLost = false; }
void eeprom_fake_cut_next_commit(int32_t bytes) { s_cutAfterBytes = bytes; }
void eeprom_fake_power_on() { s_powerLost = false; s_cutAfterBytes = -1; }

}
