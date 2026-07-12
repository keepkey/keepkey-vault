#!/usr/bin/env bun
/**
 * clearsign icon encoder — any image → the KeepKey 1bpp/grayscale mono-RLE
 * bitmap format that firmware's draw_bitmap_mono_rle() decodes (device-protocol
 * LoadClearsignSigner.icon, <=384 bytes, <=64x64).
 *
 * ImageMagick does the resize/center/threshold; this tool owns only the RLE
 * encoding (the part that must match the firmware decoder byte-for-byte) and
 * self-verifies every encode by round-tripping through a decoder mirror.
 *
 * Format (see modules/keepkey-firmware/lib/board/draw.c):
 *   control byte read as int8:
 *     n > 0 : the next single value byte repeats n times   -> [n][value]
 *     n < 0 : the next (-n) bytes are literal pixel values -> [n][v1..v_-n]
 *   pixel = value * frame.color / 100; identity frames use color=100, so the
 *   value bytes are direct 0-255 intensities (0x00 off, 0xFF on for mono).
 *
 * Usage:
 *   bun encode-icon.mjs <image> [--size 48] [--gray] [--invert] [--json]
 *   bun encode-icon.mjs --self-test
 *
 * Prints { hex, width, height, bytes } (or a human summary without --json).
 */
import { execFileSync } from 'node:child_process'

const ICON_MAX_BYTES = 384
const MAX_DIM = 64

// ── RLE (must mirror draw_bitmap_mono_rle) ────────────────────────────────

/** Encode a row-major pixel array (0-255) to the mono-RLE byte stream. */
export function rleEncode(pixels) {
  const out = []
  const n = pixels.length
  let i = 0
  while (i < n) {
    // Longest run of identical pixels at i, capped at int8 max (127).
    let run = 1
    while (i + run < n && pixels[i + run] === pixels[i] && run < 127) run++
    if (run >= 2) {
      out.push(run, pixels[i] & 0xff)
      i += run
    } else {
      // Literal packet: pixels up to the next >=2 run, capped at 127. The
      // control byte carries -len as int8; -128 (from len 128) overflows the
      // firmware's int8 count and trips the draw.c assertion, so 127 is the max.
      const lit = []
      while (i < n && lit.length < 127) {
        if (i + 1 < n && pixels[i + 1] === pixels[i]) break // a run starts next
        lit.push(pixels[i] & 0xff)
        i++
      }
      out.push((256 - lit.length) & 0xff, ...lit) // -len as an unsigned byte
    }
  }
  return Uint8Array.from(out)
}

/** Decode — a faithful mirror of the firmware loop, used only to self-verify. */
export function rleDecode(data, w, h) {
  const pixels = new Array(w * h)
  let idx = 0 // pixel_index into data
  let sequence = 0
  let nonsequence = 0
  for (let p = 0; p < w * h; p++) {
    if (sequence === 0 && nonsequence === 0) {
      let ctrl = data[idx++]
      if (ctrl > 127) ctrl -= 256 // int8
      sequence = ctrl
      if (sequence < 0) {
        nonsequence = -sequence
        sequence = 0
      }
    }
    pixels[p] = data[idx] // value byte (color=100 => identity)
    if (sequence > 0) {
      sequence--
      if (sequence === 0) idx++
    } else {
      idx++
      nonsequence--
    }
  }
  return pixels
}

// ── Image → pixels (via ImageMagick) ──────────────────────────────────────

function rasterize(imagePath, size, { gray, invert }) {
  // Fit into size x size on a black canvas, centered; grayscale 8-bit raw out.
  const args = [
    imagePath[0] === '-' ? 'png:-' : imagePath, // (stdin unused today, keep simple)
    '-alpha', 'remove', '-alpha', 'off',
    '-resize', `${size}x${size}`,
    '-background', 'black', '-gravity', 'center', '-extent', `${size}x${size}`,
    '-colorspace', 'Gray', '-depth', '8',
  ]
  if (!gray) args.push('-threshold', '50%')
  if (invert) args.push('-negate')
  args.push('gray:-')
  const raw = execFileSync('magick', args, { maxBuffer: 1 << 24 })
  return Array.from(raw) // one byte per pixel, row-major
}

// ── Public: encode a file ─────────────────────────────────────────────────

export function encodeIconFile(imagePath, { size = 48, gray = false, invert = false } = {}) {
  if (size < 1 || size > MAX_DIM) throw new Error(`size must be 1..${MAX_DIM}`)
  const pixels = rasterize(imagePath, size, { gray, invert })
  const data = rleEncode(pixels)

  // Self-verify: the firmware decoder must reproduce the exact pixels.
  const back = rleDecode(data, size, size)
  for (let i = 0; i < pixels.length; i++) {
    if (back[i] !== pixels[i]) throw new Error(`RLE self-check failed at pixel ${i}`)
  }
  if (data.length > ICON_MAX_BYTES) {
    throw new Error(
      `encoded ${data.length}B > ${ICON_MAX_BYTES}B cap. Use --size 32, a simpler/mono logo, or drop --gray.`,
    )
  }
  return {
    hex: Buffer.from(data).toString('hex'),
    width: size,
    height: size,
    bytes: data.length,
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

function selfTest() {
  // A tiny hand-checked pattern: run of 3 zeros, 2 literals, run of 4 of 0xff.
  const px = [0, 0, 0, 0x10, 0x20, 255, 255, 255, 255]
  const enc = rleEncode(px)
  const dec = rleDecode(enc, 3, 3)
  const ok = px.every((v, i) => v === dec[i])
  if (!ok) { console.error('SELF-TEST FAILED', { px, enc: [...enc], dec }); process.exit(1) }
  // Expected stream: [3,0][-2,0x10,0x20][4,255]
  const expect = [3, 0, 254, 0x10, 0x20, 4, 255]
  const got = [...enc]
  if (JSON.stringify(got) !== JSON.stringify(expect)) {
    console.error('SELF-TEST byte mismatch', { expect, got }); process.exit(1)
  }
  // Boundary: a long literal stretch (alternating pixels → no run ≥2) must
  // split into ≤127-length packets and never emit control 0x80 (int8 -128),
  // which overflows the firmware's int8 negated count. Values are mono
  // (0x00/0xFF) so a value byte can't be mistaken for a 0x80 control byte.
  const alt = Array.from({ length: 300 }, (_, k) => (k % 2) * 0xff)
  const altEnc = rleEncode(alt)
  for (let k = 0; k < altEnc.length;) {
    let c = altEnc[k]; if (c > 127) c -= 256
    if (c === -128) { console.error('SELF-TEST: emitted 0x80/-128 literal control byte'); process.exit(1) }
    k += c >= 2 ? 2 : 1 + (-c) // run packet [n][v] : literal packet [n][v..]
  }
  if (!alt.every((v, k) => v === rleDecode(altEnc, 30, 10)[k])) {
    console.error('SELF-TEST: alternating round-trip failed'); process.exit(1)
  }
  console.log('self-test OK (round-trip + exact byte stream + 127-literal boundary)')
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) { selfTest(); process.exit(0) }
  const image = argv.find((a) => !a.startsWith('--'))
  if (!image) {
    console.error('usage: bun encode-icon.mjs <image> [--size 48] [--gray] [--invert] [--json]')
    process.exit(1)
  }
  const sizeArg = argv.indexOf('--size')
  const opts = {
    size: sizeArg >= 0 ? parseInt(argv[sizeArg + 1], 10) : 48,
    gray: argv.includes('--gray'),
    invert: argv.includes('--invert'),
  }
  const res = encodeIconFile(image, opts)
  if (argv.includes('--json')) console.log(JSON.stringify(res))
  else console.log(`${res.width}x${res.height}  ${res.bytes}B (cap ${ICON_MAX_BYTES})\n${res.hex}`)
}
