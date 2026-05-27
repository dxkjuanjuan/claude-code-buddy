#include "reset.h"
#include <M5StickCPlus.h>
#include <string.h>

extern TFT_eSprite spr;

namespace ui_reset {
namespace {

const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_DIM      = 0x7BEF;
const uint16_t COL_LABEL    = 0xBDF7;
const uint16_t COL_HOT      = 0xFA20;
const uint16_t COL_DIVIDER  = 0x3186;
const uint16_t COL_ROW      = 0x2945;

const int W = 135;
const int PAD_X = 8;
const int CONTENT_W = W - 2 * PAD_X;
const int Y_TITLE = 8;
const int Y_DIV = 26;
const int Y_LIST = 58;
const int ROW_H = 24;
const int Y_FOOTER_DIV = 210;
const int Y_FOOTER = 220;

const char* ITEMS[] = {
  "delete char",
  "factory reset",
  "back",
};
static_assert(sizeof(ITEMS) / sizeof(ITEMS[0]) == kItemCount, "reset count mismatch");

void drawShell() {
  spr.fillSprite(COL_BG);
  spr.setTextSize(1);
  spr.setTextColor(COL_LABEL, COL_BG);
  spr.setCursor(PAD_X, Y_TITLE);
  spr.print("RESET");
  spr.setTextColor(COL_DIM, COL_BG);
  spr.setCursor(PAD_X, 30);
  spr.print("press B twice");
  spr.drawFastHLine(PAD_X, Y_DIV, CONTENT_W, COL_DIVIDER);

  spr.drawFastHLine(PAD_X, Y_FOOTER_DIV, CONTENT_W, COL_DIVIDER);
  spr.setTextColor(COL_DIM, COL_BG);
  spr.setCursor(PAD_X, Y_FOOTER);
  spr.print("A next");
  spr.setCursor(W - PAD_X - 9 * 6, Y_FOOTER);
  spr.print("B confirm");
}

void drawRow(uint8_t idx, bool selected, bool armed) {
  int y = Y_LIST + idx * ROW_H;
  uint16_t bg = selected ? COL_ROW : COL_BG;
  if (selected) spr.fillRect(PAD_X - 2, y - 3, CONTENT_W + 4, 14, COL_ROW);
  spr.setTextSize(1);
  spr.setTextColor(armed ? COL_HOT : (selected ? COL_TEXT : COL_DIM), bg);
  spr.setCursor(PAD_X, y);
  spr.print(selected ? "> " : "  ");
  spr.print(armed ? "really?" : ITEMS[idx]);
}

}  // namespace

void render(uint8_t selected, uint8_t armedIndex, uint32_t armedUntilMs) {
  drawShell();
  uint32_t now = millis();
  for (uint8_t i = 0; i < 3; ++i) {
    bool armed = (i == armedIndex) && (int32_t)(now - armedUntilMs) < 0;
    drawRow(i, selected == i, armed);
  }
}

}  // namespace ui_reset
