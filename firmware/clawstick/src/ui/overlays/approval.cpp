#include "approval.h"
#include "../../clawstick_config.h"
#include <M5StickCPlus.h>
#include <string.h>

extern TFT_eSprite spr;

namespace ui_approval {

namespace {

const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_TEXT_DIM = 0x7BEF;
const uint16_t COL_LABEL    = 0xBDF7;
const uint16_t COL_DIVIDER  = 0x3186;
const uint16_t COL_SUCCESS  = 0x07E0;
const uint16_t COL_HOT      = 0xFA20;
const uint16_t COL_ROW_SEL  = 0x2945;

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
const int Y_CHOICES     = 192;
const int CHOICE_ROW_H  = 18;
const int Y_FOOTER_DIV  = 208;
const int Y_FOOTER      = 218;

const int      MARQUEE_GAP        = 30;
const uint32_t MARQUEE_MS_PER_PX  = 35;
const int      SIZE1_CHAR_W       = 6;
const int      SIZE1_LINE_H       = 10;

void drawTitleRow(uint32_t waited, const TamaState& tama) {
  spr.setTextSize(1);

  // Show "#N projectname" when session identity is available
  if (tama.promptSessionIdx < tama.sessionCount) {
    const SessionInfo& si = tama.sessions[tama.promptSessionIdx];
    char label[24];
    snprintf(label, sizeof(label), "#%u %s", (unsigned)(tama.promptSessionIdx + 1), si.title);
    spr.setTextColor(COL_TEXT, COL_BG);
    spr.setCursor(PAD_X, Y_TITLE);
    spr.print(label);
  } else {
    spr.setTextColor(COL_TEXT_DIM, COL_BG);
    spr.setCursor(PAD_X, Y_TITLE);
    spr.print(CLAWSTICK_APPROVAL_TITLE);
  }

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
  drawSectionLabel("TOOL", Y_TOOL_LABEL);
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
  drawSectionLabel("DETAIL", Y_HINT_LABEL);
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

// Draw choices list. A scrolls up/down, B confirms.
void drawChoices(const TamaState& tama, uint8_t sel) {
  uint8_t n = tama.promptChoiceCount;
  if (n == 0) return;

  // Choices start at Y_CHOICES and extend upward if many.
  // Calculate start y so choices are bottom-anchored near Y_FOOTER_DIV.
  int startY = Y_FOOTER_DIV - n * CHOICE_ROW_H;

  for (uint8_t i = 0; i < n; i++) {
    int y = startY + i * CHOICE_ROW_H;
    bool selected = (i == sel);

    if (selected) {
      spr.fillRect(PAD_X - 2, y - 2, CONTENT_W + 4, CHOICE_ROW_H - 2, COL_ROW_SEL);
    }

    spr.setTextSize(1);
    spr.setTextColor(selected ? COL_TEXT : COL_TEXT_DIM, selected ? COL_ROW_SEL : COL_BG);
    spr.setCursor(PAD_X, y);
    spr.print(selected ? "> " : "  ");
    spr.print(tama.promptChoices[i]);
  }
}

// Legacy footer: no choices available, show A:allow B:deny
void drawFooterAllowDeny() {
  spr.drawFastHLine(PAD_X, Y_FOOTER_DIV, CONTENT_W, COL_DIVIDER);

  spr.setTextSize(1);

  // A allow (green) on the left.
  spr.setTextColor(COL_SUCCESS, COL_BG);
  spr.setCursor(PAD_X, Y_FOOTER + 2);
  spr.print("A: allow");

  // B deny (red) on the right.
  spr.setTextColor(COL_HOT, COL_BG);
  const char* deny = "B: deny";
  int dw = (int)strlen(deny) * 6;
  spr.setCursor(W - PAD_X - dw, Y_FOOTER + 2);
  spr.print(deny);
}

// Choices mode footer: A:up/down B:confirm
void drawFooterChoices() {
  spr.drawFastHLine(PAD_X, Y_FOOTER_DIV, CONTENT_W, COL_DIVIDER);

  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(PAD_X, Y_FOOTER + 2);
  spr.print("A: select");
  const char* right = "B: confirm";
  int rw = (int)strlen(right) * 6;
  spr.setCursor(W - PAD_X - rw, Y_FOOTER + 2);
  spr.print(right);
}

void drawSent() {
  spr.setTextSize(2);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setTextDatum(MC_DATUM);
  spr.drawString("sent...", W / 2, H / 2);
  spr.setTextDatum(TL_DATUM);
}

}  // namespace

void render(const TamaState& tama,
            uint32_t promptArrivedMs,
            bool responseSent,
            uint8_t choiceSel) {
  spr.fillSprite(COL_BG);

  if (responseSent) {
    drawSent();
    return;
  }

  uint32_t waited = (millis() - promptArrivedMs) / 1000;
  drawTitleRow(waited, tama);
  drawToolName(tama.promptTool);
  drawHintRow(tama.promptHint);

  if (tama.promptChoiceCount > 0) {
    drawChoices(tama, choiceSel);
    drawFooterChoices();
  } else {
    drawFooterAllowDeny();
  }
}

}  // namespace ui_approval
