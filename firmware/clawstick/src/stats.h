#pragma once
#include <stdint.h>
#include <time.h>
#include "clawstick_config.h"

// stats.h declares interface only; storage lives in stats.cpp. Header-only
// inline statics in the L2 version forced each TU that included this file
// to carry its own zero-initialised _stats / _settings / _petName copies,
// which is why home.cpp (L2) had to take owner/petname as render params.
// L3-1 consolidates to a single TU so any caller can include this header
// and read the same state.
//
// Field layout follows plan §3.3 method B (養成 system reset, no token):
//   approvals/denials/level/totalShakes  NVS accumulators (uint16)
//   napSecondsTotal                       NVS accumulator (uint32)
//   lastButtonInteractAt / lastNapEndAt   NVS RTC epoch seconds (uint32)
//   lastShakeMs[5] ring + interact-millis backups live in RAM only

struct Stats {
  uint16_t approvals;
  uint16_t denials;
  uint16_t level;              // = approvals / 50; uint16 because uint8 caps at 255 (plan §3.3 field-type note)
  uint16_t totalShakes;
  uint32_t napSecondsTotal;
  uint32_t lastButtonInteractAt;  // RTC epoch seconds; 0 means never recorded
  uint32_t lastNapEndAt;          // RTC epoch seconds; 0 means never napped
};

struct Settings {
  bool sound;
  bool bt;
  bool led;
  uint8_t clockRot;            // legacy fork field, kept so older NVS data still reads cleanly
};

// Persistence
void statsLoad();
void statsSave();
void statsFactoryReset();      // wipe "buddy" NVS namespace; main.cpp factory reset uses this

// Event hooks. Each one persists what it touches; do not call statsSave()
// directly outside stats.cpp.
void statsOnApproval(uint32_t secondsToRespond);
void statsOnDenial();
// A/B physical user action accepted — covers both the long-press
// trigger (A 600 ms) and short-press accept (A wasReleased, B
// wasPressed). NOT called from shake/wake() so the fork's
// shake-interlock bug stays fixed (plan §3.3).
void statsOnButtonInteract();
void statsOnShakeDetected();   // shake threshold crossed; pushes lastShakeMs ring + totalShakes
void statsOnNapEnd(uint32_t durationSec);  // only counts toward napSecondsTotal / energy reset if >= 60s

// RTC integration. Plan §3.3 cold-start strategy:
//   On boot, RTC year < 2025 means BM8563 was never set; mood falls back
//   to base=2 and energy stops decaying. statsTimeSync() is called from
//   data.h when the BLE sidecar sends {"time":[epoch, tz]} -- that path
//   calibrates the RTC AND back-fills RTC-epoch timestamps for events
//   that happened earlier in this boot (lastButtonInteractMs → At).
void statsTimeSync(time_t localEpoch);
bool statsRtcSynced();

// Writes "HH:MM" (5 chars + null, so n >= 6) for the status-bar mini clock.
// Returns false if RTC is not yet synced — caller should hide the field
// rather than show a 2000-01-01 ghost. Internally caches the RTC read at
// 1 Hz so this is cheap to call from per-frame status-bar code.
bool statsClockText(char* out, size_t n);

// Derived getters
uint16_t statsLevel();
uint16_t statsApprovals();
uint16_t statsDenials();
uint16_t statsTotalShakes();
uint32_t statsNapSecondsTotal();
uint8_t  statsMoodTier();      // 0..4 (plan §3.3 mood formula)
uint8_t  statsEnergyTier();    // 0..5 (plan §3.3 energy formula)

const Stats& stats();

// Settings
Settings& settings();
void settingsLoad();
void settingsSave();

// Pet + owner names. petNameLoad() loads BOTH from NVS for historical reasons
// (legacy single load entry point in fork). New code should still call it once
// at boot.
const char* petName();
void petNameSet(const char* name);
const char* ownerName();
void ownerSet(const char* name);
void petNameLoad();
