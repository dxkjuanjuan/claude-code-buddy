#include "approval.h"
#include "../../clawstick_config.h"
#include "../../lang.h"
#include <M5StickCPlus.h>
#include <string.h>

extern TFT_eSprite spr;

namespace ui_approval {

namespace {

// Plan §1.1 colors (RGB565). Approval is full-screen so it doesn't
// borrow from the character palette — character.cpp manifests may
// theme accent/body, but the approval overlay must stay readable
// independent of which mascot is installed.
const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_TEXT_DIM = 0x7BEF;
const uint16_t COL_LABEL    = 0xBDF7;
const uint16_t COL_DIVIDER  = 0x3186;
const uint16_t COL_SUCCESS  = 0x07E0;
const uint16_t COL_HOT      = 0xFA20;

const int W = 135;
const int H = 240;
const int PAD_X = 8;
const int CONTENT_W = W - 2 * PAD_X;   // 119 px

const int Y_TITLE       = 6;
const int Y_TITLE_DIV   = 22;
const int Y_TOOL_LABEL  = 34;
const int Y_TOOL_TEXT   = 48;
const int Y_HINT_LABEL  = 78;
const int Y_HINT_TEXT   = 92;
const int Y_FOOTER_DIV  = 208;
const int Y_FOOTER      = 218;

// Marquee: glyph speed (px per second) chosen so a 32-char tool name
// (~ 384 px wide at size 2) makes one full loop in ≈ 9 s — slow enough
// to read, not slow enough to feel stuck.
const int      MARQUEE_GAP        = 30;
const uint32_t MARQUEE_MS_PER_PX  = 35;
const int      SIZE1_CHAR_W       = 6;
const int      SIZE1_LINE_H       = 10;

void drawTick(int x, int y, uint16_t col) {
  // 6 px wide check mark. Two line segments forming a "✓":
  //   (0,3)-(2,5)  short bottom-left rising
  //   (2,5)-(6,1)  long upper-right rising
  spr.drawLine(x,     y + 3, x + 2, y + 5, col);
  spr.drawLine(x + 1, y + 3, x + 2, y + 4, col);   // thicken
  spr.drawLine(x + 2, y + 5, x + 6, y + 1, col);
  spr.drawLine(x + 2, y + 4, x + 6, y,     col);   // thicken
}

void drawCross(int x, int y, uint16_t col) {
  // 6 px wide "✗": two diagonals, 2-pixel-thick.
  spr.drawLine(x,     y,     x + 6, y + 6, col);
  spr.drawLine(x + 1, y,     x + 6, y + 5, col);
  spr.drawLine(x + 6, y,     x,     y + 6, col);
  spr.drawLine(x + 5, y,     x,     y + 5, col);
}

void drawTitleRow(uint32_t waited) {
  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(PAD_X, Y_TITLE);
  spr.print(L(S_APPROVAL_AGENT_ASKS));

  // Countdown switches to red once user has had >= 10 s to decide.
  // Plan §3.6: "size 2 倒计时" — but at 135 px wide size 2 already
  // uses 24 px for "Xs" and 120 px for "agent asks", which overflows.
  // Compromise: title and countdown both size 1, countdown changes
  // *color* (not size) at the 10 s threshold so the visual signal is
  // delivered without breaking layout. Plan mockup also draws them on
  // the same line, which size-1 supports cleanly.
  char count[8];
  snprintf(count, sizeof(count), "%us", (unsigned int)waited);
  int cw = (int)strlen(count) * 6;
  spr.setTextColor(waited >= 10 ? COL_HOT : COL_TEXT_DIM, COL_BG);
  spr.setCursor(W - PAD_X - cw, Y_TITLE);
  spr.print(count);

  spr.drawFastHLine(PAD_X + 20, Y_TITLE_DIV, CONTENT_W - 40, COL_DIVIDER);
}

void drawSectionLabel(const char* label, int y) {
  spr.setTextSize(1);
  spr.setTextColor(COL_LABEL, COL_BG);
  spr.setCursor(PAD_X, y);
  spr.print(label);
  spr.drawFastHLine(PAD_X, y + 11, CONTENT_W, COL_DIVIDER);
}

void drawMarqueeLine(const char* text, int y, uint16_t color) {
  spr.setTextSize(1);
  spr.setTextColor(color, COL_BG);
  int textW = spr.textWidth(text);
  uint32_t period = (uint32_t)textW + MARQUEE_GAP;
  uint32_t offset = (millis() / MARQUEE_MS_PER_PX) % period;

  spr.setTextDatum(TL_DATUM);
  spr.setCursor(PAD_X - (int)offset, y);
  spr.print(text);
  spr.setCursor(PAD_X - (int)offset + textW + MARQUEE_GAP, y);
  spr.print(text);

  spr.fillRect(0,                 y - 1, PAD_X,                 11, COL_BG);
  spr.fillRect(PAD_X + CONTENT_W, y - 1, W - PAD_X - CONTENT_W, 11, COL_BG);
}

void drawToolName(const char* tool) {
  drawSectionLabel(L(S_APPROVAL_TOOL), Y_TOOL_LABEL);
  if (!tool || !tool[0]) return;

  spr.setTextSize(1);
  int textW = spr.textWidth(tool);
  spr.setTextColor(COL_TEXT, COL_BG);
  if (textW <= CONTENT_W) {
    spr.setTextDatum(TC_DATUM);
    spr.drawString(tool, W / 2, Y_TOOL_TEXT);
    spr.setTextDatum(TL_DATUM);
    return;
  }

  drawMarqueeLine(tool, Y_TOOL_TEXT, COL_TEXT);
}

void printHintLine(const char* hint, int start, int len, int y, bool ellipsis) {
  char line[24];
  if (len > 20) len = 20;
  if (len < 0) len = 0;
  memcpy(line, hint + start, (size_t)len);
  line[len] = '\0';
  while (len > 0 && line[len - 1] == ' ') {
    line[--len] = '\0';
  }
  if (ellipsis && len >= 3) {
    line[len - 3] = '.';
    line[len - 2] = '.';
    line[len - 1] = '.';
  }
  spr.setCursor(PAD_X, y);
  spr.print(line);
}

void drawHintRow(const char* hint) {
  drawSectionLabel(L(S_APPROVAL_DETAIL), Y_HINT_LABEL);
  if (!hint || !hint[0]) return;

  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);

  const int maxChars = CONTENT_W / SIZE1_CHAR_W;
  const int maxLines = 8;
  int len = (int)strlen(hint);
  int pos = 0;
  int lineNo = 0;

  while (pos < len && lineNo < maxLines) {
    while (pos < len && hint[pos] == ' ') pos++;
    int remaining = len - pos;
    int take = remaining < maxChars ? remaining : maxChars;
    int breakAt = -1;

    if (remaining > maxChars) {
      for (int i = take - 1; i > 4; --i) {
        if (hint[pos + i] == ' ') {
          breakAt = i;
          break;
        }
      }
      if (breakAt > 0) take = breakAt;
    }

    bool clipped = (lineNo == maxLines - 1) && (pos + take < len);
    printHintLine(hint, pos, take, Y_HINT_TEXT + lineNo * SIZE1_LINE_H, clipped);
    pos += take;
    lineNo++;
  }
}

void drawFooterAllowDeny() {
  spr.drawFastHLine(PAD_X, Y_FOOTER_DIV, CONTENT_W, COL_DIVIDER);

  spr.setTextSize(1);

  // ✓ A allow (green) on the left.
  drawTick(PAD_X, Y_FOOTER + 1, COL_SUCCESS);
  spr.setTextColor(COL_SUCCESS, COL_BG);
  spr.setCursor(PAD_X + 10, Y_FOOTER + 2);
  spr.print(L(S_APPROVAL_A_ALLOW));

  // ✗ B deny (red) on the right.
  spr.setTextColor(COL_HOT, COL_BG);
  const char* deny = L(S_APPROVAL_B_DENY);
  int dw = (int)strlen(deny) * 6;
  int denyX = W - PAD_X - dw;
  spr.setCursor(denyX, Y_FOOTER + 2);
  spr.print(deny);
  drawCross(denyX - 10, Y_FOOTER + 1, COL_HOT);
}

void drawSent() {
  spr.setTextSize(2);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setTextDatum(MC_DATUM);
  spr.drawString(L(S_APPROVAL_SENT), W / 2, H / 2);
  spr.setTextDatum(TL_DATUM);
}

}  // namespace

void render(const TamaState& tama,
            uint32_t promptArrivedMs,
            bool responseSent) {
  // Approval is full-screen and prompts arrive sparsely (not 60 fps),
  // so a whole-sprite clear per frame is cheap and avoids the
  // region-tracking that the HOME card needs because of the GIF
  // tick cadence.
  spr.fillSprite(COL_BG);

  if (responseSent) {
    drawSent();
    return;
  }

  uint32_t waited = (millis() - promptArrivedMs) / 1000;
  drawTitleRow(waited);
  drawToolName(tama.promptTool);
  drawHintRow(tama.promptHint);
  drawFooterAllowDeny();
}

}  // namespace ui_approval
