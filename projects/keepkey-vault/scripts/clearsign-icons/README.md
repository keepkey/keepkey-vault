# Clear-sign icons

Tooling to turn protocol/identity logos into the 1bpp mono-RLE bitmap the
KeepKey OLED renders (`draw_bitmap_mono_rle`), for clear-sign **identity** icons
(the signer's logo, persisted on-device via `LoadClearsignSigner.icon`) and
**protocol** icons (per-tx dApp glyphs the vault sends).

Device constraints: **≤ 384 bytes**, **≤ 64×64** (48×48 recommended), 1bpp mono.

## Add an icon

1. Drop a logo into `sources/` named for its key (lowercase protocol/dApp or
   signer slug), e.g. `sources/aave.png`, `sources/pioneer.svg`. PNG/SVG/JPG all
   work — ImageMagick resizes/centers/thresholds.
2. `bun build-catalog.mjs` → writes `generated/protocol-icons.json`
   (`{ "<key>": { hex, width, height, bytes } }`). Each icon is self-verified by
   round-tripping through a mirror of the firmware decoder and checked against
   the 384-byte cap.

Simple, chunky, high-contrast logos compress best. If one exceeds 384 B:
`ICON_SIZE=32 bun build-catalog.mjs`, simplify the art, or start from a mono
source. `ICON_GRAY=1` keeps antialiased grayscale instead of a hard threshold.

## Encode one file / preview

```sh
bun encode-icon.mjs <image> [--size 48] [--gray] [--invert] [--json]
bun encode-icon.mjs --self-test          # verify the RLE codec
```

The identity icon used by the clear-sign device test lives in
`generated/identity-icons.json` (consumed by
`keepkey-sdk/tests/evm-clearsign/clearsign-signer-flows.js`).

## Format (why a custom encoder)

The firmware decoder reads a control byte as `int8`: `n>0` repeats the next
value byte `n` times; `n<0` takes the next `-n` bytes as literal pixels. Pixel =
`value * frame.color / 100`; identity frames use `color=100`, so value bytes are
direct 0–255 intensities. `encode-icon.mjs` owns this encoding and self-checks
every output; ImageMagick handles everything else.
