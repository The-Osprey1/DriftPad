#include "screensaver_player.h"

namespace {
screensaver::Player player;
}

extern "C" {
void ss_player_start(uint32_t now, int8_t selected, uint32_t seed) {
    player.start(now, selected, seed);
}
void ss_player_advance(uint32_t now) { player.advance(now); }
int ss_player_shown() { return player.shown(); }
int ss_player_incoming() { return player.incoming(); }
int ss_player_target() { return player.target(); }
int ss_player_shuffled() { return player.shuffled() ? 1 : 0; }
uint32_t ss_player_transition_elapsed(uint32_t now) { return player.transitionElapsed(now); }
uint32_t ss_player_label_age(uint32_t now) { return player.labelAge(now); }
}
