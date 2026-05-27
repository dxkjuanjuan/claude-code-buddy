#pragma once
#include <stdint.h>

// Low-level GIF playback service. Owns the AnimatedGIF decoder, the
// LittleFS file callbacks, and the per-frame draw callback. Has no
// knowledge of manifests, palettes, or state machines. The caller is
// responsible for path + state coordination.

namespace gif_player {

// Initialize the underlying AnimatedGIF decoder with LITTLE_ENDIAN_PIXELS.
// Idempotent — safe to call before every open() or once at boot.
void init();

// Open a GIF from a LittleFS path. Any currently-open GIF is closed first.
// transparentFallback (RGB565) paints pixels the GIF marks as transparent.
// Unoptimized full-frame preprocessing (tools/preprocess-gif.py) emits
// transparent = "should look like background", not "leave previous frame
// pixels visible", so the caller passes the character/UI background here.
bool open(const char* fullPath, uint16_t transparentFallback);

// Close the current GIF (no-op if none open).
void close();

bool isOpen();

// Decode + draw the next frame into the current target. Returns the
// AnimatedGIF playFrame() result verbatim:
//   > 0  frame played, more frames remain in this loop
//   0    last frame just played (animation boundary)
//   < 0  error — inspect lastError()
// outDelayMs (nullable): the GIF-encoded delay until the next frame in ms.
int playNextFrame(int* outDelayMs);

// Restart playback at frame 0 without closing/reopening the file.
void reset();

int lastError();
int canvasWidth();
int canvasHeight();

// Top-left of the GIF canvas in target pixels. Caller computes layout
// based on canvasWidth/canvasHeight + target dimensions.
void setOrigin(int x, int y);

#if CLAWSTICK_BENCH_HEAP
// Cumulative count of successful frame plays since boot. Backing store
// for character.h's characterFramesPlayed() — kept in this module since
// the count is incremented inside playNextFrame()'s hot path.
uint32_t framesPlayed();
#endif

}  // namespace gif_player
