#include "home.h"
#include "../../character.h"
#include "../../ble_bridge.h"
#include "../../clawstick_config.h"
#include "../../stats.h"
#include <M5StickCPlus.h>

// stats.h's L2-era file-static storage was consolidated into a single TU
// in L3-1, so including it here no longer creates a private copy of
// owner/petname/stats. Owner/petname stay as render() parameters for
// signature-stability across the router; statsClockText() is read fresh
// each frame for the status-bar mini clock (L3-5).

extern TFT_eSprite spr;

namespace ui_home {

namespace {

// Plan §1.1 colors (RGB565). Hardcoded — character palette's `pal.bg`
// matches `COL_BG` by manifest convention (#101010), but the HOME card
// shouldn't depend on what manifest a future character ships with.
const uint16_t COL_BG       = 0x1082;
const uint16_t COL_TEXT     = 0xFFFF;
const uint16_t COL_TEXT_DIM = 0x7BEF;
const uint16_t COL_ACCENT   = 0xFCE0;  // Anthropic orange
const uint16_t COL_SUCCESS  = 0x07E0;
const uint16_t COL_DIVIDER  = 0x3186;

// Plan §1.4 layout
const int Y_STATUS_END    = 14;
const int Y_CAPTION_START = 226;

// PersonaState (0..7) -> short status-row label.
// SLEEP / IDLE / CELEBRATE / HEART all show as "idle" because the L2
// Clawd asset set only has 5 dedicated GIFs (idle/working/thinking/
// dizzy/error) — character.cpp's PERSONA_TO_STATE collapses celebrate
// and heart onto the idle GIF, and plan §2.3 collapses sleep onto
// idle (only dims brightness). Showing "sleeping" / "happy" / "loved"
// while the GIF actually plays idle was confusing — keep label and
// visual aligned. P_ERROR (7) is L4-1: transport degraded mid-session.
const char* personaLabel(uint8_t p) {
  switch (p) {
    case 2: return "working";    // P_BUSY
    case 3: return "thinking";   // P_ATTENTION
    case 5: return "dizzy";      // P_DIZZY
    case 7: return "error";      // P_ERROR (transport degraded)
    default: return "idle";      // P_SLEEP / P_IDLE / P_CELEBRATE / P_HEART
  }
}

void drawStatusBar(uint8_t batPct, bool secureLink, bool charging,
                   uint8_t sessionCount, uint8_t activeSession) {
  // Page indicator: 3 dots on left, HOME (i=0) active.
  for (int i = 0; i < 3; i++) {
    int cx = 8 + i * 8;
    spr.fillCircle(cx, 7, 2, i == 0 ? COL_ACCENT : COL_TEXT_DIM);
  }

  // Session indicator "1/3" between dots and clock
  if (sessionCount > 1) {
    char si[8];
    snprintf(si, sizeof(si), "%u/%u", (unsigned)(activeSession + 1), (unsigned)sessionCount);
    spr.setTextSize(1);
    spr.setTextColor(COL_ACCENT, COL_BG);
    spr.setCursor(32, 3);
    spr.print(si);
  }

  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  char bat[8];
  snprintf(bat, sizeof(bat), "%u%%", batPct);
  int bw = (int)strlen(bat) * 6;
  spr.setCursor(135 - bw - 12, 3);
  spr.print(bat);

  char clk[8];
  bool synced = statsClockText(clk, sizeof(clk));
  if (!synced) snprintf(clk, sizeof(clk), "--:--");
  int cw = (int)strlen(clk) * 6;
  spr.setTextColor(synced ? COL_TEXT : COL_TEXT_DIM, COL_BG);
  spr.setCursor((135 - cw) / 2, 3);
  spr.print(clk);

  uint16_t bleCol = secureLink ? COL_SUCCESS
                  : bleConnected() ? COL_ACCENT
                  : COL_TEXT_DIM;
  spr.fillCircle(135 - 6, 7, 2, bleCol);
  (void)charging;
}

void drawProjectStatusSessions(const TamaState& tama, uint8_t persona,
                               const char* owner, const char* petname) {
  int y = 140;

  // When sessions exist, show project name instead of pet name
  bool hasSession = tama.sessionCount > 0 && tama.activeSession < tama.sessionCount;
  if (hasSession) {
    const char* title = tama.sessions[tama.activeSession].title;
    spr.setTextDatum(TC_DATUM);
    spr.setTextColor(COL_TEXT, COL_BG);
    spr.setTextSize(2);
    if (title && title[0]) {
      // Truncate to fit screen (11 chars at size 2)
      char buf[12];
      int len = (int)strlen(title);
      if (len > 11) len = 11;
      memcpy(buf, title, len);
      buf[len] = 0;
      spr.drawString(buf, 135 / 2, y);
    } else {
      spr.drawString(petname, 135 / 2, y);
    }
    spr.setTextDatum(TL_DATUM);
    y += 20;
  } else {
    // No session data: show owner's petname (original layout)
    spr.setTextDatum(TC_DATUM);
    spr.setTextColor(COL_TEXT, COL_BG);
    if (owner && owner[0]) {
      char combined[48];
      snprintf(combined, sizeof(combined), "%s's %s", owner, petname);
      int oneLineW = (int)strlen(combined) * 12;
      if (oneLineW <= 130) {
        spr.setTextSize(2);
        spr.drawString(combined, 135 / 2, y);
        y += 20;
      } else {
        char ownerLine[28];
        snprintf(ownerLine, sizeof(ownerLine), "%s's", owner);
        spr.setTextSize(1);
        spr.drawString(ownerLine, 135 / 2, y);
        y += 10;
        spr.setTextSize(2);
        spr.drawString(petname, 135 / 2, y);
        y += 20;
      }
    } else {
      spr.setTextSize(2);
      spr.drawString(petname, 135 / 2, y);
      y += 20;
    }
    spr.setTextDatum(TL_DATUM);
  }

  spr.drawFastHLine(20, y, 135 - 40, COL_DIVIDER);
  y += 6;

  // Status row: ● <state-name>
  {
    const char* sn = personaLabel(persona);
    int textW = (int)strlen(sn) * 12;
    const int dotW = 10;
    int totalW = dotW + textW;
    int leftX = (135 - totalW) / 2;
    if (leftX < 0) leftX = 0;
    spr.setTextSize(2);
    spr.fillCircle(leftX + 3, y + 7, 3, COL_ACCENT);
    spr.setTextColor(COL_TEXT, COL_BG);
    spr.setCursor(leftX + dotW, y);
    spr.print(sn);
  }
  y += 20;

  // Sessions count row
  {
    spr.setTextSize(2);
    spr.setTextColor(COL_TEXT_DIM, COL_BG);
    char ss[20];
    uint8_t total = tama.sessionsTotal;
    if (total == 0)      snprintf(ss, sizeof(ss), "no sessions");
    else if (total == 1) snprintf(ss, sizeof(ss), "1 session");
    else                 snprintf(ss, sizeof(ss), "%u sessions", total);
    spr.setTextDatum(TC_DATUM);
    spr.drawString(ss, 135 / 2, y);
    spr.setTextDatum(TL_DATUM);
  }
}

void drawCaption(uint8_t sessionCount) {
  spr.setTextSize(1);
  spr.setTextColor(COL_TEXT_DIM, COL_BG);
  spr.setCursor(4, Y_CAPTION_START + 4);
  spr.print("A >");
  const char* hint = sessionCount > 1 ? "B switch" : "hold A menu";
  int hw = (int)strlen(hint) * 6;
  spr.setCursor(135 - hw - 4, Y_CAPTION_START + 4);
  spr.print(hint);
}

}  // namespace

void render(const TamaState& tama, uint8_t persona,
            uint8_t batPct, bool secureLink, bool charging,
            const char* owner, const char* petname) {
  // Region-based clears, NOT spr.fillSprite. character.cpp's tick only
  // paints the GIF region at the GIF's own frame cadence (~10 fps), so
  // clearing the whole sprite at the main loop's 60 fps would leave the
  // GIF region blank between frames and flicker. Each region clears
  // only what it owns.

  // Clear GIF-region side padding every frame. The Clawd GIFs are 120
  // wide; (135-120)/2 = 7 (integer div), so the GIF canvas spans
  // x=7..126 inclusive, the left padding is x=0..6 (7 px) and the
  // right padding is x=127..134 (8 px). character.cpp's fillRect only
  // fires on state change, so without this any prior pixels there
  // persist into the steady state — visually a "black bar on each side"
  // that only disappears when the persona changes.
  spr.fillRect(0,   14, 7, 120, COL_BG);
  spr.fillRect(127, 14, 8, 120, COL_BG);

  // GIF — character.cpp's GIF canvas spans y=14..134 (gifPlace y=14
  // anchored against the status bar). setState/tick paint only the
  // canvas, never the side padding above.
  characterSetState(persona);
  characterTick();

  // Status bar region (y=0..14) — overwrites the top 6 px of the GIF
  // canvas, which is the bottom-aligned sprite's empty top padding.
  spr.fillRect(0, 0, 135, 14, COL_BG);
  drawStatusBar(batPct, secureLink, charging, tama.sessionCount, tama.activeSession);

  // Lower info region (y=134..226) — name / divider / status / sessions.
  // Starts at y=134 (GIF bottom edge) so anything that leaked into the
  // 4 px gap above the name row (boot splash residue, prior renderer
  // bleed) gets wiped every frame.
  spr.fillRect(0, 134, 135, 226 - 134, COL_BG);
  drawProjectStatusSessions(tama, persona, owner, petname);

  // Caption region (y=226..240)
  spr.fillRect(0, 226, 135, 240 - 226, COL_BG);
  drawCaption(tama.sessionCount);

  (void)Y_STATUS_END;
}

}  // namespace ui_home
