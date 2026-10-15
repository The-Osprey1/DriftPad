#ifndef DISPLAY_PUBLISH_H
#define DISPLAY_PUBLISH_H

#include "display_link.h"

/**
 * @file display_publish.h
 * @brief Core 0 side of the display snapshot: what core 1 may draw, taken from the sensing
 * engine and the settings right after a scan.
 */

// Fills `out` from HallManager, HallKey and the settings (core 0 only).
void displayBuildSnapshot(display_link::Snapshot& out);
// Builds and publishes the snapshot (core 0, after each scan).
void displayPublish();

#endif // DISPLAY_PUBLISH_H
