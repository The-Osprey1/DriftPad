// Flash sector behind the host EEPROM library stand-in (EEPROM.h).
#include <cstring>
#include "EEPROM.h"

EEPROMClass EEPROM;

namespace {
uint8_t  s_sector[4096];
bool     s_init = false;
uint32_t s_commits = 0;
}

extern "C" {

uint8_t* eeprom_fake_sector() {
    if (!s_init) {
        memset(s_sector, 0xFF, sizeof(s_sector));   // erased flash
        s_init = true;
    }
    return s_sector;
}

void eeprom_fake_note_commit() { s_commits++; }
uint32_t eeprom_fake_commits() { return s_commits; }
void eeprom_fake_erase() { memset(eeprom_fake_sector(), 0xFF, 4096); s_commits = 0; }

}
