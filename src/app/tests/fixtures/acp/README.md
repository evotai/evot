# ACP image fixtures

These are deterministic, synthetic RGB PNGs, not user attachments.

- `red.png`: 1 × 1 pixel, RGB `(255, 0, 0)`. Distinguishes two images in the
  mixed-content ordering test.
- `wide.png`: 2400 × 1200 pixels, solid RGB `(64, 128, 192)`. Exercises the shared
  2000-pixel resize limit; the expected JPEG output is 2000 × 1000 pixels.

Both use 8-bit RGB PNG encoding (color type 2), filter 0 on every scanline,
standard PNG chunk CRCs, and zlib level 9 compression.
