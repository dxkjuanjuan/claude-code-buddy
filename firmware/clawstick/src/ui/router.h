#pragma once
#include <stdint.h>
#include "../data.h"

// Main card router (plan §3.1). Holds the currently-visible card and
// dispatches render() to the matching screen. A-short on a main card
// calls ui_router::next() to cycle HOME → STATS → LINK → HOME.
//
// The router does NOT touch the character GIF on card swap. Each
// screen calls characterSetState() with the same PersonaState every
// frame; if it matches curState the call short-circuits and the GIF
// keeps playing uninterrupted. This is why card cycling looks smooth
// instead of stuttering on the character.

namespace ui_router {

enum Card : uint8_t {
  CARD_HOME  = 0,
  CARD_STATS = 1,
  CARD_LINK  = 2,
  CARD_COUNT = 3
};

void next();
Card current();

void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool secureLink, bool onUsb, bool charging,
            const char* owner, const char* petname);

}  // namespace ui_router
