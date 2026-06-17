#include "link.h"
#include "../../character.h"
#include "../../ble_bridge.h"
#include "../../clawstick_config.h"
#include "../../stats.h"
#include "../../lang.h"
#include <M5StickCPlus.h>

extern TFT_eSprite spr;

namespace ui_link {

namespace {

const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_TEXT_DIM = 0x7BEF;
const uint16_t COL_ACCENT   = 0xFCE0;
const uint16_t COL_SUCCESS  = 0x07E0;
const uint16_t COL_DIVIDER  = 0x3186;

const int SCREEN_W = 135;
const int GIF_TOP  = 14;
const int GIF_BOT  = 134;

void drawStatusBar(uint8_t batPct) {
  for (int i = 0; i < 3; i++) {
    int cx = 8 + i * 8;
    spr.fillCircle(cx, 7, 2, i == 2 ? COL_ACCENT : COL_TEXT_DIM);
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

  uint16_t bleCol = bleSecure() ? COL_SUCCESS
                  : bleConnected() ? COL_ACCENT
                  : COL_TEXT_DIM;
  spr.fillCircle(SCREEN_W - 6, 7, 2, bleCol);
}

// One line: filled dot + state word, both same color. Dot diameter
// 6 px, gap 6 px, text size 2 main color. Subsumes plan §3.4's
// separate "LINK" + "MODE" rows by collapsing "linked vs standalone"
// into one sentence — they were the same fact in two costumes.
void drawLinkStateRow(int y) {
  bool sec  = bleSecure();
  bool conn = bleConnected();
  const char* word;
  uint16_t col;
  if (sec)        { word = L(S_LINK_LINKED);     col = COL_SUCCESS; }
  else if (conn)  { word = L(S_LINK_LINKING);    col = COL_ACCENT;  }
  else if (bleAdvertising()) { word = L(S_LINK_STANDALONE); col = COL_TEXT_DIM; }
  else            { word = L(S_LINK_OFF);        col = COL_TEXT_DIM; }

  spr.setTextSize(2);
  int textW = (int)strlen(word) * 12;
  const int dotR = 3;
  const int gap  = 6;
  int totalW = 2 * dotR + gap + textW;
  int leftX = (SCREEN_W - totalW) / 2;
  if (leftX < 4) leftX = 4;
  spr.fillCircle(leftX + dotR, y + 8, dotR, col);
  spr.setTextColor(col, COL_BG);
  spr.setCursor(leftX + 2 * dotR + gap, y);
  spr.print(word);
  spr.setTextSize(1);
}

// Peer identity, dim small caption under the state row. "—" when no
// peer (BLE off / standalone / no central bonded).
void drawPeerRow(int y) {
  bool conn = bleConnected();
  const char* peer = conn ? CLAWSTICK_COMPANION_NAME : "—";
  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  int w = (int)strlen(peer) * 6;
  int x = (SCREEN_W - w) / 2;
  spr.setCursor(x, y);
  spr.print(peer);
}

void drawPowerRow(int y, bool onUsb, bool charging) {
  const char* msg;
  uint16_t col;
  if (charging)   { msg = L(S_LINK_CHARGING); col = COL_ACCENT;  }
  else if (onUsb) { msg = L(S_LINK_ON_USB);   col = COL_SUCCESS; }
  else            { msg = L(S_LINK_BATTERY);  col = COL_TEXT_DIM; }

  spr.setTextSize(2);
  spr.setTextColor(col, COL_BG);
  int w = (int)strlen(msg) * 12;
  spr.setCursor((SCREEN_W - w) / 2, y);
  spr.print(msg);
  spr.setTextSize(1);
}

void drawCaption() {
  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(4, 230);
  spr.print(L(S_LINK_A_NEXT));
  const char* hint = L(S_LINK_B_RECONN);
  int hw = (int)strlen(hint) * 6;
  spr.setCursor(SCREEN_W - hw - 4, 230);
  spr.print(hint);
}

}  // namespace

void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool onUsb, bool charging) {
  (void)tama;

  // Region-based clears, same pattern as HOME/STATS so the shared GIF
  // canvas doesn't flicker between decoder ticks.
  spr.fillRect(0,   GIF_TOP, 7, GIF_BOT - GIF_TOP, COL_BG);
  spr.fillRect(127, GIF_TOP, 8, GIF_BOT - GIF_TOP, COL_BG);

  characterSetState(persona);
  characterTick();

  spr.fillRect(0, 0, SCREEN_W, GIF_TOP, COL_BG);
  drawStatusBar(batPct);

  // Lower info region (y=134..240). Layout:
  //   y=140        link state row (size 2)
  //   y=160        peer identity (size 1 dim)
  //   y=180        divider
  //   y=190        power source (size 2)
  //   y=230        caption
  spr.fillRect(0, GIF_BOT, SCREEN_W, 240 - GIF_BOT, COL_BG);

  drawLinkStateRow(140);
  drawPeerRow(160);

  spr.drawFastHLine(20, 180, SCREEN_W - 40, COL_DIVIDER);

  drawPowerRow(190, onUsb, charging);

  drawCaption();
}

}  // namespace ui_link
