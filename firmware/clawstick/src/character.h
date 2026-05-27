#pragma once
#include <stdint.h>

struct Palette {
  uint16_t body, bg, text, textDim, ink;
};

// Call after M5.begin() and spr.createSprite(). Mounts LittleFS, reads
// /characters/<name>/manifest.json, parses colors, caches GIF paths.
bool characterInit(const char* name);
bool characterLoaded();

// 0..7: sleep, idle, busy, attention, celebrate, dizzy, heart, error.
// Closes current GIF, opens the one for this state. No-op if same state.
void characterSetState(uint8_t state);

// Advances timing; if it's time for the next frame, decodes it into the
// sprite. Call every loop iteration. Does nothing if not loaded.
void characterTick();
void characterInvalidate();
void characterClose();   // close GIF + clear loaded flag; FS stays mounted

const Palette& characterPalette();

#if CLAWSTICK_BENCH_HEAP
// Cumulative count of successful GIF frame plays since boot. Drives the
// L0a-2 integrated bench fps computation: sample at two timestamps,
// (frames_t1 - frames_t0) / (t1 - t0) = effective fps. Wrapped in
// CLAWSTICK_BENCH_HEAP so the production build has no symbol at all.
uint32_t characterFramesPlayed();
#endif
