#!/usr/bin/env python3
"""Preprocess a source GIF into an unoptimized, full-frame GIF suitable
for the clawstick firmware GIF pipeline.

Output guarantees (verified):
  - Every frame's image descriptor is left=0, top=0, w=width, h=height
  - Disposal method = 0 (no disposal)
  - No transparency
  - Single global color table (≤ 64 entries default), shared across all frames
  - Floyd-Steinberg dither for smooth pixel-art

Why this pipeline (and not gifsicle):
  - Plan §5 L0b calls for `gifsicle --unoptimize --lossy=80`, but gifsicle
    isn't on the Windows toolchain. Pillow can produce full-frame GIFs
    only when disposal=2 is set (otherwise its encoder falls back to
    sub-rectangle frame-diff optimization). We then binary-patch the
    disposal byte back to 0 so the runtime decoder doesn't trigger any
    fill-bg behaviour.

Usage:
  python tools/preprocess-gif.py INPUT.gif OUTPUT.gif [--width 120]
      [--height 120] [--frames 8] [--source-duration-s 1.0]
      [--colors 64] [--duration-ms 125] [--bg-hex 101010]
      [--auto-bbox] [--fill-ratio 0.85] [--margin-bottom 4]

Then run tools/verify-gif-fullframe.py OUTPUT.gif to confirm.
"""
import argparse

from PIL import Image, ImageChops


def patch_disposal_to_zero(data: bytes) -> bytes:
    """Walk the GIF byte stream and clear the disposal field (bits 2-4 of
    the Graphics Control Extension packed byte) in every GCE block.

    GCE format: 0x21 0xF9 0x04 <packed> <delay_lo> <delay_hi> <transparent> 0x00
    """
    out = bytearray(data)
    i = 0
    end = len(out) - 8
    patched = 0
    while i <= end:
        if out[i] == 0x21 and out[i + 1] == 0xF9 and out[i + 2] == 0x04:
            packed = out[i + 3]
            out[i + 3] = packed & ~0x1C  # clear disposal bits 2-4
            patched += 1
            i += 8
        else:
            i += 1
    return bytes(out), patched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--width", type=int, default=120)
    ap.add_argument("--height", type=int, default=120)
    ap.add_argument("--frames", type=int, default=8,
                    help="number of output frames")
    ap.add_argument("--source-duration-s", type=float, default=1.0,
                    help="sample window from the source GIF in seconds. "
                         "Pairs with --frames: e.g. frames=8 + duration=1.0 "
                         "on an 8-fps source yields continuous frames (no "
                         "skipping → no rubber-band rush). frames < window "
                         "frames means even subsampling within the window.")
    ap.add_argument("--colors", type=int, default=64)
    ap.add_argument("--duration-ms", type=int, default=0,
                    help="per-frame duration in ms. 0 (default) = inherit "
                         "the source GIF's per-frame duration (preserves "
                         "animator-designed pace). Override only for "
                         "deliberate slow/fast playback.")
    ap.add_argument("--bg-hex", default="101010",
                    help="background color hex to flatten transparent pixels onto")
    ap.add_argument("--auto-bbox", action="store_true",
                    help="auto-detect the character bbox (union of non-"
                         "transparent regions across all sampled frames) "
                         "and crop to it before resize. Then letterbox-pad "
                         "to (width, height) preserving aspect ratio. "
                         "Needed for source GIFs where the character "
                         "doesn't fill the canvas (e.g. animator-authored "
                         "240x240 emoji with whitespace around Clawd). "
                         "No-op for SVG-rendered inputs that already fill.")
    ap.add_argument("--fill-ratio", type=float, default=0.85,
                    help="character occupies this fraction of the target "
                         "canvas's shorter side; rest is bg padding. "
                         "Smaller = more breathing room around Clawd "
                         "(more 'precious' look). Use 1.0 for edge-to-edge.")
    ap.add_argument("--margin-bottom", type=int, default=4,
                    help="pixels of bg padding below the character when "
                         "--align=bottom. Other modes ignore this.")
    ap.add_argument("--margin-top", type=int, default=4,
                    help="pixels of bg padding above the character when "
                         "--align=top. Other modes ignore this.")
    ap.add_argument("--align", choices=("top", "bottom", "center"),
                    default="bottom",
                    help="vertical placement of the character inside the "
                         "canvas. 'bottom' (default) shares a baseline "
                         "across GIFs (good for ground-standing); 'top' "
                         "aligns the character head to the canvas top "
                         "(good for HOME cards under a status bar where "
                         "fixed-y screen rendering wants the sprite's "
                         "head, not its feet, at a known location); "
                         "'center' splits the padding.")
    args = ap.parse_args()

    bg = tuple(int(args.bg_hex[i:i + 2], 16) for i in (0, 2, 4))

    src = Image.open(args.input)
    n_src = getattr(src, "n_frames", 1)

    # Compute the source-frame window that corresponds to source-duration-s.
    # GIF per-frame duration (ms) lives in im.info['duration']; assume the
    # first frame's value is representative (animator-authored emoji GIFs
    # rarely vary this).
    src.seek(0)
    frame_dur_ms = max(1, int(src.info.get("duration", 100)))
    src_fps = 1000.0 / frame_dur_ms
    window_frames = max(args.frames, min(n_src, int(round(args.source_duration_s * src_fps))))

    indices = [int(i * window_frames / args.frames) for i in range(args.frames)]
    print(f"source: {n_src} frames @ ~{src_fps:.1f} fps "
          f"({n_src * frame_dur_ms / 1000:.1f}s total); "
          f"sampling {args.frames} frames from window [0, {window_frames}) "
          f"= {args.source_duration_s}s @ source rate; "
          f"output indices: {indices}")

    # Optional: detect union character bbox across sampled frames so each
    # source GIF gets framed consistently regardless of its native whitespace.
    crop_bbox = None
    if args.auto_bbox:
        # Sample bg from the top-left corner of frame 0, then diff every
        # frame against that bg via ImageChops to find character bboxes.
        # This handles both source GIFs (corner = (0,0,0) after RGBA→RGB
        # flatten since transparent pixels collapse to black) and
        # SVG-rendered intermediates (corner = wrapper bg color, e.g.
        # #101010). Crucially, SVG-transparent pixels inside the character
        # bbox also collapse to the same bg color, so they don't dominate
        # the palette and force letterbox padding to be quantized to black.
        src.seek(0)
        bg_sample = src.convert("RGBA")
        bg_flat = Image.new("RGB", bg_sample.size, (0, 0, 0))
        bg_flat.paste(bg_sample, mask=bg_sample.split()[3])
        bg_corner = bg_flat.getpixel((0, 0))
        bg_canvas = Image.new("RGB", bg_sample.size, bg_corner)

        union = None
        for i in indices:
            src.seek(i)
            rgba = src.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (0, 0, 0))
            flat.paste(rgba, mask=rgba.split()[3])
            diff = ImageChops.difference(flat, bg_canvas)
            b = diff.getbbox()
            if b is None:
                continue
            union = b if union is None else (
                min(union[0], b[0]), min(union[1], b[1]),
                max(union[2], b[2]), max(union[3], b[3]),
            )
        if union:
            crop_bbox = union
            print(f"auto-bbox: bg={bg_corner} union={union} "
                  f"({union[2]-union[0]}x{union[3]-union[1]})")

    # Inner box (character bbox scaled to fit). Both dimensions get the
    # same max so wide and tall characters share a baseline-friendly size.
    inner_max = int(min(args.width, args.height) * args.fill_ratio)

    flat_rgb = []
    for i in indices:
        src.seek(i)
        rgba = src.convert("RGBA")
        if crop_bbox:
            rgba = rgba.crop(crop_bbox)
        char_w, char_h = rgba.size
        scale = min(inner_max / char_w, inner_max / char_h)
        new_w = max(1, int(round(char_w * scale)))
        new_h = max(1, int(round(char_h * scale)))
        scaled = rgba.resize((new_w, new_h), Image.NEAREST)
        # Compose: horizontally centered; vertical placement per --align.
        canvas = Image.new("RGB", (args.width, args.height), bg)
        paste_x = (args.width - new_w) // 2
        if args.align == "top":
            paste_y = args.margin_top
        elif args.align == "center":
            paste_y = (args.height - new_h) // 2
        else:  # "bottom"
            paste_y = args.height - new_h - args.margin_bottom
        if paste_y < 0:
            paste_y = 0
        canvas.paste(scaled, (paste_x, paste_y), mask=scaled.split()[3])
        flat_rgb.append(canvas)

    master = flat_rgb[0].quantize(
        colors=args.colors, method=Image.Quantize.MEDIANCUT)
    frames_p = [
        fr.quantize(palette=master, dither=Image.Dither.FLOYDSTEINBERG)
        for fr in flat_rgb
    ]

    # Phase 1: write with disposal=2 to trick Pillow into emitting full-frame
    # image descriptors (Pillow only skips its sub-rect optimization when
    # the prior frame's pixels are guaranteed to be erased).
    import io
    buf = io.BytesIO()
    out_duration_ms = args.duration_ms if args.duration_ms > 0 else frame_dur_ms
    frames_p[0].save(
        buf,
        format="GIF",
        save_all=True,
        append_images=frames_p[1:],
        duration=out_duration_ms,
        loop=0,
        disposal=2,
        optimize=False,
    )
    raw = buf.getvalue()

    # Phase 2: binary-patch disposal=2 → disposal=0 (no disposal). Each
    # frame already covers the full canvas, so the runtime decoder doesn't
    # need to fill-bg between frames.
    patched, n_patches = patch_disposal_to_zero(raw)

    with open(args.output, "wb") as f:
        f.write(patched)

    print(f"wrote {args.output}: {len(patched)} bytes, {args.frames} frames "
          f"@ {args.width}x{args.height}, {args.colors} colors, "
          f"patched {n_patches} GCE block(s) disposal→0")


if __name__ == "__main__":
    main()
