#!/usr/bin/env python3
"""Verify a GIF is unoptimized full-frame, matching the assumption in
firmware/clawstick/src/character.cpp:108 ("GIFs are unoptimized full-frame
(gifsicle --unoptimize --lossy)").

Every image descriptor in the GIF must:
  - left == 0, top == 0
  - width == logical screen width, height == logical screen height

Exits 0 on pass, 1 on fail. Prints per-frame layout either way.

Usage:
  python tools/verify-gif-fullframe.py path/to/file.gif
"""
import struct
import sys


def parse_gif(data: bytes):
    if data[0:6] not in (b"GIF87a", b"GIF89a"):
        raise ValueError(f"not a GIF: header={data[0:6]!r}")
    lsd_w, lsd_h, packed = struct.unpack("<HHB", data[6:11])
    pos = 13
    if packed & 0x80:
        pos += 3 * (1 << ((packed & 7) + 1))

    frames = []
    last_disposal = None
    last_transparent = None
    while pos < len(data):
        b = data[pos]
        if b == 0x21:  # extension
            ext_label = data[pos + 1]
            if ext_label == 0xF9:  # Graphics Control Extension
                gcf_packed = data[pos + 3]
                last_disposal = (gcf_packed >> 2) & 0x07
                last_transparent = bool(gcf_packed & 0x01)
            pos += 2
            while pos < len(data):
                sz = data[pos]
                pos += 1
                if sz == 0:
                    break
                pos += sz
        elif b == 0x2C:  # image descriptor
            left, top, w, h, packed_id = struct.unpack("<HHHHB", data[pos + 1:pos + 10])
            frames.append({
                "left": left, "top": top, "w": w, "h": h,
                "disposal": last_disposal, "transparent": last_transparent,
            })
            pos += 10
            if packed_id & 0x80:
                pos += 3 * (1 << ((packed_id & 7) + 1))
            pos += 1  # LZW min code size
            while pos < len(data):
                sz = data[pos]
                pos += 1
                if sz == 0:
                    break
                pos += sz
        elif b == 0x3B:
            break
        else:
            raise ValueError(f"unknown block 0x{b:02x} at offset {pos}")
    return lsd_w, lsd_h, frames


def main():
    if len(sys.argv) != 2:
        print("usage: verify-gif-fullframe.py <file.gif>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    with open(path, "rb") as f:
        data = f.read()
    lsd_w, lsd_h, frames = parse_gif(data)
    print(f"{path}: {len(data)} bytes, logical {lsd_w}x{lsd_h}, {len(frames)} frames")
    fails = []
    for i, fr in enumerate(frames):
        full = (fr["left"] == 0 and fr["top"] == 0
                and fr["w"] == lsd_w and fr["h"] == lsd_h)
        tag = "OK   " if full else "FAIL "
        print(f"  {tag} frame {i}: left={fr['left']:3d} top={fr['top']:3d} "
              f"w={fr['w']:3d} h={fr['h']:3d} disposal={fr['disposal']} "
              f"transp={fr['transparent']}")
        if not full:
            fails.append(i)
    if fails:
        print(f"\nFAIL: {len(fails)}/{len(frames)} frames are sub-rectangles "
              f"(indices: {fails}). Re-encode with gifsicle --unoptimize or "
              f"ffmpeg -gifflags -transdiff.", file=sys.stderr)
        sys.exit(1)
    print(f"\nPASS: all {len(frames)} frames are full {lsd_w}x{lsd_h} frames.")


if __name__ == "__main__":
    main()
