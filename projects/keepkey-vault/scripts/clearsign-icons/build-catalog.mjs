#!/usr/bin/env bun
/**
 * Batch-encode every logo in sources/ into the device mono-RLE catalog that the
 * vault sends as clear-sign identity / protocol icons.
 *
 *   sources/<name>.{png,svg,jpg}  ->  generated/protocol-icons.json
 *     { "<name>": { hex, width, height, bytes } , ... }
 *
 * Drop a logo in sources/, run `bun build-catalog.mjs`, done. Each icon is
 * self-verified (encode round-trips through a firmware-decoder mirror) and
 * checked against the 384-byte device cap; oversized ones are reported, not
 * silently dropped.
 *
 * Naming convention for <name>: the lowercase protocol/dApp key or a signer
 * alias slug (e.g. `aave`, `uniswap`, `pioneer`). The vault maps a tx's
 * dappName / the loaded signer to this key.
 */
import { readdirSync, mkdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { encodeIconFile } from './encode-icon.mjs'

const HERE = new URL('.', import.meta.url).pathname
const SRC = join(HERE, 'sources')
const OUT = join(HERE, 'generated', 'protocol-icons.json')
const SIZE = Number(process.env.ICON_SIZE || 48)
const GRAY = process.env.ICON_GRAY === '1'

mkdirSync(join(HERE, 'generated'), { recursive: true })

const files = readdirSync(SRC).filter((f) => ['.png', '.svg', '.jpg', '.jpeg'].includes(extname(f).toLowerCase()))
const catalog = {}
const failures = []

for (const f of files.sort()) {
  const key = basename(f, extname(f)).toLowerCase()
  try {
    const { hex, width, height, bytes } = encodeIconFile(join(SRC, f), { size: SIZE, gray: GRAY })
    catalog[key] = { hex, width, height, bytes }
    console.log(`  ✓ ${key.padEnd(20)} ${String(bytes).padStart(3)}B ${width}x${height}`)
  } catch (e) {
    failures.push({ key, err: e.message })
    console.log(`  ✗ ${key.padEnd(20)} ${e.message}`)
  }
}

await Bun.write(OUT, JSON.stringify(catalog, null, 2) + '\n')
console.log(`\nwrote ${Object.keys(catalog).length} icon(s) -> ${OUT}`)
if (failures.length) {
  console.log(`${failures.length} failed (too large / unreadable) — simplify the logo, try --size 32, or a cleaner mono source.`)
  process.exit(1)
}
