#include "menu.h"
#include "../../clawstick_config.h"
#include "../../lang.h"
#include <M5StickCPlus.h>
#include <string.h>

extern TFT_eSprite spr;

namespace ui_menu {
namespace {

const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_DIM      = 0x7BEF;
const uint16_t COL_LABEL    = 0xBDF7;
const uint16_t COL_ACCENT   = 0xFA20;
const uint16_t COL_DIVIDER  = 0x3186;
const uint16_t COL_ROW      = 0x2945;
const uint16_t COL_SUCCESS  = 0x07E0;

const int W = 135;
const int PAD_X = 8;
const int CONTENT_W = W - 2 * PAD_X;
const int Y_TITLE = 8;
const int Y_DIV = 26;
const int Y_LIST = 46;
const int ROW_H = 18;
const int Y_FOOTER_DIV = 210;
const int Y_FOOTER = 220;

const char* MENU_ITEMS[] = {
  "S_MENU_SETTINGS",
  "S_MENU_SLEEP",
  "S_MENU_ABOUT",
  "S_MENU_POWER_OFF",
  "S_MENU_CLOSE",
};

void drawShell(const char* title, const char* left, const char* right) {
  spr.fillSprite(COL_BG);
  spr.setTextSize(1);
  spr.setTextColor(COL_LABEL, COL_BG);
  spr.setCursor(PAD_X, Y_TITLE);
  spr.print(title);
  spr.drawFastHLine(PAD_X, Y_DIV, CONTENT_W, COL_DIVIDER);

  spr.drawFastHLine(PAD_X, Y_FOOTER_DIV, CONTENT_W, COL_DIVIDER);
  spr.setTextColor(COL_DIM, COL_BG);
  spr.setCursor(PAD_X, Y_FOOTER);
  spr.print(left);
  int rw = (int)strlen(right) * 6;
  spr.setCursor(W - PAD_X - rw, Y_FOOTER);
  spr.print(right);
}

void drawRow(int y, const char* label, bool selected, bool danger = false) {
  if (selected) spr.fillRect(PAD_X - 2, y - 3, CONTENT_W + 4, 14, COL_ROW);
  spr.setTextSize(1);
  spr.setTextColor(selected ? (danger ? COL_ACCENT : COL_TEXT) : COL_DIM,
                   selected ? COL_ROW : COL_BG);
  spr.setCursor(PAD_X, y);
  spr.print(selected ? "> " : "  ");
  spr.print(label);
}

void drawInfoLine(const char* label, const char* value, int y, uint16_t color = COL_TEXT) {
  spr.setTextSize(1);
  spr.setTextColor(COL_DIM, COL_BG);
  spr.setCursor(PAD_X, y);
  spr.print(label);
  spr.setTextColor(color, COL_BG);
  spr.setCursor(PAD_X, y + 10);
  spr.print(value && value[0] ? value : "-");
}

}  // namespace

void renderMenu(uint8_t selected, bool powerArmed) {
  drawShell(L(S_MENU_TITLE), L(S_MENU_A_NEXT), L(S_MENU_B_SELECT));
  const char* labels[] = {
    L(S_MENU_SETTINGS), L(S_MENU_SLEEP), L(S_MENU_ABOUT), L(S_MENU_POWER_OFF), L(S_MENU_CLOSE),
  };
  for (uint8_t i = 0; i < kItemCount; ++i) {
    drawRow(Y_LIST + i * ROW_H,
            (i == 3 && powerArmed) ? L(S_MENU_REALLY) : labels[i],
            i == selected,
            i == 3);
  }
}

void renderAbout(const char* deviceName,
                 const char* owner,
                 const char* petname,
                 bool secureLink) {
  drawShell(L(S_MENU_ABOUT_TITLE), L(S_MENU_A_BACK), L(S_MENU_B_BACK));
  drawInfoLine(L(S_MENU_PRODUCT), CLAWSTICK_PRODUCT_NAME, 42);
  drawInfoLine(L(S_MENU_DEVICE), deviceName, 66, secureLink ? COL_SUCCESS : COL_TEXT);
  drawInfoLine(L(S_MENU_OWNER), owner, 90);
  drawInfoLine(L(S_MENU_PET), petname, 114);

  spr.setTextSize(1);
  spr.setTextColor(COL_DIM, COL_BG);
  spr.setCursor(PAD_X, 148);
  spr.print(L(S_MENU_HELP_A));
  spr.setCursor(PAD_X, 160);
  spr.print(L(S_MENU_HELP_B));
  spr.setCursor(PAD_X, 172);
  spr.print(L(S_MENU_HELP_HOLD));
}

}  // namespace ui_menu
