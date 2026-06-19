# Multi-Session HOME Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-session support so users can see which Claude CLI window is active, switch between windows with B, and see which window is asking for approval.

**Architecture:** Extend the data pipeline from snapshot.js → data.h → UI layers with a compact per-session `s` array. The `s` array is optional so old sidecar versions ignore it gracefully. B key on HOME cycles activeSession; approval overlay shows session identity.

**Tech Stack:** C++ (ESP32 Arduino), JavaScript (Node.js), bleak (Python BLE)

---

### Task 1: Add `s` array and `prompt.si` to snapshot.js

**Files:**
- Modify: `src/hardware-buddy/snapshot.js:156-227`

- [ ] **Step 1: Add session compact array builder**

In `snapshot.js`, after line 191 (the `heartbeat` object construction), add a `s` array. Insert before `const activePrompt = ...` on line 194:

```js
  // Compact per-session array for firmware multi-session UI.
  // Each row: [id_suffix(4chars), title(16max), state, updatedAt_epoch, createdAt_epoch]
  heartbeat.s = visibleSessions.slice(0, 4).map((session) => {
    const id = String(session.id || "");
    return [
      id.length > 4 ? id.slice(-4) : id,
      (session.displayTitle || session.sessionTitle || "").slice(0, 16),
      session.state || "idle",
      numericTime(session.updatedAt) || 0,
      numericTime(session.createdAt) || 0,
    ];
  });
```

- [ ] **Step 2: Add `si` to prompt object**

In the `heartbeat.prompt` construction (line 206-211), add `si` field. Find the session index matching the active prompt's session. Replace:

```js
    heartbeat.prompt = {
      id: activePrompt.id,
      tool,
      hint: shortHintFor(activePrompt.entry, { maxBytes: 80 }),
      choices,
    };
```

With:

```js
    const promptSession = activePrompt.entry && activePrompt.entry.sessionId;
    const si = promptSession
      ? visibleSessions.findIndex((s) => s.id === promptSession)
      : -1;
    heartbeat.prompt = {
      id: activePrompt.id,
      tool,
      hint: shortHintFor(activePrompt.entry, { maxBytes: 80 }),
      choices,
      si: si >= 0 ? si : 0xFF,
    };
```

- [ ] **Step 3: Commit**

```bash
git add src/hardware-buddy/snapshot.js
git commit -m "feat: add per-session s array and prompt.si to heartbeat"
```

---

### Task 2: Extend TamaState and parse `s` array in data.h

**Files:**
- Modify: `firmware/clawstick/src/data.h:7-186`

- [ ] **Step 1: Add SessionInfo struct and new TamaState fields**

After `struct TamaState {` (line 7), add `SessionInfo` struct before it, and add new fields to TamaState. Add before line 7:

```cpp
struct SessionInfo {
  char     id[5];          // session id suffix (4 chars + null)
  char     title[17];      // project name (16 chars + null)
  char     state[9];       // "idle"/"working"/"thinking" etc (8 + null)
  uint32_t updatedAt;       // epoch seconds
  uint32_t createdAt;       // epoch seconds (0 = unknown)
};

struct TamaState {
```

Add after `char personaState[20];` (line 21), before `};`:

```cpp
  SessionInfo sessions[4];     // per-window info (up to 4)
  uint8_t  sessionCount;       // actual number of windows (0-4)
  uint8_t  activeSession;      // currently viewed window (0-based)
  uint8_t  promptSessionIdx;   // which session the prompt belongs to (0xFF = none)
```

- [ ] **Step 2: Parse `s` array in _applyJson**

After line 98 (`out->personaState[sizeof...]=0;`), before the comment on line 99, add:

```cpp
  // Parse compact per-session array: [[id, title, state, updatedAt, createdAt], ...]
  JsonArray sArr = doc["s"];
  if (!sArr.isNull()) {
    out->sessionCount = 0;
    for (uint8_t i = 0; i < 4 && i < sArr.size(); i++) {
      JsonArray row = sArr[i];
      if (row.isNull() || row.size() < 3) continue;
      const char* sid = row[0];
      const char* stitle = row[1];
      const char* sstate = row[2];
      if (sid)  { strncpy(out->sessions[i].id, sid, 4); out->sessions[i].id[4]=0; }
      else out->sessions[i].id[0]=0;
      if (stitle) { strncpy(out->sessions[i].title, stitle, 16); out->sessions[i].title[16]=0; }
      else out->sessions[i].title[0]=0;
      if (sstate) { strncpy(out->sessions[i].state, sstate, 8); out->sessions[i].state[8]=0; }
      else out->sessions[i].state[0]=0;
      out->sessions[i].updatedAt = row.size() > 3 ? (uint32_t)row[3].as<uint32_t>() : 0;
      out->sessions[i].createdAt = row.size() > 4 ? (uint32_t)row[4].as<uint32_t>() : 0;
      out->sessionCount = i + 1;
    }
  }
```

- [ ] **Step 3: Parse prompt.si**

In the prompt parsing block (after line 125, before `_promptReceivedMs = millis();`), add:

```cpp
    out->promptSessionIdx = pr["si"] | 0xFF;
```

- [ ] **Step 4: Reset sessions on disconnect**

In the disconnect block (line 179-185), add session reset. After `out->promptChoiceCount = 0;` (line 183), add:

```cpp
    out->sessionCount = 0;
    out->promptSessionIdx = 0xFF;
```

- [ ] **Step 5: Commit**

```bash
git add firmware/clawstick/src/data.h
git commit -m "feat: add SessionInfo struct, parse s array and prompt.si"
```

---

### Task 3: Redesign HOME page for multi-session display

**Files:**
- Modify: `firmware/clawstick/src/ui/screens/home.cpp`

- [ ] **Step 1: Add session indicator to status bar**

In `drawStatusBar`, after the page dots loop (line 58), add session indicator when `sessionCount > 1`. Change the function signature to accept session info. Replace the function (lines 52-88) with:

```cpp
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
    int sw = (int)strlen(si) * 6;
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
```

- [ ] **Step 2: Replace drawNameStatusSessions with session-aware layout**

Replace the function (lines 90-162) with:

```cpp
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
```

- [ ] **Step 3: Update drawCaption for B switch hint**

Replace `drawCaption` (lines 164-173) with:

```cpp
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
```

- [ ] **Step 4: Update render() to pass session info**

Update `render()` (lines 177-219). Replace `drawStatusBar(batPct, secureLink, charging);` (line 205) with:

```cpp
  drawStatusBar(batPct, secureLink, charging, tama.sessionCount, tama.activeSession);
```

Replace `drawNameStatusSessions(tama, persona, owner, petname);` (line 212) with:

```cpp
  drawProjectStatusSessions(tama, persona, owner, petname);
```

Replace `drawCaption();` (line 216) with:

```cpp
  drawCaption(tama.sessionCount);
```

- [ ] **Step 5: Commit**

```bash
git add firmware/clawstick/src/ui/screens/home.cpp
git commit -m "feat: multi-session HOME page with project name and B switch hint"
```

---

### Task 4: Add session identity to approval overlay

**Files:**
- Modify: `firmware/clawstick/src/ui/overlays/approval.cpp:42-56`

- [ ] **Step 1: Modify drawTitleRow to show session identity**

Replace `drawTitleRow` (lines 42-56) with a version that takes session info:

```cpp
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
```

- [ ] **Step 2: Update render() call to drawTitleRow**

In `render()` (line 234), replace:

```cpp
  drawTitleRow(waited);
```

with:

```cpp
  drawTitleRow(waited, tama);
```

- [ ] **Step 3: Commit**

```bash
git add firmware/clawstick/src/ui/overlays/approval.cpp
git commit -m "feat: approval overlay shows session identity (#N projectname)"
```

---

### Task 5: Add B-key session switch and project-settings overlay in main.cpp

**Files:**
- Modify: `firmware/clawstick/src/main.cpp`

- [ ] **Step 1: Add projectOpen and projectSel variables**

After the existing overlay variables (around line 62), add:

```cpp
bool     projectOpen = false;
uint8_t  projectSel = 0;
```

- [ ] **Step 2: Add B-key session switch on HOME**

In the B-key handler (line 684, after `bleWakeAdvertising();`), replace the comment `// else: B short on HOME/STATS — no-op` with actual HOME session switching. Replace line 685:

```cpp
      // else: B short on HOME/STATS — no-op (plan §3.5.1 dispatch table)
```

with:

```cpp
      } else if (ui_router::current() == ui_router::CARD_HOME && tama.sessionCount > 1) {
        // HOME: B switches between sessions
        tama.activeSession = (tama.activeSession + 1) % tama.sessionCount;
        beep(1800, 30);
        characterInvalidate();
      }
```

- [ ] **Step 3: Add long-press A for project-settings on HOME**

In the long-press A handler (line 551-571), after `if (overlayCapturesInput) { ... } else {`, add before `menuOpen = !menuOpen;` (line 564):

```cpp
      if (projectOpen) {
        projectOpen = false;
      } else if (ui_router::current() == ui_router::CARD_HOME) {
        projectOpen = true;
        projectSel = 0;
      } else {
```

And close the extra brace — change line 564 from `menuOpen = !menuOpen;` to be inside the else:

The full block should read:

```cpp
    } else {
      statsOnButtonInteract();
      beep(800, 60);
      if (resetOpen) { resetOpen = false; }
      else if (settingsOpen) { settingsOpen = false; menuOpen = true; }
      else if (aboutOpen) { aboutOpen = false; menuOpen = true; }
      else if (projectOpen) { projectOpen = false; }
      else if (ui_router::current() == ui_router::CARD_HOME) {
        projectOpen = true;
        projectSel = 0;
      } else {
        menuOpen = !menuOpen;
        menuSel = 0;
        powerConfirmUntil = 0;
        if (!menuOpen) characterInvalidate();
      }
      Serial.println(menuOpen ? "menu open" : "menu close");
    }
```

- [ ] **Step 4: Add A/B handling inside project-settings**

In short-press A handler (after overlayCapturesInput else-if chain, around line 612), add before the `else { ui_router::next(); }` block:

```cpp
      } else if (projectOpen) {
        beep(1800, 30);
        projectSel = (projectSel + 1) % 5;
```

In short-press B handler (after aboutOpen/resetOpen/settingsOpen/menuOpen/LINK else-if chain, around line 684), add before the HOME session-switch block:

```cpp
      } else if (projectOpen) {
        beep(2400, 30);
        const char* modeCmds[] = {"normal", "bypassPermissions", "auto", "plan", "acceptEditsOn"};
        char cmd[80];
        snprintf(cmd, sizeof(cmd), "{\"cmd\":\"mode\",\"session\":\"%s\",\"mode\":\"%s\"}",
                 tama.sessionCount > 0 && tama.activeSession < tama.sessionCount ? tama.sessions[tama.activeSession].id : "",
                 modeCmds[projectSel]);
        sendCmd(cmd);
```

- [ ] **Step 5: Add projectOpen to overlayCapturesInput**

Find `bool overlayCapturesInput` (around line 494) and add `projectOpen`:

```cpp
  bool overlayCapturesInput = (blePasskey() != 0) || showApproval || projectOpen;
```

- [ ] **Step 6: Add drawProjectSettings function**

Add before `setup()`:

```cpp
void drawProjectSettings(const TamaState& tama) {
  const uint16_t PJS_BG = 0x1082;
  const uint16_t PJS_TEXT = 0xFFFF;
  const uint16_t PJS_DIM = 0x7BEF;
  const uint16_t PJS_ACCENT = 0xFCE0;
  const uint16_t PJS_DIV = 0x3186;
  const uint16_t PJS_SEL = 0x2945;

  spr.fillSprite(PJS_BG);
  int y = 6;

  spr.setTextSize(1);
  if (tama.sessionCount > 0 && tama.activeSession < tama.sessionCount) {
    const SessionInfo& si = tama.sessions[tama.activeSession];
    spr.setTextColor(PJS_ACCENT, PJS_BG);
    char hdr[20];
    snprintf(hdr, sizeof(hdr), "#%u", (unsigned)(tama.activeSession + 1));
    spr.setCursor(8, y);
    spr.print(hdr);
    spr.setTextColor(PJS_TEXT, PJS_BG);
    spr.setCursor(30, y);
    spr.print(si.title);
    y += 14;

    // Run duration
    spr.setTextColor(PJS_DIM, PJS_BG);
    spr.setCursor(8, y);
    spr.print("run ");
    if (si.updatedAt > 0 && statsRtcSynced()) {
      time_t nowT = time(nullptr);
      uint32_t durSec = nowT > (time_t)si.updatedAt ? (uint32_t)(nowT - (time_t)si.updatedAt) : 0;
      char durBuf[16];
      if (durSec >= 3600) snprintf(durBuf, sizeof(durBuf), "%uh%um", durSec/3600, (durSec%3600)/60);
      else if (durSec >= 60) snprintf(durBuf, sizeof(durBuf), "%um", durSec/60);
      else snprintf(durBuf, sizeof(durBuf), "%us", durSec);
      spr.setTextColor(PJS_TEXT, PJS_BG);
      spr.print(durBuf);
    } else {
      spr.setTextColor(PJS_DIM, PJS_BG);
      spr.print("--");
    }
    y += 14;

    // Created time
    spr.setTextColor(PJS_DIM, PJS_BG);
    spr.setCursor(8, y);
    spr.print("created ");
    if (si.createdAt > 0 && statsRtcSynced()) {
      time_t nowT = time(nullptr);
      uint32_t agoSec = nowT > (time_t)si.createdAt ? (uint32_t)(nowT - (time_t)si.createdAt) : 0;
      char agoBuf[16];
      if (agoSec >= 86400) snprintf(agoBuf, sizeof(agoBuf), "%ud", agoSec/86400);
      else if (agoSec >= 3600) snprintf(agoBuf, sizeof(agoBuf), "%uh", agoSec/3600);
      else if (agoSec >= 60) snprintf(agoBuf, sizeof(agoBuf), "%um", agoSec/60);
      else snprintf(agoBuf, sizeof(agoBuf), "%us", agoSec);
      spr.setTextColor(PJS_TEXT, PJS_BG);
      spr.print(agoBuf);
      spr.print(" ago");
    } else {
      spr.setTextColor(PJS_DIM, PJS_BG);
      spr.print("--");
    }
    y += 14;
  } else {
    spr.setTextColor(PJS_DIM, PJS_BG);
    spr.setCursor(8, y);
    spr.print("NO SESSION");
    y += 14;
  }

  spr.drawFastHLine(8, y, 119, PJS_DIV);
  y += 6;

  // Mode list (5 modes)
  const char* modeLabels[] = {"normal", "dangerous", "auto", "plan", "edit-auto"};
  for (uint8_t i = 0; i < 5; i++) {
    if (i == projectSel) {
      spr.fillRect(4, y - 2, 127, 14, PJS_SEL);
      spr.setTextColor(PJS_TEXT, PJS_SEL);
      spr.setCursor(8, y);
      spr.print("> ");
    } else {
      spr.setTextColor(PJS_DIM, PJS_BG);
      spr.setCursor(8, y);
      spr.print("  ");
    }
    spr.print(modeLabels[i]);
    y += 16;
  }

  spr.setTextSize(1);
  spr.setTextColor(PJS_DIM, PJS_BG);
  spr.setCursor(4, 226);
  spr.print("A:sel B:toggle holdA:exit");
}
```

- [ ] **Step 7: Render project-settings overlay**

In the render section (around line 738), add after the `if (blePasskey())` check:

```cpp
    else if (projectOpen) drawProjectSettings(tama);
```

- [ ] **Step 8: Commit**

```bash
git add firmware/clawstick/src/main.cpp
git commit -m "feat: B-key session switch, project-settings overlay with run/created time"
```

---

### Task 6: Build, flash, and verify

- [ ] **Step 1: Build firmware**

Run: `pio run -d firmware/clawstick -e clawstick-m5stickc-plus`
Expected: SUCCESS

- [ ] **Step 2: Flash firmware**

Run: `pio run -d firmware/clawstick -e clawstick-m5stickc-plus -t upload`
Expected: SUCCESS

- [ ] **Step 3: Manual verification**

1. Restart clawd-on-desk
2. Open 2+ Claude Code CLI windows in different projects
3. Verify HOME shows project name from active window
4. Verify status bar shows "1/2" indicator
5. Press B — project name changes, indicator shows "2/2"
6. Trigger a permission prompt — verify approval shows "#N projectname"
7. Long-press A on HOME — project-settings overlay opens with run time and created time
8. Single session — verify B does nothing, no "1/1" indicator
