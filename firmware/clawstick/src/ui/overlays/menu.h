#pragma once
#include <stdint.h>

namespace ui_menu {

static constexpr uint8_t kItemCount = 5;

void renderMenu(uint8_t selected, bool powerArmed);
void renderAbout(const char* deviceName,
                 const char* owner,
                 const char* petname,
                 bool secureLink);

}  // namespace ui_menu
