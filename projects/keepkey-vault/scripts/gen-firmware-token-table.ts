/**
 * Regenerate src/bun/firmware-token-table.json from a firmware build's
 * generated token .def files (python-keepkey keepkeylib/eth/ethereum_tokens.py
 * + uniswap_tokens.py write them into the build's include dir).
 *
 *   bun scripts/gen-firmware-token-table.ts \
 *     ~/keepkey-toolchain/build-fw716-fixtk/include/keepkey/firmware
 *
 * The firmware natively renders an ERC-20 transfer/approve only for a
 * (chain_id, address) in this table (tokenByChainAddress); every other token
 * is gated on AdvancedMode. Vault's prediction (firmwareClearSigns) must use
 * the same list. Update __tests__/firmware-clearsign-gate.test.ts's pinned
 * size when the firmware table changes.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: bun scripts/gen-firmware-token-table.ts <firmware include/keepkey/firmware dir>')

const X = /^X\((\d+),\s*"((?:\\x[0-9a-fA-F]{2}){20})",/
const tokens = new Set<string>()
for (const file of ['uniswap_tokens.def', 'ethereum_tokens.def']) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    const m = X.exec(line)
    if (!m) continue
    tokens.add(`${m[1]}:0x${m[2].replace(/\\x/g, '').toLowerCase()}`)
  }
}
const out = {
  _source: 'firmware tokenByChainAddress table (uniswap_tokens.def + ethereum_tokens.def)',
  _regenerate: 'bun scripts/gen-firmware-token-table.ts <fw build>/include/keepkey/firmware',
  tokens: [...tokens].sort(),
}
writeFileSync(join(import.meta.dir, '../src/bun/firmware-token-table.json'), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${out.tokens.length} (chain:address) entries`)
