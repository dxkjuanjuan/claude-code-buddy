#pragma once
#include <stdint.h>
#include "../../data.h"

// HOME card (plan §3.2). Renders the status bar, the Clawd GIF, the
// owner+pet name block, the state + sessions rows, and the bottom
// caption into the global sprite. Caller is expected to push the
// sprite to the LCD afterwards (overlays may layer on top first).
//
// owner / petname are passed in (not pulled from stats.h) so this TU
// doesn't trigger a second static-storage instance of the stats/
// settings/owner/petname globals. stats.h's static defs would otherwise
// give every TU its own zero-initialized copy — home would read empty
// strings while main wrote into its own copy.

namespace ui_home {

// persona is a fork PersonaState (0..6); character.cpp maps it to the
// 5-state Clawd asset set internally.
void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool secureLink, bool charging,
            const char* owner, const char* petname);

}  // namespace ui_home
