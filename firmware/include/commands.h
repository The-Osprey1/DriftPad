#ifndef COMMANDS_H
#define COMMANDS_H

#include <cstdint>
#include "calibration.h"
#include "protocol.h"
#include "timing.h"
#include "tx_queue.h"

/**
 * @file commands.h
 * @brief The serial command set (protocol v2, docs/serial-protocol.md) and the output it streams.
 *
 * main.cpp owns the loop; this module owns the command table, its handlers, and the unsolicited
 * output that commands start (telemetry frames, RAW capture chunks). Core 0 only.
 */
namespace commands {

void init(proto::TxQueue& tx, Timing& timing);

// After calibration was restored at power-up: records the report (INFO) and decides keyboard
// output. Output starts enabled only with valid calibration and boot output (standalone mode) on;
// keys held at power-up are suppressed until they are seen at rest.
void onBoot(const BootReport& report);

const proto::CommandDef* table();
uint8_t tableSize();

// Once per scan, after HallManager::updateAll(): feeds guided calibration and RAW capture
void onScan();

// Background slice: at most one telemetry frame or one RAW chunk, only if the TX queue has room
void service(uint32_t nowMs);

// The host dropped DTR: stop streaming and captures started by the old session
void onHostDisconnected();

// Queues the one-time boot event (identity, settings source, output state)
void queueBootEvent();

bool streaming();

// True once after BOOTSEL was accepted: main flushes the reply, then reboots to the bootloader
bool takeBootselRequest();

// True while a command has changed settings that neither SAVE nor REVERT has settled since. The
// encoder's delayed save leaves those to the user instead of committing them with a knob turn.
bool hostEditsUnsaved();

} // namespace commands

#endif // COMMANDS_H
