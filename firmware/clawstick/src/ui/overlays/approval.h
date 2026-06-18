#pragma once
#include <stdint.h>
#include "../../data.h"

namespace ui_approval {

// Maximum choices the overlay can display.
static constexpr uint8_t kMaxChoices = 4;

void render(const TamaState& tama,
            uint32_t promptArrivedMs,
            bool responseSent,
            uint8_t choiceSel);

}  // namespace ui_approval
