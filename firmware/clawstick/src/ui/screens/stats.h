#pragma once
#include <stdint.h>
#include "../../data.h"

// STATS card (plan §3.3 method B). Post-L3-2 visual review the card was
// reshaped around the Clawd GIF the same way HOME is: GIF on top so the
// character is present on every main card, then 养成 indicators (level /
// mood / energy) plus the four NVS counters underneath. Counter rows
// (appr/deny/nap/shake) are rendered as two size-1 inline pairs — plan
// §1.2's size-2 floor is intentionally violated here because four
// size-2 rows under a 120-tall GIF would push the caption off-screen.
// User-approved exception, see L3-2 commit message.

namespace ui_stats {

// persona is a fork PersonaState (0..6); STATS keeps the GIF in lockstep
// with HOME so toggling cards doesn't pop the character.
void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool secureLink, bool charging);

}  // namespace ui_stats
