#include "character.h"
#include "ui/gif-player.h"
#include <M5StickCPlus.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

extern TFT_eSprite spr;

// 16-state schema matching clawd-on-desk pet expressions.
static const char* STATE_NAMES[] = {
  "idle", "working", "thinking", "juggling", "sweeping",
  "error", "attention", "notification", "carrying", "sleeping",
  "dizzy", "building", "reading", "bubble", "debugger", "annoyed"
};
static const uint8_t N_STATES = 16;

// Maps the firmware's PersonaState (P_SLEEP=0..P_ANNOYED=16) onto the
// 16-state Clawd asset set.
static const uint8_t PERSONA_TO_STATE[18] = {
  9,  // P_SLEEP       -> sleeping
  0,  // P_IDLE        -> idle
  1,  // P_BUSY        -> working
  2,  // P_ATTENTION   -> thinking
  6,  // P_CELEBRATE   -> attention (happy)
  10, // P_DIZZY       -> dizzy
  6,  // P_HEART       -> attention (happy)
  5,  // P_ERROR       -> error
  3,  // P_JUGGLING    -> juggling
  4,  // P_SWEEPING    -> sweeping
  7,  // P_NOTIFICATION-> notification
  8,  // P_CARRYING    -> carrying
  11, // P_BUILDING    -> building
  12, // P_READING     -> reading
  13, // P_BUBBLE      -> bubble
  14, // P_DEBUGGER    -> debugger
  15, // P_ANNOYED     -> annoyed
  0,  // safety -> idle
};

static bool    loaded = false;
static Palette pal = { 0xFCE0, 0x1082, 0xFFFF, 0x7BEF, 0x0000 };
static char    basePath[48];
static char    stateFiles[N_STATES][32];
static bool    stateHasGif[N_STATES];
// Asset state index after PERSONA_TO_STATE mapping, not a PersonaState.
// Do not feed this back through characterSetState(): asset 2 "thinking"
// would be interpreted as P_BUSY and reopen "working".
static uint8_t curState = 0xFF;

// Layout: GIF centered horizontally; y=14 places the GIF canvas flush
// against the status bar. With top-aligned source GIFs (--align top in
// tools/preprocess-gif.py) the character sprite sits at y=14+4=18 in
// screen coords, 4 px below the status bar regardless of which state
// is active.
static void gifPlace() {
  int gw = gif_player::canvasWidth();
  int x = (spr.width() - gw) / 2;
  int y = 14;
  gif_player::setOrigin(x, y);
}

static uint32_t       nextFrameAt = 0;

static uint16_t parseHexColor(const char* s, uint16_t fallback) {
  if (!s) return fallback;
  if (*s == '#') s++;
  uint32_t v = strtoul(s, nullptr, 16);
  return (uint16_t)(((v >> 19) & 0x1F) << 11 | ((v >> 10) & 0x3F) << 5 | ((v >> 3) & 0x1F));
}

// Pick the boot character. Prefer "clawd" (the L2 asset set in
// data/characters/clawd/) so legacy fork characters left on the device
// from earlier flashes don't shadow it. If clawd isn't installed, fall
// back to scanning /characters/ for the first directory present.
static bool resolveCharName(char* out, size_t outSize) {
  if (LittleFS.exists("/characters/clawd/manifest.json")) {
    strncpy(out, "clawd", outSize - 1);
    out[outSize - 1] = 0;
    return true;
  }
  File d = LittleFS.open("/characters");
  if (!d || !d.isDirectory()) return false;
  File e = d.openNextFile();
  while (e) {
    if (e.isDirectory()) {
      const char* n = strrchr(e.name(), '/');
      strncpy(out, n ? n + 1 : e.name(), outSize - 1);
      out[outSize - 1] = 0;
      d.close();
      return true;
    }
    e = d.openNextFile();
  }
  d.close();
  return false;
}

// Find the STATE_NAMES index for a manifest state id. Returns N_STATES
// (out-of-range) if the id doesn't match any known state.
static uint8_t stateIndexForId(const char* id) {
  if (!id) return N_STATES;
  for (uint8_t i = 0; i < N_STATES; i++) {
    if (strcmp(id, STATE_NAMES[i]) == 0) return i;
  }
  return N_STATES;
}

// --- Public -------------------------------------------------------------

bool characterInit(const char* name) {
  if (!LittleFS.begin(false)) {
    // begin() fails if already mounted — that's fine on reload
    if (!LittleFS.open("/")) {
      Serial.println("[char] LittleFS mount failed");
      return false;
    }
  }

  static char resolved[24];
  if (!name) {
    if (!resolveCharName(resolved, sizeof(resolved))) {
      Serial.println("[char] no characters installed");
      return false;
    }
    name = resolved;
  }

  snprintf(basePath, sizeof(basePath), "/characters/%s", name);
  char mpath[64];
  snprintf(mpath, sizeof(mpath), "%s/manifest.json", basePath);

  File mf = LittleFS.open(mpath, "r");
  if (!mf) {
    Serial.printf("[char] manifest not found: %s\n", mpath);
    return false;
  }

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, mf);
  mf.close();
  if (err) {
    Serial.printf("[char] manifest parse: %s\n", err.c_str());
    return false;
  }

  JsonObject colors = doc["colors"];
  pal.body    = parseHexColor(colors["body"],    pal.body);
  pal.bg      = parseHexColor(colors["bg"],      pal.bg);
  pal.text    = parseHexColor(colors["text"],    pal.text);
  pal.textDim = parseHexColor(colors["textDim"], pal.textDim);
  pal.ink     = parseHexColor(colors["ink"],     pal.ink);

  // L2-2 schema: `states` is an array of objects with `id` and `file`.
  // Reject the old fork dict-of-state-name -> file mapping outright; if
  // a stale fork character is on the device it would land here and we
  // want a clear error rather than silently treating it as 0-state.
  JsonVariant statesVar = doc["states"];
  if (!statesVar.is<JsonArray>()) {
    Serial.printf("[char] manifest 'states' is not an array (legacy fork schema?)\n");
    return false;
  }

  for (uint8_t i = 0; i < N_STATES; i++) {
    stateFiles[i][0] = 0;
    stateHasGif[i] = false;
  }
  for (JsonVariant e : statesVar.as<JsonArray>()) {
    const char* id = e["id"];
    const char* fn = e["file"];
    if (!id || !fn) continue;
    uint8_t si = stateIndexForId(id);
    if (si >= N_STATES) continue;
    if (stateHasGif[si]) {
      Serial.printf("[char] duplicate state id '%s', keeping first\n", id);
      continue;
    }
    snprintf(stateFiles[si], sizeof(stateFiles[si]), "%s", fn);
    stateHasGif[si] = true;
  }

  gif_player::init();
  loaded = true;
  const char* dispName = doc["name"] | name;
  Serial.printf("[char] loaded '%s' from %s\n", dispName, basePath);
  return true;
}

bool characterLoaded() { return loaded; }
const Palette& characterPalette() { return pal; }

void characterClose() {
  gif_player::close();
  loaded = false;
  curState = 0xFF;
}

// Internal: open the GIF for a specific 5-state asset index (0..N_STATES-1).
// Used by characterSetState() after persona->asset mapping and by
// characterInvalidate(), which already tracks curState as an asset index.
static void openAsset(uint8_t s) {
  if (s >= N_STATES) return;
  gif_player::close();
  curState = s;

  if (!stateHasGif[s]) {
    Serial.printf("[char] no gif for state %u (%s)\n", s, STATE_NAMES[s]);
    return;
  }

  char full[80];
  snprintf(full, sizeof(full), "%s/%s", basePath, stateFiles[s]);
  if (gif_player::open(full, pal.bg)) {
    gifPlace();
    // Only clear the GIF region (y=14..134). home.cpp owns the status
    // bar (y=0..14) and the lower info area (y=138..240); fillSprite
    // here would erase them on every state change and cause flicker.
    spr.fillRect(0, 14, spr.width(), 120, pal.bg);
    nextFrameAt = 0;
    Serial.printf("[char] %s: %dx%d heap=%u\n",
      stateFiles[s], gif_player::canvasWidth(), gif_player::canvasHeight(),
      ESP.getFreeHeap());
  } else {
    Serial.printf("[char] open failed: %s (err %d)\n", full, gif_player::lastError());
  }
}

void characterInvalidate() {
  if (!loaded || curState >= N_STATES) return;
  uint8_t s = curState;
  curState = 0xFF;
  openAsset(s);
}

void characterSetState(uint8_t persona) {
  if (!loaded) return;
  // Caller passes a PersonaState from main.cpp; map to 11-state asset.
  uint8_t s = (persona < 18) ? PERSONA_TO_STATE[persona] : 0;
  if (s == curState) return;
  openAsset(s);
}

void characterTick() {
  if (!loaded) return;

  uint32_t now = millis();

  if (!gif_player::isOpen()) return;
  if (now < nextFrameAt) return;

  int delayMs = 0;
  int ret = gif_player::playNextFrame(&delayMs);
  if (!ret) {
    // End-of-animation. reset() is in-place, so all states loop without
    // closing/reopening LittleFS files.
    gif_player::reset();
    nextFrameAt = now;
    return;
  }
  nextFrameAt = now + (delayMs > 0 ? delayMs : 100);
}

#if CLAWSTICK_BENCH_HEAP
uint32_t characterFramesPlayed() { return gif_player::framesPlayed(); }
#endif
