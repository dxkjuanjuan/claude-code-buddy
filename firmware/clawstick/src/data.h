#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "ble_bridge.h"
#include "xfer.h"

struct SessionInfo {
  char     id[5];          // session id suffix (4 chars + null)
  char     title[17];      // project name (16 chars + null)
  char     state[9];       // "idle"/"working"/"thinking" etc (8 + null)
  uint32_t updatedAt;       // epoch seconds
  uint32_t createdAt;       // epoch seconds (0 = unknown)
};

struct TamaState {
  uint8_t  sessionsTotal;
  uint8_t  sessionsRunning;
  uint8_t  sessionsWaiting;
  bool     recentlyCompleted;
  bool     connected;
  char     promptId[40];     // pending permission request ID; empty = no prompt
  // promptTool sized for MCP-namespaced tool names. Pre-L4 was char[20]
  // which truncated identifiers like "mcp__browser-tools__getConsoleErrors"
  // at the very first character of the leaf method; plan §3.6 mandates 32 B.
  char     promptTool[32];
  char     promptHint[44];
  char     promptChoices[4][16]; // up to 4 choices, each up to 15 chars
  uint8_t  promptChoiceCount;    // 0 = no choices (legacy allow/deny)
  char     personaState[20]; // named state from bridge: "idle","working","thinking","juggling","sweeping","error","attention","notification","carrying","sleeping"
  SessionInfo sessions[4];     // per-window info (up to 4)
  uint8_t  sessionCount;       // actual number of windows (0-4)
  uint8_t  activeSession;      // currently viewed window (0-based)
  uint8_t  promptSessionIdx;   // which session the prompt belongs to (0xFF = none)
};

// ---------------------------------------------------------------------------
// Two modes, checked in priority order:
//   live   -> JSON arrived in the last 10s over USB or BT
//   asleep -> no data, all counters zeroed
// ---------------------------------------------------------------------------

static uint32_t _lastLiveMs = 0;
static uint32_t _lastBtByteMs = 0;   // hasClient() lies; track actual BT traffic
// L4-3 #2: post-response "sent..." hold needs to survive the host's
// permission-reply snapshot. controller.js:218 emits a promptless
// snapshot immediately after accepting the firmware's A/B decision,
// and _applyJson would otherwise clear promptId on that snapshot,
// collapsing the 1.5s hold to a single frame. main.cpp owns the flag:
// sets true when responseAt is taken, false when the hold ends.
static bool     _suppressPromptClear = false;
// When a prompt arrives, record the time so we can hold it visible for
// PROMPT_HOLD_MS even if subsequent keepalive snapshots lack the prompt
// field. Claude Code hooks fire rapidly: PermissionRequest → approval
// → PostToolUse can arrive in <1s, and the keepalive in between has no
// prompt field. Without this hold the approval overlay flashes for a
// single frame and disappears before the user can press A/B.
static uint32_t _promptReceivedMs = 0;
static const uint32_t PROMPT_HOLD_MS = 30000; // 30s hold for M5 approval UI

// L4-3 #2: see _suppressPromptClear comment. main.cpp toggles this around
// the post-response hold window; while true, _applyJson() preserves the
// active promptId/Tool/Hint instead of clearing on host snapshots that
// happen to lack a prompt field.
inline void dataSetSuppressPromptClear(bool on) { _suppressPromptClear = on; }

inline bool dataConnected() {
  return _lastLiveMs != 0 && (millis() - _lastLiveMs) <= 30000;
}

inline bool dataBtActive() {
  // Desktop's idle keepalive is ~10s; give it 1.5x headroom.
  return _lastBtByteMs != 0 && (millis() - _lastBtByteMs) <= 15000;
}

static void _applyJson(const char* line, TamaState* out) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;
  if (xferCommand(doc)) { _lastLiveMs = millis(); return; }

  // Bridge sends {"time":[epoch_sec, tz_offset_sec]}. Delegate to
  // statsTimeSync() so plan §3.3's RTC cold-start back-fill (RAM-only
  // lastButtonInteractMs → NVS lastButtonInteractAt) happens atomically
  // with the RTC write.
  //
  // Gated on bleSecure(): without it, anything that can drop a JSON
  // line into _applyJson (USB serial dev path, any future insecure
  // BLE forwarder) could push an arbitrary epoch and defeat the
  // mood/energy time-window formulas. Plan §3.5 already enforces
  // secure-transport on prompt; time sync deserves the same gate
  // since it sets the reference epoch for ALL stats-derived state.
  JsonArray t = doc["time"];
  if (!t.isNull() && t.size() == 2 && bleSecure()) {
    time_t local = (time_t)t[0].as<uint32_t>() + (int32_t)t[1];
    statsTimeSync(local);
    _lastLiveMs = millis();
    return;
  }

  out->sessionsTotal     = doc["total"]     | out->sessionsTotal;
  out->sessionsRunning   = doc["running"]   | out->sessionsRunning;
  out->sessionsWaiting   = doc["waiting"]   | out->sessionsWaiting;
  out->recentlyCompleted = doc["completed"] | false;
  // Named persona state from bridge — persists until a new state arrives
  // or connection is lost. Never cleared by counter resets so that
  // one-shot states (dizzy) can return to the last known working state.
  const char* ps = doc["state"];
  if (ps) {
    strncpy(out->personaState, ps, sizeof(out->personaState)-1);
    out->personaState[sizeof(out->personaState)-1] = 0;
  }
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
      if (stitle) {
        // Strip non-ASCII chars (ESP32 built-in font can't render them)
        char buf[17]; int j=0;
        for (const char* p=stitle; *p && j<16; p++) {
          if ((unsigned char)*p >= 0x20 && (unsigned char)*p < 0x7F) buf[j++]=*p;
        }
        buf[j]=0;
        memcpy(out->sessions[i].title, buf, j+1);
      }
      else out->sessions[i].title[0]=0;
      if (sstate) { strncpy(out->sessions[i].state, sstate, 8); out->sessions[i].state[8]=0; }
      else out->sessions[i].state[0]=0;
      out->sessions[i].updatedAt = row.size() > 3 ? (uint32_t)row[3].as<uint32_t>() : 0;
      out->sessions[i].createdAt = row.size() > 4 ? (uint32_t)row[4].as<uint32_t>() : 0;
      out->sessionCount = i + 1;
    }
  }
  // The snapshot protocol may still include msg / entries / tokens_today.
  // New Clawstick UI no longer renders transcript/info pages or token-fed
  // stats, so those legacy fork fields are intentionally ignored here.
  // Prompt is gated on a secure BLE transport (plan §3.5). Without
  // bond + secure connection an attacker could replay or fabricate a
  // prompt JSON over an open BLE link and force an approval decision.
  // USB Serial dev paths also fail this gate — intentional; sidecar
  // smoke tests should pair over BLE.
  JsonObject pr = doc["prompt"];
  if (!pr.isNull() && bleSecure()) {
    const char* pid = pr["id"]; const char* pt = pr["tool"]; const char* ph = pr["hint"];
    strncpy(out->promptId,   pid ? pid : "", sizeof(out->promptId)-1);   out->promptId[sizeof(out->promptId)-1]=0;
    strncpy(out->promptTool, pt  ? pt  : "", sizeof(out->promptTool)-1); out->promptTool[sizeof(out->promptTool)-1]=0;
    strncpy(out->promptHint, ph  ? ph  : "", sizeof(out->promptHint)-1); out->promptHint[sizeof(out->promptHint)-1]=0;
    // Parse choices array (e.g. ["Yes", "Yes, always", "No"])
    out->promptChoiceCount = 0;
    JsonArray ch = pr["choices"];
    if (!ch.isNull()) {
      for (uint8_t i = 0; i < 4 && i < ch.size(); i++) {
        const char* c = ch[i];
        if (c && c[0]) {
          strncpy(out->promptChoices[i], c, sizeof(out->promptChoices[i])-1);
          out->promptChoices[i][sizeof(out->promptChoices[i])-1] = 0;
          out->promptChoiceCount = i + 1;
        }
      }
    }
    out->promptSessionIdx = pr["si"] | 0xFF;
    _promptReceivedMs = millis();
  } else if (!_suppressPromptClear) {
    // No prompt field on this snapshot (or transport lost the gate).
    // Hold the prompt for PROMPT_HOLD_MS so the M5 approval UI stays
    // visible while the user decides. After the hold, or if main.cpp
    // is suppressing clears, preserve the existing prompt.
    uint32_t elapsed = _promptReceivedMs ? (millis() - _promptReceivedMs) : PROMPT_HOLD_MS + 1;
    if (out->promptId[0] == 0 || elapsed > PROMPT_HOLD_MS) {
      out->promptId[0] = 0; out->promptTool[0] = 0; out->promptHint[0] = 0;
      out->promptChoiceCount = 0;
      _promptReceivedMs = 0;
    }
  }
  _lastLiveMs = millis();
}

template<size_t N>
struct _LineBuf {
  char buf[N];
  uint16_t len = 0;
  void feed(Stream& s, TamaState* out) {
    while (s.available()) {
      char c = s.read();
      if (c == '\n' || c == '\r') {
        if (len > 0) { buf[len]=0; if (buf[0]=='{') _applyJson(buf, out); len=0; }
      } else if (len < N-1) {
        buf[len++] = c;
      }
    }
  }
};

static _LineBuf<1024> _usbLine, _btLine;

inline void dataPoll(TamaState* out) {
  _usbLine.feed(Serial, out);
  // BLE ring buffer is drained manually since it's not a Stream.
  while (bleAvailable()) {
    int c = bleRead();
    if (c < 0) break;
    _lastBtByteMs = millis();
    if (c == '\n' || c == '\r') {
      if (_btLine.len > 0) {
        _btLine.buf[_btLine.len] = 0;
        if (_btLine.buf[0] == '{') _applyJson(_btLine.buf, out);
        _btLine.len = 0;
      }
    } else if (_btLine.len < sizeof(_btLine.buf) - 1) {
      _btLine.buf[_btLine.len++] = (char)c;
    }
  }

  out->connected = dataConnected();
  if (!out->connected) {
    out->sessionsTotal=0; out->sessionsRunning=0; out->sessionsWaiting=0;
    out->recentlyCompleted=false;
    out->personaState[0]=0; // clear on disconnect so fresh connect starts idle
    out->promptChoiceCount = 0;
    out->sessionCount = 0;
    out->promptSessionIdx = 0xFF;
    _promptReceivedMs = 0;
  }
}
