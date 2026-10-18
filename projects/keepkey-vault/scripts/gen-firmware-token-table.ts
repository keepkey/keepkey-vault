/**
 * Regenerate a src/bun/firmware-token-table*.json from a firmware build's
 * generated token .def files (python-keepkey keepkeylib/eth/ethereum_tokens.py
 * + uniswap_tokens.py write them into the build's include dir).
 *
 *   bun scripts/gen-firmware-token-table.ts <dir> [out.json]
 *
 * <dir> is a build's include/keepkey/firmware, or any directory holding the
 * two .def files generated as that firmware's lib/firmware/CMakeLists.txt does
 * (E = <firmware>/deps/python-keepkey/keepkeylib/eth):
 *
 *   7.15.x: firmware-token-table.json (418). Both lists use the default
 *   `fill` profile:
 *     python3 $E/ethereum_tokens.py <dir>/ethereum_tokens.def
 *     python3 $E/uniswap_tokens.py  <dir>/uniswap_tokens.def
 *     bun scripts/gen-firmware-token-table.ts <dir>
 *
 *   7.16.0: firmware-token-table-716.json (153, all chain 1). Only
 *   ethereum_tokens.py gets `--profile priority-only` (D-014); uniswap stays
 *   on the default:
 *     python3 $E/ethereum_tokens.py <dir>/ethereum_tokens.def --profile priority-only
 *     python3 $E/uniswap_tokens.py  <dir>/uniswap_tokens.def
 *     bun scripts/gen-firmware-token-table.ts <dir> firmware-token-table-716.json
 *
 * The firmware natively renders an ERC-20 transfer/approve only for a
 * (chain_id, address) in this table (tokenByChainAddress); every other token
 * is gated on AdvancedMode. Vault's prediction (firmwareClearSigns) must use
 * the same list. Update __tests__/firmware-clearsign-gate.test.ts's pinned
 * sizes when a firmware table changes.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const dir = process.argv[2]
const outName = process.argv[3] ?? 'firmware-token-table.json'
if (!dir) throw new Error('usage: bun scripts/gen-firmware-token-table.ts <firmware include/keepkey/firmware dir> [out.json]')

const X = /^X\((\d+),\s*"((?:\\x[0-9a-fA-F]{2}){20})",\s*" ?([^"]*)",\s*(\d+)\)/
// The firmware's table order (uniswap first): tokenByChainAddress takes the first match.
const symbols: Record<string, [string, number]> = {}
for (const file of ['uniswap_tokens.def', 'ethereum_tokens.def']) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    const m = X.exec(line)
    if (!m) continue
    symbols[`${m[1]}:0x${m[2].replace(/\\x/g, '').toLowerCase()}`] ??= [m[3], Number(m[4])]
  }
}
const tokens = Object.keys(symbols)
const out = {
  _source: 'firmware tokenByChainAddress table (uniswap_tokens.def + ethereum_tokens.def)',
  _regenerate: `bun scripts/gen-firmware-token-table.ts <fw build>/include/keepkey/firmware${process.argv[3] ? ` ${outName}` : ''}`,
  tokens: [...tokens].sort(),
  /** What the device names each token: ticker and decimals. */
  symbols,
}
writeFileSync(join(import.meta.dir, '../src/bun', outName), JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${out.tokens.length} (chain:address) entries to src/bun/${outName}`)
