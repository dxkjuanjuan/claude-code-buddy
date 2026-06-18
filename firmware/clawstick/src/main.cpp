#include <M5StickCPlus.h>
#include <LittleFS.h>
#include <stdarg.h>
#include "clawstick_config.h"
#include "ble_bridge.h"
#include "data.h"

TFT_eSprite spr = TFT_eSprite(&M5.Lcd);

// Advertise as "<prefix>-XXXX" (last two BT MAC bytes) so multiple sticks in
// one room are distinguishable in the desktop picker.
static char btName[32] = CLAWSTICK_DEVICE_PREFIX;
static void startBt() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(btName, sizeof(btName), "%s-%02X%02X", CLAWSTICK_DEVICE_PREFIX, mac[4], mac[5]);
  bleInit(btName);
}

#include "character.h"
#include "stats.h"
#include "ui/screens/home.h"
#include "ui/screens/stats.h"
#include "ui/screens/link.h"
#include "ui/router.h"
#include "ui/overlays/approval.h"
#include "ui/overlays/menu.h"
#include "ui/overlays/settings.h"
#include "ui/overlays/reset.h"
const int W = 135, H = 240;
const int CX = W / 2;
const int LED_PIN = 10;          // red LED, active-low

// Colors used across multiple UI surfaces
enum PersonaState {
  P_SLEEP, P_IDLE, P_BUSY, P_ATTENTION, P_CELEBRATE,
  P_DIZZY, P_HEART, P_ERROR,
  P_JUGGLING, P_SWEEPING, P_NOTIFICATION, P_CARRYING,
  P_BUILDING, P_READING, P_BUBBLE, P_DEBUGGER, P_ANNOYED
};
const char* stateNames[] = {
  "sleep", "idle", "busy", "attention", "celebrate",
  "dizzy", "heart", "error",
  "juggling", "sweeping", "notification", "carrying",
  "building", "reading", "bubble", "debugger", "annoyed"
};

TamaState    tama;
PersonaState baseState   = P_SLEEP;
PersonaState activeState = P_SLEEP;
uint32_t     oneShotUntil = 0;
uint32_t     lastShakeCheck = 0;
float        accelBaseline = 1.0f;
unsigned long t = 0;

// Menu / Settings / Reset overlay state
bool    menuOpen    = false;
uint8_t menuSel     = 0;
uint8_t brightLevel = 4;           // 0..4 → ScreenBreath 20..100
bool    btnALong    = false;
bool    aboutOpen   = false;

char     lastPromptId[40] = "";
uint32_t lastInteractMs = 0;
bool     dimmed = false;
bool     screenOff = false;
bool     sleepWakeBlocked = false;
bool     swallowBtnA = false;
bool     swallowBtnB = false;
uint32_t wakeTransitionUntil = 0;
const uint32_t SCREEN_OFF_MS = 30000;

bool     napping = false;
uint32_t napStartMs = 0;
uint32_t promptArrivedMs = 0;

// Face-down = Z-axis dominant and negative. Debounced so a toss doesn't count.
static bool isFaceDown() {
  float ax, ay, az;
  M5.Imu.getAccelData(&ax, &ay, &az);
  return az < -0.7f && fabsf(ax) < 0.4f && fabsf(ay) < 0.4f;
}

static void applyBrightness() { M5.Axp.ScreenBreath(20 + brightLevel * 20); }

static void wake() {
  lastInteractMs = millis();
  bleWakeAdvertising();
  if (screenOff) {
    M5.Axp.SetLDO2(true);
    applyBrightness();
    screenOff = false;
    wakeTransitionUntil = millis() + 12000;
  }
  if (dimmed) { applyBrightness(); dimmed = false; }
}
bool     responseSent = false;
uint8_t  choiceSel = 0;       // selected choice index in approval overlay

static void beep(uint16_t freq, uint16_t dur) {
  if (settings().sound) M5.Beep.tone(freq, dur);
}

static void sendCmd(const char* json) {
  Serial.println(json);
  size_t n = strlen(json);
  bleWrite((const uint8_t*)json, n);
  bleWrite((const uint8_t*)"\n", 1);
}

bool    settingsOpen = false;
uint8_t settingsSel  = 0;

bool    resetOpen = false;
uint8_t resetSel  = 0;
static uint32_t resetConfirmUntil = 0;
static uint8_t  resetConfirmIdx = 0xFF;
static uint32_t powerConfirmUntil = 0;

static void applySetting(uint8_t idx) {
  Settings& s = settings();
  switch (idx) {
    case 0:
      brightLevel = (brightLevel + 1) % 5;
      applyBrightness();
      return;
    case 1: s.sound = !s.sound; break;
    case 2:
      s.bt = !s.bt;
      bleSetEnabled(s.bt);
      break;
    case 3: s.led = !s.led; break;
    case 4: resetOpen = true; resetSel = 0; resetConfirmIdx = 0xFF; return;
    case 5: settingsOpen = false; menuOpen = true; return;
  }
  settingsSave();
}

// Tap-twice confirm: first tap arms (label flips to "really?"), second
// within 3s executes. Scrolling away clears the arm.
static void applyReset(uint8_t idx) {
  uint32_t now = millis();
  bool armed = (resetConfirmIdx == idx) && (int32_t)(now - resetConfirmUntil) < 0;

  if (idx == 2) { resetOpen = false; return; }

  if (!armed) {
    resetConfirmIdx = idx;
    resetConfirmUntil = now + 3000;
    beep(1400, 60);
    return;
  }

  beep(800, 200);
  if (idx == 0) {
    // delete char: wipe /characters/, reboot
    File d = LittleFS.open("/characters");
    if (d && d.isDirectory()) {
      File e;
      while ((e = d.openNextFile())) {
        char path[80];
        snprintf(path, sizeof(path), "/characters/%s", e.name());
        if (e.isDirectory()) {
          File f;
          while ((f = e.openNextFile())) {
            char fp[128];
            snprintf(fp, sizeof(fp), "%s/%s", path, f.name());
            f.close();
            LittleFS.remove(fp);
          }
          e.close();
          LittleFS.rmdir(path);
        } else {
          e.close();
          LittleFS.remove(path);
        }
      }
      d.close();
    }
  } else {
    // factory reset: NVS namespace wipe + filesystem format + BLE bonds.
    // Clears stats, owner, petname, settings, GIF characters, and any
    // stored LTKs so the next desktop has to re-pair.
    statsFactoryReset();
    LittleFS.format();
    bleClearBonds();
  }
  delay(300);
  ESP.restart();
}

void menuConfirm() {
  switch (menuSel) {
    case 0:
      powerConfirmUntil = 0;
      settingsOpen = true;
      menuOpen = false;
      settingsSel = 0;
      break;
    case 1:
      powerConfirmUntil = 0;
      menuOpen = false;
      aboutOpen = false;
      M5.Axp.SetLDO2(false);
      screenOff = true;
      sleepWakeBlocked = true;
      break;
    case 2:
      powerConfirmUntil = 0;
      aboutOpen = true;
      menuOpen = false;
      break;
    case 3:
      if ((int32_t)(millis() - powerConfirmUntil) >= 0) {
        powerConfirmUntil = millis() + 3000;
        beep(1400, 60);
        return;
      }
      M5.Axp.PowerOff();
      break;
    case 4:
      powerConfirmUntil = 0;
      menuOpen = false;
      characterInvalidate();
      break;
  }
}

// RTC and IMU share an I2C bus. Reading the RTC at 60fps starves the IMU
// reads — cache once per second. _onUsb feeds the BLE external-power hint
// and the SCREEN_OFF_MS exemption (USB-powered devices don't auto-off).
static RTC_TimeTypeDef _clkTm;
static RTC_DateTypeDef _clkDt;
uint32_t               _clkLastRead = 0;   // zeroed by data.h on time-sync
static bool            _onUsb       = false;
static void clockRefreshRtc() {
  if (millis() - _clkLastRead < 1000) return;
  _clkLastRead = millis();
  _onUsb = M5.Axp.GetVBusVoltage() > 4.0f;
  M5.Rtc.GetTime(&_clkTm);
  M5.Rtc.GetDate(&_clkDt);
}

// Once true for this boot, stays true until reboot. Distinguishes
// "BLE secure has degraded mid-session" (→ P_ERROR) from "BLE never
// came up" (→ P_SLEEP). First-boot before pairing should look idle
// to the user, not like a malfunction. Set inside derive() so we
// can't drift out of sync with the bleSecure() polling cadence.
static bool _wasEverSecure = false;

// Map named state string from bridge to PersonaState.
// Returns P_IDLE for unknown/empty strings (safe fallback).
static PersonaState nameToPersona(const char* name) {
  if (!name || !name[0]) return P_IDLE;
  // Order matters: longest-match first for prefixes
  struct Entry { const char* name; PersonaState ps; };
  static const Entry map[] = {
    {"sleeping",    P_SLEEP},
    {"idle",        P_IDLE},
    {"working",     P_BUSY},
    {"thinking",    P_ATTENTION},
    {"attention",   P_CELEBRATE},
    {"juggling",    P_JUGGLING},
    {"sweeping",    P_SWEEPING},
    {"notification",P_NOTIFICATION},
    {"carrying",    P_CARRYING},
    {"error",       P_ERROR},
    {"celebrate",   P_CELEBRATE},
    {"building",    P_BUILDING},
    {"reading",     P_READING},
    {"bubble",      P_BUBBLE},
    {"debugger",    P_DEBUGGER},
    {"annoyed",     P_ANNOYED},
  };
  for (const auto& e : map) {
    if (strcmp(name, e.name) == 0) return e.ps;
  }
  return P_IDLE;
}

PersonaState derive(const TamaState& s) {
  bool sec = bleSecure();
  if (sec) _wasEverSecure = true;
  if (!settings().bt) return P_SLEEP;
  if (_wasEverSecure && !sec) return P_ERROR;
  if (!s.connected)            return P_SLEEP;

  // If the bridge sent a named persona state, use it directly.
  // This allows the full clawd-on-desk expression set to be driven
  // from Claude Code hooks via the bridge runtime.
  if (s.personaState[0]) return nameToPersona(s.personaState);

  // Fallback: derive from session counters (legacy behavior)
  if (s.sessionsWaiting > 0)   return P_ATTENTION;
  if (s.recentlyCompleted)     return P_CELEBRATE;
  if (s.sessionsRunning >= 1)  return P_BUSY;
  return P_IDLE;
}

void triggerOneShot(PersonaState s, uint32_t durMs) {
  activeState = s;
  oneShotUntil = millis() + durMs;
}

bool checkShake() {
  float ax, ay, az;
  M5.Imu.getAccelData(&ax, &ay, &az);
  float mag = sqrtf(ax*ax + ay*ay + az*az);
  float delta = fabsf(mag - accelBaseline);
  accelBaseline = accelBaseline * 0.95f + mag * 0.05f;
  return delta > 0.8f;
}

void drawPasskey() {
  const Palette& p = characterPalette();
  spr.fillSprite(p.bg);
  spr.setTextSize(1);
  spr.setTextColor(p.textDim, p.bg);
  spr.setCursor(8, 56);  spr.print("BLUETOOTH PAIRING");
  spr.setCursor(8, 184); spr.print("enter on desktop:");
  spr.setTextSize(3);
  spr.setTextColor(p.text, p.bg);
  char b[8]; snprintf(b, sizeof(b), "%06lu", (unsigned long)blePasskey());
  spr.setCursor((W - 18 * 6) / 2, 110);
  spr.print(b);
}

void setup() {
  M5.begin();
  M5.Lcd.setRotation(0);
  M5.Imu.Init();
  M5.Beep.begin();
  startBt();
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);   // off
  applyBrightness();
  lastInteractMs = millis();
  statsLoad();
  settingsLoad();
  petNameLoad();

  bleSetEnabled(settings().bt);
  spr.createSprite(W, H);
  characterInit(nullptr);  // scan /characters/ for whatever is installed
  characterInvalidate();

  {
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    spr.setTextDatum(MC_DATUM);
    spr.setTextSize(2);
    if (ownerName()[0]) {
      char line[40];
      snprintf(line, sizeof(line), "%s's", ownerName());
      spr.setTextColor(p.text, p.bg);   spr.drawString(line, W/2, H/2 - 12);
      spr.setTextColor(p.body, p.bg);   spr.drawString(petName(), W/2, H/2 + 12);
    } else {
      // First boot, no owner pushed yet. Show the firmware product identity.
      spr.setTextColor(p.body, p.bg);   spr.drawString(CLAWSTICK_PRODUCT_NAME, W/2, H/2 - 12);
      spr.setTextSize(1);
      spr.setTextColor(p.textDim, p.bg);
      spr.drawString(CLAWSTICK_BOOT_SUBTITLE, W/2, H/2 + 12);
    }
    spr.setTextDatum(TL_DATUM); spr.setTextSize(1);
    spr.pushSprite(0, 0);
    delay(1800);
  }

  // Wipe the boot splash to plan §1.1 BG (0x1082) so the GIF region's
  // 7 px left/right padding (between the 120-wide GIF canvas and the
  // 135-wide screen) doesn't show a different shade until the first
  // character state change clears it. Using 0x0000 here would leave a
  // transient "black bars" effect on either side of the GIF on the
  // first frames.
  spr.fillSprite(0x1082);
  spr.pushSprite(0, 0);

  Serial.printf("[char] %s\n", characterLoaded() ? "GIF character loaded" : "no character installed");
}

void loop() {
  M5.update();
  M5.Beep.update();
  t++;
  uint32_t now = millis();
  clockRefreshRtc();   // 1Hz internal throttle; also caches _onUsb
  bleSetExternalPower(_onUsb);
  blePoll();

  dataPoll(&tama);

  // Plan §3.5 / §3.5.1: transport-degradation edge handling. When BLE
  // secure goes away mid-prompt, drop the active prompt immediately so
  // the approval overlay disappears and any subsequent A/B press cannot
  // emit a `permission` decision over an unauthenticated channel. The
  // _applyJson() side already guards prompt *arrival*; this is the
  // matching guard for prompts that arrived legitimately but whose
  // transport degraded before the user responded.
  //
  // Suppressing the late reply isn't needed as a separate flag: clearing
  // promptId makes inPrompt evaluate false on the falling edge, and the
  // A/B release paths gate on inPrompt before constructing the JSON.
  {
    static bool _prevSecure = false;
    bool sec = bleSecure();
    if (_prevSecure && !sec && tama.promptId[0]) {
      Serial.println("[xfer] transport insecure → drop active prompt");
      tama.promptId[0]   = 0;
      tama.promptTool[0] = 0;
      tama.promptHint[0] = 0;
      tama.promptChoiceCount = 0;
      responseSent = true;                  // belt-and-suspenders
      dataSetSuppressPromptClear(false);    // L4-3 #2 hygiene
      // L4-3 #12: eat the in-progress button cycle. If the user was
      // already pressing A/B when the transport dropped, swallowBtn
      // ensures the release falls through to no-op instead of cycling
      // the main card / opening the menu. The flags clear naturally on
      // wasReleased / wasPressed, so we only need to set them here.
      swallowBtnA = true;
      swallowBtnB = true;
    }
    _prevSecure = sec;
  }

  // L3-1: token-driven level-up was a fork artifact (Clawd path never
  // pushed tokens, so this never fired). Plan §3.3 method B level = approvals
  // / 50 is computed synchronously inside statsOnApproval(), no separate
  // poll needed. The celebrate trigger lives with the Approval overlay
  // rewrite (L4) where it can react to the approval *and* see RTC state.
  baseState = derive(tama);

  // After waking the screen, hold sleep for 12s so users see the wake-up
  // animation. Urgent states (attention, celebrate, busy) override this.
  if (baseState == P_IDLE && (int32_t)(now - wakeTransitionUntil) < 0) baseState = P_SLEEP;

  if ((int32_t)(now - oneShotUntil) >= 0) activeState = baseState;

  // shake → dizzy
  if (now - lastShakeCheck > 50) {
    lastShakeCheck = now;
    if (!menuOpen && !screenOff && checkShake() && (int32_t)(now - oneShotUntil) >= 0) {
      wake();
      // Shake feeds the mood penalty (plan §3.3: ≥3 shakes in 5min →
      // mood base -=2). Critically NOT counted as a button interaction —
      // fork's wake() shake-interlock bug (it bumped lastInteractMs and
      // got mood credit for the same event that was supposed to dock it)
      // is avoided because statsOnShakeDetected() touches only the shake
      // ring + counter, never lastButtonInteractMs.
      statsOnShakeDetected();
      triggerOneShot(P_DIZZY, 2000);
      Serial.println("shake: dizzy");
    }
  }

  // Post-response "sent..." hold (plan §3.6): after A/B has been
  // accepted, keep the approval overlay visible for 1.5 s showing
  // "sent..." then clear promptId so the main card returns. responseAt
  // is set in the A/B release paths; the new-prompt reset path below
  // also zeroes it so a follow-up prompt isn't held by stale timing.
  static uint32_t responseAt = 0;
  if (responseSent && responseAt && (millis() - responseAt) >= 1500) {
    tama.promptId[0]   = 0;
    tama.promptTool[0] = 0;
    tama.promptHint[0] = 0;
    tama.promptChoiceCount = 0;
    responseAt = 0;
    dataSetSuppressPromptClear(false);   // L4-3 #2: release the hold
    // responseSent stays true until the next prompt arrives; the
    // promptId comparison block below would otherwise treat the
    // "" -> "" no-op as no change and never reset it.
  }

  // Prompt arrival: beep, reset response flag
  if (strcmp(tama.promptId, lastPromptId) != 0) {
    strncpy(lastPromptId, tama.promptId, sizeof(lastPromptId)-1);
    lastPromptId[sizeof(lastPromptId)-1] = 0;
    responseSent = false;
    responseAt = 0;
    choiceSel = 0;
    dataSetSuppressPromptClear(false);   // L4-3 #2: new prompt cancels any stale hold
    if (tama.promptId[0]) {
      promptArrivedMs = millis();
      wake();
      beep(1200, 80);   // alert chirp
      // Jump to the approval screen no matter what was open
      menuOpen = settingsOpen = resetOpen = aboutOpen = false;
      characterInvalidate();
    }
  }

  // Prompt is only honored on a secure transport (plan §3.5: Approval
  // must bind to secure transport, otherwise insecure protocol replay
  // could force a decision). L4-1 added the transport-edge guard
  // above; inPrompt remains the "A/B may emit a decision" predicate.
  // showApproval is broader: it keeps the overlay visible through
  // the post-response "sent..." hold so the user sees their press
  // landed before the screen flips back to the main card.
  bool inPrompt = tama.promptId[0] && !responseSent && bleSecure();
  bool showApproval = tama.promptId[0] && bleSecure();

  // LED: blink on approval prompt or error state; off otherwise
  {
    bool needBlink = false;
    if (settings().led) {
      if (inPrompt) needBlink = true;
      if (activeState == P_ERROR) needBlink = true;
    }
    if (needBlink) {
      digitalWrite(LED_PIN, (now / 400) % 2 ? LOW : HIGH);
    } else {
      digitalWrite(LED_PIN, HIGH);
    }
  }

  // Button-press wake. Track which button woke the screen so its full
  // press cycle (including long-press) is swallowed.
  bool anyButtonPressed = M5.BtnA.isPressed() || M5.BtnB.isPressed();
  if (sleepWakeBlocked) {
    if (!anyButtonPressed) sleepWakeBlocked = false;
  } else if (anyButtonPressed) {
    if (screenOff) {
      if (M5.BtnA.isPressed()) swallowBtnA = true;
      if (M5.BtnB.isPressed()) swallowBtnB = true;
    }
    wake();
  }

  // AXP power button (left side): short-press toggles screen off.
  // Long-press (6s) still powers off the device via AXP hardware.
  if (M5.Axp.GetBtnPress() == 0x02) {
    if (screenOff) {
      wake();
    } else {
      M5.Axp.SetLDO2(false);
      screenOff = true;
    }
  }

  // L4-3 #9 / #11: overlay input-capture gate (plan §3.5.1). While
  // passkey or approval is on screen, button events must NOT fall
  // through to main-card or menu behavior. Renders use showApproval;
  // routing previously used inPrompt and diverged during the post-
  // response 1.5 s sent... hold (responseSent=true -> inPrompt=false
  // but showApproval still true) — which was letting A short-press
  // cycle the main card under a visible "sent..." overlay. The only
  // input that produces a side-effect under capture is the A/B JSON
  // decision, gated on inPrompt && bleSecure() (re-checked at send
  // time per L4-3 #1 against intra-frame transport drops).
  bool overlayCapturesInput = (blePasskey() != 0) || showApproval;

  if (M5.BtnA.pressedFor(600) && !btnALong && !swallowBtnA) {
    btnALong = true;
    if (overlayCapturesInput) {
      // Approval long-press would otherwise lose the prompt to Menu
      // (plan §3.5.1); passkey long-press has no defined behavior.
      // Eat silently — no beep, no overlay state change.
    } else {
      statsOnButtonInteract();
      beep(800, 60);
      if (resetOpen) { resetOpen = false; }
      else if (settingsOpen) { settingsOpen = false; menuOpen = true; }
      else if (aboutOpen) { aboutOpen = false; menuOpen = true; }
      else {
        menuOpen = !menuOpen;
        menuSel = 0;
        powerConfirmUntil = 0;
        if (!menuOpen) characterInvalidate();
      }
      Serial.println(menuOpen ? "menu open" : "menu close");
    }
  }
  if (M5.BtnA.wasReleased()) {
    if (!btnALong && !swallowBtnA) {
      statsOnButtonInteract();
      if (overlayCapturesInput) {
        // Only inPrompt + a still-secure transport may emit a decision.
        if (showApproval && inPrompt && bleSecure()) {
          if (tama.promptChoiceCount > 0) {
            // Choices mode: A cycles through options
            choiceSel = (choiceSel + 1) % tama.promptChoiceCount;
            beep(1800, 30);
          } else {
            // Legacy mode: A = allow
            char cmd[96];
            snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"once\"}", tama.promptId);
            sendCmd(cmd);
            responseSent = true;
            responseAt = millis();
            dataSetSuppressPromptClear(true);
            uint32_t tookS = (millis() - promptArrivedMs) / 1000;
            statsOnApproval(tookS);
            beep(2400, 60);
            if (tookS < 5) triggerOneShot(P_HEART, 2000);
          }
        }
        // else: passkey screen / sent... hold / racing-transport — silent.
      } else if (aboutOpen) {
        beep(1800, 30);
        aboutOpen = false;
        menuOpen = true;
      } else if (resetOpen) {
        beep(1800, 30);
        resetSel = (resetSel + 1) % ui_reset::kItemCount;
        resetConfirmIdx = 0xFF;
      } else if (settingsOpen) {
        beep(1800, 30);
        settingsSel = (settingsSel + 1) % ui_settings::kItemCount;
      } else if (menuOpen) {
        beep(1800, 30);
        menuSel = (menuSel + 1) % ui_menu::kItemCount;
        powerConfirmUntil = 0;
      } else {
        // Main card: cycle HOME → STATS → LINK → HOME (plan §3.1).
        beep(1800, 30);
        ui_router::next();
      }
    }
    btnALong = false;
    swallowBtnA = false;
  }

  if (M5.BtnB.wasPressed()) {
    if (swallowBtnB) {
      swallowBtnB = false;
    } else {
      statsOnButtonInteract();
      if (overlayCapturesInput) {
        if (showApproval && inPrompt && bleSecure()) {
          if (tama.promptChoiceCount > 0) {
            // Choices mode: B confirms selected choice
            const char* choice = tama.promptChoices[choiceSel];
            // Map choice text to decision: "No" or "Deny" -> deny, else allow
            bool isDeny = (strcmp(choice, "No") == 0 || strcmp(choice, "Deny") == 0);
            char cmd[128];
            if (isDeny) {
              snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"deny\"}", tama.promptId);
              statsOnDenial();
              beep(600, 60);
            } else {
              // "Yes, always" -> "always", anything else -> "once"
              bool isAlways = (strstr(choice, "always") != nullptr || strstr(choice, "Always") != nullptr);
              snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"%s\"}", tama.promptId, isAlways ? "always" : "once");
              uint32_t tookS = (millis() - promptArrivedMs) / 1000;
              statsOnApproval(tookS);
              beep(2400, 60);
              if (tookS < 5) triggerOneShot(P_HEART, 2000);
            }
            sendCmd(cmd);
            responseSent = true;
            responseAt = millis();
            dataSetSuppressPromptClear(true);
          } else {
            // Legacy mode: B = deny
            char cmd[96];
            snprintf(cmd, sizeof(cmd), "{\"cmd\":\"permission\",\"id\":\"%s\",\"decision\":\"deny\"}", tama.promptId);
            sendCmd(cmd);
            responseSent = true;
            responseAt = millis();
            dataSetSuppressPromptClear(true);
            statsOnDenial();
            beep(600, 60);
          }
        }
        // else: passkey / sent / race — silent.
      } else if (aboutOpen) {
        beep(2400, 30);
        aboutOpen = false;
        menuOpen = true;
      } else if (resetOpen) {
        beep(2400, 30);
        applyReset(resetSel);
      } else if (settingsOpen) {
        beep(2400, 30);
        applySetting(settingsSel);
      } else if (menuOpen) {
        beep(2400, 30);
        menuConfirm();
      } else if (ui_router::current() == ui_router::CARD_LINK) {
        // LINK card B = manual BLE reconnect (plan §3.4 caption).
        // wakeAdvertising re-opens the short discoverability window
        // so the desktop can reconnect without a full bond cycle.
        beep(2400, 30);
        bleWakeAdvertising();
      }
      // else: B short on HOME/STATS — no-op (plan §3.5.1 dispatch table)
    }
  }

  static uint32_t lastPasskey = 0;
  uint32_t pk = blePasskey();
  if (pk && !lastPasskey) { wake(); beep(1800, 60); }
  lastPasskey = pk;

  // Render dispatch.
  // L3-2: temporarily routes to ui_stats::render() so the STATS card's
  // layout can be eyeballed on Plus2 with real stats values. HOME is not
  // visible during L3-2/L3-3; L3-4 ui_router::render() puts all three
  // cards behind the A-button cycle and HOME comes back. Refusing to ship
  // L3-2/L3-3 without visual verification has been the project's working
  // norm (see plan §5 L0a-1 visual iteration); this temporary swap is
  // strictly less invasive than wiring router stubs before the screens
  // are visually approved.
  //
  // Napping no longer skips render (plan §2.3); only screen-off does.
  if (screenOff) {
    // skip sprite render — display power is off
  } else if (xferActive() && !characterLoaded()) {
    // Character-install progress is HOME's job in production, but with
    // dispatch pointing at STATS during L3-2 we still need a way to see
    // install progress (otherwise sidecar pushes a new character and the
    // STATS card silently freezes). Keep this fallback alive; it lives
    // exactly where it was in L2 ship.
    const Palette& p = characterPalette();
    spr.fillSprite(p.bg);
    spr.setTextColor(p.textDim, p.bg);
    spr.setTextSize(1);
    uint32_t done = xferProgress(), total = xferTotal();
    spr.setCursor(8, 90);
    spr.print("installing");
    spr.setCursor(8, 102);
    spr.printf("%luK / %luK", done/1024, total/1024);
    int barW = W - 16;
    spr.drawRect(8, 116, barW, 8, p.textDim);
    if (total > 0) {
      int fill = (int)((uint64_t)barW * done / total);
      if (fill > 1) spr.fillRect(9, 117, fill - 1, 6, p.body);
    }
  } else {
    int vBat_mV = (int)(M5.Axp.GetBatVoltage() * 1000);
    int pct = (vBat_mV - 3200) / 10;
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    bool charging = _onUsb && (int)M5.Axp.GetBatCurrent() > 1;
    ui_router::render(tama, (uint8_t)activeState, (uint8_t)pct,
                      bleSecure(), _onUsb, charging,
                      ownerName(), petName());
  }
  if (!screenOff) {
    if (blePasskey()) drawPasskey();
    else if (showApproval) ui_approval::render(tama, promptArrivedMs, responseSent, choiceSel);
    else if (resetOpen) ui_reset::render(resetSel, resetConfirmIdx, resetConfirmUntil);
    else if (settingsOpen) {
      const Settings& s = settings();
      ui_settings::render(settingsSel, brightLevel, s.sound, s.bt, s.led);
    } else if (aboutOpen) {
      ui_menu::renderAbout(btName, ownerName(), petName(), bleSecure());
    } else if (menuOpen) {
      ui_menu::renderMenu(menuSel, (int32_t)(millis() - powerConfirmUntil) < 0);
    }
    spr.pushSprite(0, 0);
  }

  // Face-down nap: dim brightness, keep rendering (plan §2.3 — no longer
  // skips sprite render). Skipped during approval — you're holding it to
  // read, not sleeping it.
  static int8_t faceDownFrames = 0;
  if (!inPrompt) {
    bool down = isFaceDown();
    if (down)       { if (faceDownFrames < 20) faceDownFrames++; }
    else            { if (faceDownFrames > -10) faceDownFrames--; }
  }

  if (!napping && faceDownFrames >= 15) {
    napping = true;
    napStartMs = now;
    M5.Axp.ScreenBreath(8);
    dimmed = true;
  } else if (napping && faceDownFrames <= -8) {
    napping = false;
    // statsOnNapEnd() handles the 60s validity gate internally (plan §3.3:
    // sub-60s flips don't count) and resets energy + writes lastNapEndAt.
    // wake() is still called for the screen-off/dim path; it intentionally
    // does NOT bump mood's lastButtonInteractMs.
    statsOnNapEnd((now - napStartMs) / 1000);
    wake();
  }

  // millis() not the cached `now`: wake() runs after `now` is captured,
  // so now - lastInteractMs underflows when a button is held → flicker.
  // No auto-off on USB power.
  if (!screenOff && !inPrompt && !_onUsb
      && millis() - lastInteractMs > SCREEN_OFF_MS) {
    M5.Axp.SetLDO2(false);
    screenOff = true;
  }

#if CLAWSTICK_BENCH_HEAP
  // L0a-2 integrated bench. Once per second, publish heap snapshot + GIF
  // frame counter so the sidecar log can compute heap-min / largest-min
  // / effective fps across a 5-minute window. See plan §5 L0a-2.
  //
  // _lastLiveMs is also pinged so dataConnected() stays true throughout
  // the bench — otherwise derive() flips to P_SLEEP after 30s of no
  // companion data, and sleep.gif is a single-GIF state that freezes
  // (character.cpp single-gif state handling) which kills the fps measurement.
  static uint32_t lastBenchHeapMs = 0;
  if (millis() - lastBenchHeapMs >= 1000) {
    lastBenchHeapMs = millis();
    _lastLiveMs = millis();
    xferPublishBenchHeap();
  }
#endif

  delay(screenOff ? 100 : 16);
}
