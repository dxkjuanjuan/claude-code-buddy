#include "gif-player.h"
#include <M5StickCPlus.h>
#include <LittleFS.h>
#include <AnimatedGIF.h>

extern TFT_eSprite spr;

namespace gif_player {

namespace {

AnimatedGIF gif;
File        gifFile;
int         gifX = 0, gifY = 0, gifW = 0, gifH = 0;
bool        gifOpen = false;
uint16_t    transparentBg = 0x0000;
bool        beginCalled = false;
#if CLAWSTICK_BENCH_HEAP
uint32_t    framesPlayedCount = 0;
#endif

// --- AnimatedGIF file callbacks (LittleFS) ------------------------------

void* gifOpenCb(const char* fname, int32_t* pSize) {
  gifFile = LittleFS.open(fname, "r");
  if (!gifFile) return nullptr;
  *pSize = gifFile.size();
  return (void*)&gifFile;
}

void gifCloseCb(void* handle) {
  File* f = (File*)handle;
  if (f) f->close();
}

int32_t gifReadCb(GIFFILE* pFile, uint8_t* pBuf, int32_t iLen) {
  File* f = (File*)pFile->fHandle;
  int32_t n = f->read(pBuf, iLen);
  pFile->iPos = f->position();
  return n;
}

int32_t gifSeekCb(GIFFILE* pFile, int32_t iPosition) {
  File* f = (File*)pFile->fHandle;
  f->seek(iPosition);
  pFile->iPos = (int32_t)f->position();
  return pFile->iPos;
}

// --- Draw callback: one scanline → target ------------------------------
// Transparent pixels get the caller's transparentBg color so each frame
// fully paints its region — no ghosting from prior frames. The unoptimized
// full-frame preprocess pipeline (tools/preprocess-gif.py) means we never
// see real "no-paint" deltas; transparent always means background.

void gifDrawCb(GIFDRAW* d) {
  uint16_t* pal16 = d->pPalette;
  uint8_t*  src   = d->pPixels;
  uint8_t   t     = d->ucTransparent;
  bool      hasT  = d->ucHasTransparency;
  int       srcY  = d->iY + d->y;
  auto put = [&](int x, int y, uint8_t idx) {
    spr.drawPixel(x, y, (hasT && idx == t) ? transparentBg : pal16[idx]);
  };

  int y = gifY + srcY;
  if (y < 0 || y >= spr.height()) return;
  int x0 = gifX + d->iX;
  int w  = d->iWidth;
  if (w > 256) w = 256;
  if (x0 < 0) { src -= x0; w += x0; x0 = 0; }
  if (x0 + w > spr.width()) w = spr.width() - x0;
  if (w <= 0) return;
  for (int i = 0; i < w; i++) put(x0 + i, y, src[i]);
}

}  // anonymous namespace

// --- Public -------------------------------------------------------------

void init() {
  if (beginCalled) return;
  gif.begin(LITTLE_ENDIAN_PIXELS);
  beginCalled = true;
}

bool open(const char* fullPath, uint16_t transparentFallback) {
  if (gifOpen) { gif.close(); gifOpen = false; }
  transparentBg = transparentFallback;
  if (gif.open(fullPath, gifOpenCb, gifCloseCb, gifReadCb, gifSeekCb, gifDrawCb)) {
    gifOpen = true;
    gifW = gif.getCanvasWidth();
    gifH = gif.getCanvasHeight();
    return true;
  }
  return false;
}

void close() {
  if (gifOpen) { gif.close(); gifOpen = false; }
}

bool isOpen() { return gifOpen; }

int playNextFrame(int* outDelayMs) {
  int delayMs = 0;
  int ret = gif.playFrame(false, &delayMs);
#if CLAWSTICK_BENCH_HEAP
  // ret == 0 means "no more frames in this loop". Per AnimatedGIF.cpp:294
  // a frame may or may not have been drawn that call. getLastError() ==
  // GIF_SUCCESS distinguishes "played the last frame" from "nothing to do".
  // Without this branch short-loop GIFs systematically undercount fps by
  // 1/frames_per_loop on every cycle.
  if (ret > 0 || (ret == 0 && gif.getLastError() == GIF_SUCCESS)) {
    framesPlayedCount++;
  }
#endif
  if (outDelayMs) *outDelayMs = delayMs;
  return ret;
}

void reset()         { gif.reset(); }
int  lastError()     { return gif.getLastError(); }
int  canvasWidth()   { return gifW; }
int  canvasHeight()  { return gifH; }

void setOrigin(int x, int y) { gifX = x; gifY = y; }

#if CLAWSTICK_BENCH_HEAP
uint32_t framesPlayed() { return framesPlayedCount; }
#endif

}  // namespace gif_player
