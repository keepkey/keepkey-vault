# 07 — Clear-sign icon encoder + catalog tooling

**What:** turn any protocol/identity logo into the KeepKey 1bpp mono-RLE bitmap
the OLED renders (`draw_bitmap_mono_rle`), ≤384 B, ≤64×64. The encoder owns only
the RLE codec (must match the firmware decoder byte-for-byte) and self-verifies
every output by round-tripping through a decoder mirror; ImageMagick does the
resize/center/threshold.

**Where:** vault `#342` (OPEN) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/scripts/clearsign-icons/`
(`encode-icon.mjs`, `build-catalog.mjs`, `README.md`, `sources/`, `generated/`).

## Test
- Codec self-test: `cd .../scripts/clearsign-icons && bun encode-icon.mjs --self-test`.
- One image: `bun encode-icon.mjs sources/pioneer.png --json`.
- Batch: `bun build-catalog.mjs` (encodes `sources/*` → `generated/protocol-icons.json`).
- ASCII-preview to eyeball a shape: see the `rleDecode` one-liner in the README.

## Verify
- [ ] `--self-test` prints the exact expected byte stream + round-trip OK.
- [ ] Pioneer compass encodes ≤384 B at 40×40 and previews as a clean compass.
- [ ] End-to-end: the generated `identity-icons.json` icon renders correctly on
      the device (covered by handoff 01) — proves the encoder matches firmware.
- [ ] An oversized/detailed logo fails with a clear ">384B" message (not silent).

## Status / gotchas
- Confirm-column width is 40px → generate confirm icons at **40px** (not the
  handoff's aspirational 48). Boot-review (bigger) can use larger later.
- To add a real protocol logo: drop `sources/<key>.png`, run `build-catalog.mjs`.
- Per-tx **protocol** glyphs (Aave/Uniswap beside the method) are a separate
  transient path — tooling produces them, wiring is a follow-up.
</content>
