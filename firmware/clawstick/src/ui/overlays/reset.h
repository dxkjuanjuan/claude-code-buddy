#pragma once
#include <stdint.h>

namespace ui_reset {

static constexpr uint8_t kItemCount = 3;

void render(uint8_t selected, uint8_t armedIndex, uint32_t armedUntilMs);

}  // namespace ui_reset
