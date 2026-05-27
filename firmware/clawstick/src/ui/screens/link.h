#pragma once
#include <stdint.h>
#include "../../data.h"

// LINK card (plan §3.4, post-2026-05-22 revision). Originally a system-
// info card with size-4 battery headline; reshaped after Plus2 review:
//   - GIF on top so all three main cards keep the character visible
//   - battery headline dropped (status bar already shows %)
//   - LINK + MODE rows collapsed into one "linked / standalone" row +
//     a dim peer-name line (the two concepts overlap in today's
//     firmware — there's only "BLE bonded or not", no third mode yet)
//   - power source row stays since the status bar still doesn't carry
//     a charging glyph
//
// state of the GIF is kept in lockstep with HOME/STATS so cycling
// cards via L3-4's router won't pop the character.

namespace ui_link {

void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool onUsb, bool charging);

}  // namespace ui_link
