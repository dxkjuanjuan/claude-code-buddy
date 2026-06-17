#include "stats.h"
#include <Arduino.h>
#include <Preferences.h>
#include <M5StickCPlus.h>
#include <string.h>

// Single translation unit for all persistent state: stats, settings, names.
// See stats.h for why this is no longer header-only.

namespace {

Stats       g_stats   = {};
Settings    g_settings = { true, true, true, 0 };
Preferences g_prefs;
char        g_petName[24]   = CLAWSTICK_DEFAULT_PET_NAME;
char        g_ownerName[32] = "";

bool        g_statsDirty = false;
bool        g_rtcSynced  = false;

// RAM-only mirrors of the RTC-epoch timestamps. Plan §3.3 says mood/energy
// must keep working before the first RTC sync (rtc_synced=false fallback);
// these track elapsed millis() during this boot so derived getters can still
// compute hoursSinceButton / hoursSinceNap on a clock-less device.
uint32_t    g_lastButtonInteractMs = 0;
uint32_t    g_lastNapEndMs         = 0;

// Pending-back-fill flags for events that happened before RTC sync.
// statsTimeSync()'s old gate (`lastButtonInteractAt == 0`) skipped the
// back-fill whenever NVS still held a prior session's timestamp — so
// a button press during the pre-sync window after a reboot never
// updated mood's reference epoch. These flags let statsTimeSync()
// overwrite the NVS field unconditionally for any event that
// actually happened this boot. Cleared on factory reset.
bool        g_buttonInteractPendingSync = false;
bool        g_napEndPendingSync         = false;

// 5-slot shake ring (plan §3.3): last shake timestamps for the "≥3 shakes in
// 5 min → mood -2" rule. millis()-based, lives only in RAM.
uint32_t    g_lastShakeMs[5] = {0, 0, 0, 0, 0};
uint8_t     g_shakeIdx       = 0;

// JSON-string safety: stats.h-set names go through xfer.h's status command
// which printfs them unescaped. Strip quotes, backslashes, and control bytes.
void safeCopy(char* dst, size_t dstLen, const char* src) {
  size_t j = 0;
  for (size_t i = 0; src && src[i] && j < dstLen - 1; i++) {
    char c = src[i];
    if (c != '"' && c != '\\' && (unsigned char)c >= 0x20) dst[j++] = c;
  }
  dst[j] = 0;
}

void recomputeLevel() {
  // plan §3.3 formula B: level = approvals / 50. uint16_t throughout so the
  // 65535 approval cap maps to level 1310 cleanly (uint8 would cap at 255
  // here, see plan §3.3 field-type note).
  g_stats.level = g_stats.approvals / 50;
}

uint32_t rtcEpochNow() {
  RTC_TimeTypeDef tm; M5.Rtc.GetTime(&tm);
  RTC_DateTypeDef dt; M5.Rtc.GetDate(&dt);

  uint16_t year = dt.Year;
  uint8_t  mon  = dt.Month;
  uint8_t  day  = dt.Date;
  if (year < 1970 || mon < 1 || mon > 12 || day < 1 || day > 31) return 0;

  // Manually convert UTC components to epoch seconds. Avoids mktime(),
  // which honours $TZ — newlib defaults to UTC today, but anything that
  // setenv("TZ", ...) in the future would silently shift our epochs.
  // statsTimeSync() wrote the RTC via gmtime_r(localEpoch), so reading
  // it back as UTC components is correct (the "local" we stored is the
  // user's wall-clock seen as a UTC tuple).
  static const uint16_t MONTH_CUM[12] = {
    0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334
  };

  uint32_t days = 0;
  for (uint16_t y = 1970; y < year; y++) {
    bool leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
    days += leap ? 366u : 365u;
  }
  days += MONTH_CUM[mon - 1];
  bool curLeap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
  if (mon > 2 && curLeap) days++;
  days += (uint32_t)(day - 1);

  return days * 86400UL
       + (uint32_t)tm.Hours   * 3600UL
       + (uint32_t)tm.Minutes * 60UL
       + (uint32_t)tm.Seconds;
}

uint32_t hoursSinceButton() {
  uint32_t nowMs = millis();
  if (g_rtcSynced && g_stats.lastButtonInteractAt > 0) {
    uint32_t nowEpoch = rtcEpochNow();
    if (nowEpoch > g_stats.lastButtonInteractAt) {
      return (nowEpoch - g_stats.lastButtonInteractAt) / 3600;
    }
    return 0;
  }
  if (g_lastButtonInteractMs > 0 && nowMs >= g_lastButtonInteractMs) {
    return (nowMs - g_lastButtonInteractMs) / 3600000UL;
  }
  // No data yet → caller treats as neutral (mood base = 2 fallback).
  return UINT32_MAX;
}

uint32_t hoursSinceNap() {
  uint32_t nowMs = millis();
  if (g_rtcSynced && g_stats.lastNapEndAt > 0) {
    uint32_t nowEpoch = rtcEpochNow();
    if (nowEpoch > g_stats.lastNapEndAt) {
      return (nowEpoch - g_stats.lastNapEndAt) / 3600;
    }
    return 0;
  }
  if (g_lastNapEndMs > 0 && nowMs >= g_lastNapEndMs) {
    return (nowMs - g_lastNapEndMs) / 3600000UL;
  }
  return UINT32_MAX;
}

uint8_t shakesInLast5min() {
  uint32_t nowMs = millis();
  // Avoid wraparound and pre-300s confusion: if we're early enough in boot
  // that nowMs < 5 min, just count slots holding a non-zero stamp.
  uint8_t n = 0;
  if (nowMs < 300000UL) {
    for (int i = 0; i < 5; i++) if (g_lastShakeMs[i] != 0) n++;
    return n;
  }
  uint32_t cutoff = nowMs - 300000UL;
  for (int i = 0; i < 5; i++) {
    if (g_lastShakeMs[i] != 0 && g_lastShakeMs[i] >= cutoff) n++;
  }
  return n;
}

}  // namespace

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

void statsLoad() {
  g_prefs.begin("buddy", true);
  g_stats.approvals            = g_prefs.getUShort("appr", 0);
  g_stats.denials              = g_prefs.getUShort("deny", 0);
  g_stats.napSecondsTotal      = g_prefs.getUInt("nap", 0);
  g_stats.totalShakes          = g_prefs.getUShort("shakes", 0);
  g_stats.lastButtonInteractAt = g_prefs.getUInt("lastBA", 0);
  g_stats.lastNapEndAt         = g_prefs.getUInt("lastNA", 0);
  g_prefs.end();
  recomputeLevel();
  g_statsDirty = false;

  // BM8563 keeps time across reboots while the coin cell holds. If the
  // year is in a sane post-2025 window the RTC was already synced in a
  // prior session — trust it now so mini-clock and mood/energy formulas
  // don't fall back to "--:--" and base=2 just because we rebooted
  // before the sidecar got a chance to re-push set_time.
  RTC_DateTypeDef dt;
  M5.Rtc.GetDate(&dt);
  if (dt.Year >= 2025 && dt.Year < 2100 &&
      dt.Month >= 1 && dt.Month <= 12 &&
      dt.Date  >= 1 && dt.Date  <= 31) {
    g_rtcSynced = true;
  }
}

void statsSave() {
  if (!g_statsDirty) return;
  g_prefs.begin("buddy", false);
  g_prefs.putUShort("appr",   g_stats.approvals);
  g_prefs.putUShort("deny",   g_stats.denials);
  g_prefs.putUInt  ("nap",    g_stats.napSecondsTotal);
  g_prefs.putUShort("shakes", g_stats.totalShakes);
  g_prefs.putUInt  ("lastBA", g_stats.lastButtonInteractAt);
  g_prefs.putUInt  ("lastNA", g_stats.lastNapEndAt);
  g_prefs.end();
  g_statsDirty = false;
}

void statsFactoryReset() {
  g_prefs.begin("buddy", false);
  g_prefs.clear();
  g_prefs.end();
  g_stats = {};
  g_settings = { true, true, true, 0 };
  strncpy(g_petName, CLAWSTICK_DEFAULT_PET_NAME, sizeof(g_petName) - 1);
  g_petName[sizeof(g_petName) - 1] = 0;
  g_ownerName[0] = 0;
  g_lastButtonInteractMs = 0;
  g_lastNapEndMs = 0;
  for (int i = 0; i < 5; i++) g_lastShakeMs[i] = 0;
  g_shakeIdx = 0;
  g_rtcSynced = false;
  g_buttonInteractPendingSync = false;
  g_napEndPendingSync         = false;
}

// ---------------------------------------------------------------------------
// Event hooks
// ---------------------------------------------------------------------------

void statsOnApproval(uint32_t secondsToRespond) {
  (void)secondsToRespond;  // plan §3.3 method B drops the velocity ring
  if (g_stats.approvals < UINT16_MAX) g_stats.approvals++;
  recomputeLevel();
  g_statsDirty = true; statsSave();
}

void statsOnDenial() {
  if (g_stats.denials < UINT16_MAX) g_stats.denials++;
  g_statsDirty = true; statsSave();
}

void statsOnButtonInteract() {
  uint32_t nowMs = millis();
  g_lastButtonInteractMs = nowMs;
  if (g_rtcSynced) {
    g_stats.lastButtonInteractAt = rtcEpochNow();
    g_statsDirty = true; statsSave();
  } else {
    // Mark this event as needing a back-fill once RTC syncs. Without
    // the flag, statsTimeSync()'s "lastButtonInteractAt == 0" gate
    // would skip the overwrite whenever NVS still held a prior
    // session's timestamp — mood would keep computing against the
    // stale value indefinitely.
    g_buttonInteractPendingSync = true;
  }
}

void statsOnShakeDetected() {
  if (g_stats.totalShakes < UINT16_MAX) g_stats.totalShakes++;
  g_lastShakeMs[g_shakeIdx] = millis();
  g_shakeIdx = (g_shakeIdx + 1) % 5;
  g_statsDirty = true; statsSave();
}

void statsOnNapEnd(uint32_t durationSec) {
  // Plan §3.3 method B: only nap windows ≥ 60s count toward energy reset
  // and napSecondsTotal. Stops the "flip Plus2 face-down, flip back" abuse
  // path from refilling energy.
  if (durationSec < 60) return;
  g_stats.napSecondsTotal += durationSec;
  g_lastNapEndMs = millis();
  if (g_rtcSynced) {
    g_stats.lastNapEndAt = rtcEpochNow();
  } else {
    g_napEndPendingSync = true;  // see statsOnButtonInteract() for rationale
  }
  g_statsDirty = true; statsSave();
}

// ---------------------------------------------------------------------------
// RTC sync
// ---------------------------------------------------------------------------

void statsTimeSync(time_t localEpoch) {
  // Reject implausible epochs. The 2025-01-01 floor catches the BM8563
  // default (2000-01-01), zeroed time packets, and any malformed payload
  // that would otherwise push the RTC backwards and corrupt mood/energy
  // time-window math. Floor moves forward over the product lifetime —
  // currently corresponds to "before clawstick existed as a product".
  if (localEpoch < 1735689600) return;  // 2025-01-01 00:00:00 UTC

  struct tm lt;
  gmtime_r(&localEpoch, &lt);
  RTC_TimeTypeDef tm_t = {
    (uint8_t)lt.tm_hour, (uint8_t)lt.tm_min, (uint8_t)lt.tm_sec
  };
  RTC_DateTypeDef dt_t = {
    (uint8_t)lt.tm_wday,
    (uint8_t)(lt.tm_mon + 1),
    (uint8_t)lt.tm_mday,
    (uint16_t)(lt.tm_year + 1900)
  };
  M5.Rtc.SetTime(&tm_t);
  M5.Rtc.SetDate(&dt_t);
  g_rtcSynced = true;

  // main.cpp caches the RTC read at 1Hz (clockRefreshRtc); poke its cached
  // timestamp so the next read happens immediately and the cached values
  // pick up the new time. The extern declaration matches main.cpp:279.
  extern uint32_t _clkLastRead;
  _clkLastRead = 0;

  // Back-fill RTC-epoch timestamps for events that happened pre-sync.
  // Drives off pending flags rather than "NVS field == 0" so stale NVS
  // from a prior session doesn't block the overwrite (codex L3-HIGH).
  uint32_t nowMs = millis();
  bool wroteSomething = false;
  if (g_buttonInteractPendingSync && g_lastButtonInteractMs > 0) {
    uint32_t elapsedSec = (nowMs - g_lastButtonInteractMs) / 1000;
    g_stats.lastButtonInteractAt = (uint32_t)localEpoch - elapsedSec;
    g_buttonInteractPendingSync = false;
    wroteSomething = true;
  }
  if (g_napEndPendingSync && g_lastNapEndMs > 0) {
    uint32_t elapsedSec = (nowMs - g_lastNapEndMs) / 1000;
    g_stats.lastNapEndAt = (uint32_t)localEpoch - elapsedSec;
    g_napEndPendingSync = false;
    wroteSomething = true;
  }
  if (wroteSomething) {
    g_statsDirty = true; statsSave();
  }
}

bool statsRtcSynced() { return g_rtcSynced; }

// Status-bar mini clock cache. main.cpp's clockRefreshRtc() already
// reads the RTC at 1 Hz for its own (now defunct, post-L2) clock face;
// we keep a separate cache here so the status bar doesn't depend on
// the main-loop cache's timing. RTC reads cost ~600 µs over I2C and
// the IMU shares the bus, so 30 fps × 3 status-bar draws calling
// M5.Rtc.GetTime() raw would be 90 reads/s vs IMU contention.
namespace {
uint32_t g_clockCacheMs = 0;
uint8_t  g_cachedHour   = 0;
uint8_t  g_cachedMin    = 0;
}

bool statsClockText(char* out, size_t n) {
  if (!g_rtcSynced || n < 6) return false;
  uint32_t now = millis();
  if (g_clockCacheMs == 0 || (now - g_clockCacheMs) > 1000) {
    g_clockCacheMs = now;
    RTC_TimeTypeDef tm;
    M5.Rtc.GetTime(&tm);
    g_cachedHour = tm.Hours;
    g_cachedMin  = tm.Minutes;
  }
  snprintf(out, n, "%02u:%02u", g_cachedHour, g_cachedMin);
  return true;
}

// ---------------------------------------------------------------------------
// Derived getters
// ---------------------------------------------------------------------------

uint16_t statsLevel()           { return g_stats.level; }
uint16_t statsApprovals()       { return g_stats.approvals; }
uint16_t statsDenials()         { return g_stats.denials; }
uint16_t statsTotalShakes()     { return g_stats.totalShakes; }
uint32_t statsNapSecondsTotal() { return g_stats.napSecondsTotal; }

uint8_t statsMoodTier() {
  // Plan §3.3 cold-start: mood base=2 ("一般") while RTC is unsynced —
  // no time-window decay, no reward. Shake penalty still applies because
  // it's a present-moment event, not subject to epoch math.
  int8_t base;
  if (!g_rtcSynced) {
    base = 2;
  } else {
    uint32_t h = hoursSinceButton();
    if (h == UINT32_MAX)     base = 2;
    else if (h < 1)          base = 4;
    else if (h < 6)          base = 3;
    else if (h < 24)         base = 2;
    else if (h < 168)        base = 1;
    else                     base = 0;
  }
  if (shakesInLast5min() >= 3) base -= 2;
  return base < 0 ? 0 : (uint8_t)base;
}

uint8_t statsEnergyTier() {
  // Plan §3.3 cold-start: don't decay while RTC is unsynced; sit on the
  // last-known state. Energy reset is always 5 (a valid nap fills to
  // full), so if there's any nap evidence (NVS or this boot) we surface
  // 5; otherwise neutral 3.
  if (!g_rtcSynced) {
    if (g_stats.lastNapEndAt > 0 || g_lastNapEndMs > 0) return 5;
    return 3;
  }
  uint32_t h = hoursSinceNap();
  if (h == UINT32_MAX) return 3;
  int8_t e = 5 - (int8_t)(h / 2);
  if (e < 0) e = 0;
  if (e > 5) e = 5;
  return (uint8_t)e;
}

const Stats& stats() { return g_stats; }

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

Settings& settings() { return g_settings; }
Settings settingsGet() { return g_settings; }

void settingsLoad() {
  g_prefs.begin("buddy", true);
  g_settings.sound    = g_prefs.getBool("s_snd", true);
  g_settings.bt       = g_prefs.getBool("s_bt",  true);
  g_settings.led      = g_prefs.getBool("s_led", true);
  g_settings.clockRot = g_prefs.getUChar("s_crot", 0);
  if (g_settings.clockRot > 2) g_settings.clockRot = 0;
  g_settings.lang     = g_prefs.getUChar("s_lang", 1);  // default Chinese
  if (g_settings.lang >= 2) g_settings.lang = 1;
  g_prefs.end();
}

void settingsSave() {
  g_prefs.begin("buddy", false);
  g_prefs.putBool("s_snd", g_settings.sound);
  g_prefs.putBool("s_bt",  g_settings.bt);
  g_prefs.putBool("s_led", g_settings.led);
  g_prefs.putUChar("s_crot", g_settings.clockRot);
  g_prefs.putUChar("s_lang", g_settings.lang);
  g_prefs.end();
}

// ---------------------------------------------------------------------------
// Pet + owner names
// ---------------------------------------------------------------------------

void petNameLoad() {
  g_prefs.begin("buddy", true);
  g_prefs.getString("petname", g_petName,   sizeof(g_petName));
  g_prefs.getString("owner",   g_ownerName, sizeof(g_ownerName));
  g_prefs.end();
}

const char* petName() { return g_petName; }
void petNameSet(const char* name) {
  safeCopy(g_petName, sizeof(g_petName), name);
  g_prefs.begin("buddy", false);
  g_prefs.putString("petname", g_petName);
  g_prefs.end();
}

const char* ownerName() { return g_ownerName; }
void ownerSet(const char* name) {
  safeCopy(g_ownerName, sizeof(g_ownerName), name);
  g_prefs.begin("buddy", false);
  g_prefs.putString("owner", g_ownerName);
  g_prefs.end();
}
