#!/usr/bin/env python3
"""Render a CSS-animated SVG into a frame sequence (intermediate GIF) by
freezing the animation at evenly-spaced time points with Playwright/Chromium.

Does NOT modify the source SVG. The pause trick is to inject a CSS rule:
    * { animation-delay: var(--t, 0s) !important;
        animation-play-state: paused !important; }
and then update --t per frame, which forces Chromium to re-resolve every
animation's delay and render that exact moment.

Output is an unoptimized GIF that should be post-processed by
tools/preprocess-gif.py for size/palette/full-frame guarantees before
landing on LittleFS.

Usage:
  python tools/svg-anim-to-frames.py INPUT.svg OUTPUT.gif
      [--frames 16] [--start-s 0] [--end-s 8.8]
      [--render-size 480] [--bg-hex 101010] [--per-frame-ms 550]
"""
import argparse
import io
import sys

from PIL import Image
from playwright.sync_api import sync_playwright


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svg_path")
    ap.add_argument("out_gif")
    ap.add_argument("--frames", type=int, default=16)
    ap.add_argument("--start-s", type=float, default=0.0,
                    help="animation time to start sampling at, seconds")
    ap.add_argument("--end-s", type=float, default=8.8,
                    help="animation time to end sampling at, seconds. "
                         "Pick a value that lands on a keyframe matching "
                         "the 0%% state so the loop closes cleanly.")
    ap.add_argument("--render-size", type=int, default=480,
                    help="offscreen render canvas size in px (square)")
    ap.add_argument("--viewbox", default=None,
                    help="override SVG viewBox at render time to crop "
                         "around the character. Source file is not "
                         "modified. Example: '0 4 15 15' to tighten "
                         "Clawd's bbox to a 15x15 square.")
    ap.add_argument("--bg-hex", default="101010",
                    help="render-canvas background color. Default #101010 "
                         "matches the firmware screen bg so SVG-transparent "
                         "pixels inside the character bbox blend with the "
                         "final GIF's letterbox padding instead of getting "
                         "quantized away to pure black (which would create "
                         "visible black bars on screen).")
    ap.add_argument("--per-frame-ms", type=int, default=550,
                    help="GIF per-frame duration. Default 550ms = "
                         "8.8s/16 frames so the output GIF plays at the "
                         "same wall-clock pace as the source animation.")
    args = ap.parse_args()

    with open(args.svg_path, "r", encoding="utf-8") as f:
        svg_content = f.read()

    bg = args.bg_hex
    html = f"""<!DOCTYPE html>
<html><head><style>
  html, body {{ margin: 0; padding: 0; background: #{bg}; }}
  #wrap {{
    width: {args.render_size}px;
    height: {args.render_size}px;
    display: flex; align-items: center; justify-content: center;
    background: #{bg};
  }}
  #wrap svg {{ width: 100%; height: 100%; display: block; }}
  /* Freeze every animation at --t */
  *, *::before, *::after {{
    animation-delay: var(--t, 0s) !important;
    animation-play-state: paused !important;
  }}
</style></head>
<body>
  <div id="wrap">{svg_content}</div>
</body></html>
"""

    frames_pil = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={
            "width": args.render_size, "height": args.render_size,
        })
        page.set_content(html, wait_until="domcontentloaded")

        if args.viewbox:
            page.evaluate(
                "(vb) => document.querySelector('svg').setAttribute('viewBox', vb)",
                args.viewbox,
            )

        # Pre-warm: first paint can be slow; do a throwaway screenshot.
        page.locator("#wrap").screenshot()

        for i in range(args.frames):
            # End-s is the loop point — we sample [start_s, end_s) so we
            # don't duplicate the start frame at the end.
            t = args.start_s + (args.end_s - args.start_s) * i / args.frames
            page.evaluate(
                f"document.documentElement.style.setProperty('--t', '-{t:.4f}s')"
            )
            # Force a synchronous style/layout flush before screenshotting.
            page.evaluate(
                "void getComputedStyle(document.documentElement)"
                ".getPropertyValue('--t')"
            )
            png_bytes = page.locator("#wrap").screenshot()
            frames_pil.append(
                Image.open(io.BytesIO(png_bytes)).convert("RGB"))
            print(f"  frame {i:2d}: t={t:.3f}s", file=sys.stderr)

        browser.close()

    frames_pil[0].save(
        args.out_gif,
        save_all=True,
        append_images=frames_pil[1:],
        duration=args.per_frame_ms,
        loop=0,
        disposal=2,
        optimize=False,
    )
    import os
    print(f"wrote {args.out_gif}: {len(frames_pil)} frames "
          f"@ {args.render_size}x{args.render_size} from "
          f"t=[{args.start_s}, {args.end_s})s, "
          f"size={os.path.getsize(args.out_gif)} bytes")


if __name__ == "__main__":
    main()
