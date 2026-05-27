#include "stats.h"
#include "../../stats.h"
#include "../../character.h"
#include "../../ble_bridge.h"
#include <M5StickCPlus.h>

extern TFT_eSprite spr;

namespace ui_stats {

namespace {

// Plan §1.1 colors (RGB565). Hardcoded for the same reason as home.cpp.
const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_TEXT_DIM = 0x7BEF;
const uint16_t COL_ACCENT   = 0xFCE0;
const uint16_t COL_SUCCESS  = 0x07E0;
const uint16_t COL_DIVIDER  = 0x3186;

const int SCREEN_W = 135;
const int GIF_TOP  = 14;
const int GIF_BOT  = 134;

void drawStatusBar(uint8_t batPct, bool secureLink, bool charging) {
  for (int i = 0; i < 3; i++) {
    int cx = 8 + i * 8;
    spr.fillCircle(cx, 7, 2, i == 1 ? COL_ACCENT : COL_TEXT_DIM);
  }

  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  char bat[8];
  snprintf(bat, sizeof(bat), "%u%%", batPct);
  int bw = (int)strlen(bat) * 6;
  spr.setCursor(SCREEN_W - bw - 12, 3);
  spr.print(bat);

  // L3-5 mini clock; see home.cpp:drawStatusBar for the design rationale.
  char clk[8];
  bool synced = statsClockText(clk, sizeof(clk));
  if (!synced) snprintf(clk, sizeof(clk), "--:--");
  int cw = (int)strlen(clk) * 6;
  spr.setTextColor(synced ? COL_TEXT : COL_TEXT_DIM, COL_BG);
  spr.setCursor((SCREEN_W - cw) / 2, 3);
  spr.print(clk);

  uint16_t bleCol = secureLink ? COL_SUCCESS
                  : bleConnected() ? COL_ACCENT
                  : COL_TEXT_DIM;
  spr.fillCircle(SCREEN_W - 6, 7, 2, bleCol);
  (void)charging;
}

void drawLevel(uint16_t level) {
  uint16_t shown = level;
  bool overflow = level > 99;
  if (overflow) shown = 99;

  char buf[12];
  if (overflow) snprintf(buf, sizeof(buf), "Lv %u+", shown);
  else          snprintf(buf, sizeof(buf), "Lv %u",  shown);

  spr.setTextSize(2);
  spr.setTextColor(COL_TEXT, COL_BG);
  int textW = (int)strlen(buf) * 12;
  int x = (SCREEN_W - textW) / 2;
  if (x < 4) x = 4;
  spr.setCursor(x, 140);
  spr.print(buf);
  spr.setTextSize(1);
}

// Inline "mood" row: label left in size 1 dim, 4 dots right indicating
// mood tier 0..4. Inline (single 12-px row) rather than stacked (24 px)
// to make room for the counter rows beneath while keeping the GIF at
// full 120×120 above. Dot radius 3 keeps the right-side cluster slim.
void drawMoodInline(uint8_t tier) {
  if (tier > 4) tier = 4;
  const int y = 164;

  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(8, y);
  spr.print("mood");

  const int r       = 3;
  const int gap     = 11;                  // center-to-center
  const int totalW  = 3 * gap + 2 * r;     // 4 dots: 3 gaps + 2 outer radii
  const int xStart  = SCREEN_W - totalW - 8 + r;
  const int cy      = y + 3;               // visually centered with size-1 label
  for (int i = 0; i < 4; i++) {
    int cx = xStart + i * gap;
    if (i < tier) spr.fillCircle(cx, cy, r, COL_ACCENT);
    else          spr.drawCircle(cx, cy, r, COL_TEXT_DIM);
  }
}

// Inline "energy" row: label left, 6-cell bar right (8 px tall). Matches
// drawMoodInline geometry so the two indicator rows visually align.
void drawEnergyInline(uint8_t tier) {
  if (tier > 5) tier = 5;
  const int y = 178;

  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(8, y);
  spr.print("energy");

  const int cellW   = 10;
  const int gap     = 2;
  const int totalW  = 6 * cellW + 5 * gap;
  const int xStart  = SCREEN_W - totalW - 8;
  const int barY    = y;
  const int barH    = 8;
  for (int i = 0; i < 6; i++) {
    int x = xStart + i * (cellW + gap);
    if (i < tier) spr.fillRect(x, barY, cellW, barH, COL_ACCENT);
    else          spr.drawRect(x, barY, cellW, barH, COL_TEXT_DIM);
  }
}

// napSecondsTotal → max-5-char string (plan §3.3 mockup used "3h21m";
// extended past 100h via days so the counter row doesn't overflow when
// the device has been owned a long time).
void formatNap(uint32_t sec, char* out, size_t n) {
  if (sec >= 360000) {                  // 100h+
    uint32_t d = sec / 86400;
    snprintf(out, n, "%lud", (unsigned long)d);
  } else if (sec >= 3600) {
    uint32_t h = sec / 3600;
    uint32_t m = (sec % 3600) / 60;
    snprintf(out, n, "%luh%02lu", (unsigned long)h, (unsigned long)m);
  } else if (sec >= 60) {
    uint32_t m = sec / 60;
    snprintf(out, n, "%lum", (unsigned long)m);
  } else {
    snprintf(out, n, "%lus", (unsigned long)sec);
  }
}

// One row of two counter cells, each "label value". Size 1 throughout —
// plan §1.2's size-2 floor for main info is violated here, but the four
// NVS counters are reference data not primary signals, and the
// alternative (4-row size-2 stack) collides with both the GIF above and
// the caption below. Treating these as auxiliary references aligns with
// how mockups in plan §3.3 group them below the mood/energy bands.
void drawCounterRow(const char* labelA, const char* valueA,
                    const char* labelB, const char* valueB, int y) {
  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);

  // Left cell
  spr.setCursor(8, y);
  spr.print(labelA);
  int labW = (int)strlen(labelA) * 6;
  spr.setCursor(8 + labW + 4, y);
  spr.setTextColor(COL_TEXT, COL_BG);
  spr.print(valueA);

  // Right cell, value right-aligned to x=SCREEN_W-8
  int valBW = (int)strlen(valueB) * 6;
  int labBW = (int)strlen(labelB) * 6;
  int valX  = SCREEN_W - 8 - valBW;
  int labX  = valX - 4 - labBW;
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(labX, y);
  spr.print(labelB);
  spr.setTextColor(COL_TEXT, COL_BG);
  spr.setCursor(valX, y);
  spr.print(valueB);
}

void drawCaption() {
  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(4, 230);
  spr.print("A >");
}

}  // namespace

void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool secureLink, bool charging) {
  (void)tama;

  // Region-based clears mirror home.cpp; see its comment for why
  // fillSprite would flicker the GIF.
  spr.fillRect(0,   GIF_TOP, 7, GIF_BOT - GIF_TOP, COL_BG);
  spr.fillRect(127, GIF_TOP, 8, GIF_BOT - GIF_TOP, COL_BG);

  characterSetState(persona);
  characterTick();

  spr.fillRect(0, 0, SCREEN_W, GIF_TOP, COL_BG);
  drawStatusBar(batPct, secureLink, charging);

  // Lower info region (y=134..240). Cleared as one band; layout:
  //   y=140..156   Lv (size 2)
  //   y=158        divider
  //   y=164        mood inline
  //   y=178        energy inline
  //   y=192        divider
  //   y=200        counter row 1 (approved / denied)
  //   y=212        counter row 2 (napped / shakes)
  //   y=230        caption
  spr.fillRect(0, GIF_BOT, SCREEN_W, 240 - GIF_BOT, COL_BG);

  drawLevel(statsLevel());

  spr.drawFastHLine(20, 158, SCREEN_W - 40, COL_DIVIDER);
  drawMoodInline(statsMoodTier());
  drawEnergyInline(statsEnergyTier());

  spr.drawFastHLine(20, 192, SCREEN_W - 40, COL_DIVIDER);

  char vA[8], vB[8];
  snprintf(vA, sizeof(vA), "%u", statsApprovals());
  snprintf(vB, sizeof(vB), "%u", statsDenials());
  drawCounterRow("appr", vA, "deny", vB, 200);

  formatNap(statsNapSecondsTotal(), vA, sizeof(vA));
  snprintf(vB, sizeof(vB), "%u", statsTotalShakes());
  drawCounterRow("nap", vA, "shake", vB, 212);

  drawCaption();
}

}  // namespace ui_stats
