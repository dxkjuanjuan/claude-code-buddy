#pragma once
#include <stdint.h>

namespace ui_settings {

static constexpr uint8_t kItemCount = 7;  // bright, sound, bt, led, lang, reset, back

void render(uint8_t selected,
            uint8_t brightness,
            bool sound,
            bool bluetooth,
            bool led);

}  // namespace ui_settings
