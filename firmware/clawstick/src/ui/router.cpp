#include "router.h"
#include "screens/home.h"
#include "screens/stats.h"
#include "screens/link.h"

namespace ui_router {

namespace {
Card g_current = CARD_HOME;
}

void next() {
  g_current = (Card)((g_current + 1) % CARD_COUNT);
}

Card current() { return g_current; }

void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool secureLink, bool onUsb, bool charging,
            const char* owner, const char* petname) {
  switch (g_current) {
    case CARD_STATS:
      ui_stats::render(tama, persona, batPct, secureLink, charging);
      break;
    case CARD_LINK:
      ui_link::render(tama, persona, batPct, onUsb, charging);
      break;
    case CARD_HOME:
    default:
      ui_home::render(tama, persona, batPct, secureLink, charging, owner, petname);
      break;
  }
}

}  // namespace ui_router
