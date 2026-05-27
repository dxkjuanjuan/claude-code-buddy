#include "settings.h"
#include <M5StickCPlus.h>
#include <string.h>

extern TFT_eSprite spr;

namespace ui_settings {
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
const int Y_LIST = 42;
const int ROW_H = 21;
const int Y_FOOTER_DIV = 210;
const int Y_FOOTER = 220;

const char* LABELS[] = {
  "brightness",
  "sound",
  "bluetooth",
  "led",
  "reset",
  "back",
};
static_assert(sizeof(LABELS) / sizeof(LABELS[0]) == kItemCount, "settings count mismatch");

void drawShell() {
  spr.fillSprite(COL_BG);
  spr.setTextSize(1);
  spr.setTextColor(COL_LABEL, COL_BG);
  spr.setCursor(PAD_X, Y_TITLE);
  spr.print("SETTINGS");
  spr.drawFastHLine(PAD_X, Y_DIV, CONTENT_W, COL_DIVIDER);

  spr.drawFastHLine(PAD_X, Y_FOOTER_DIV, CONTENT_W, COL_DIVIDER);
  spr.setTextColor(COL_DIM, COL_BG);
  spr.setCursor(PAD_X, Y_FOOTER);
  spr.print("A next");
  spr.setCursor(W - PAD_X - 8 * 6, Y_FOOTER);
  spr.print("B change");
}

void drawRow(uint8_t idx, const char* value, bool selected, bool danger = false) {
  int y = Y_LIST + idx * ROW_H;
  uint16_t bg = selected ? COL_ROW : COL_BG;
  if (selected) spr.fillRect(PAD_X - 2, y - 3, CONTENT_W + 4, 14, COL_ROW);

  spr.setTextSize(1);
  spr.setTextColor(selected ? (danger ? COL_ACCENT : COL_TEXT) : COL_DIM, bg);
  spr.setCursor(PAD_X, y);
  spr.print(selected ? "> " : "  ");
  spr.print(LABELS[idx]);

  if (!value || !value[0]) return;
  uint16_t valColor = COL_TEXT;
  if (strcmp(value, "on") == 0) valColor = COL_SUCCESS;
  if (strcmp(value, "off") == 0) valColor = COL_DIM;
  spr.setTextColor(selected ? valColor : COL_DIM, bg);
  int vw = (int)strlen(value) * 6;
  spr.setCursor(W - PAD_X - vw, y);
  spr.print(value);
}

}  // namespace

void render(uint8_t selected,
            uint8_t brightness,
            bool sound,
            bool bluetooth,
            bool led) {
  char bright[8];
  snprintf(bright, sizeof(bright), "%u/4", (unsigned int)brightness);

  drawShell();
  drawRow(0, bright, selected == 0);
  drawRow(1, sound ? "on" : "off", selected == 1);
  drawRow(2, bluetooth ? "on" : "off", selected == 2);
  drawRow(3, led ? "on" : "off", selected == 3);
  drawRow(4, "", selected == 4, true);
  drawRow(5, "", selected == 5);
}

}  // namespace ui_settings
