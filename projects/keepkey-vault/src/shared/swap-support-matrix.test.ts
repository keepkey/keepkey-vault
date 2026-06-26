/**
 * Routability of THORChain bank tokens (TCY, RUJI) in the swap support matrix.
 * Run: bun src/shared/swap-support-matrix.test.ts
 */
import { assessAvailability } from './swap-support-matrix'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log(`  ✅ ${label}`); pass++ }
  else { console.error(`  ❌ ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++ }
}

const tcy = assessAvailability('cosmos:thorchain-mainnet-v1/denom:tcy')
eq('TCY swappable via thorchain', [tcy.status, tcy.providers], ['swappable', ['thorchain']])

const ruji = assessAvailability('cosmos:thorchain-mainnet-v1/denom:x/ruji')
eq('RUJI swappable via thorchain', [ruji.status, ruji.providers], ['swappable', ['thorchain']])

const rune = assessAvailability('cosmos:thorchain-mainnet-v1/slip44:931')
eq('RUNE native still swappable', rune.status, 'swappable')

// Only the two pooled bank tokens are allowlisted — a random thorchain denom
// (pool/vault token, no THOR pool) must NOT be claimed swappable.
const rand = assessAvailability('cosmos:thorchain-mainnet-v1/denom:x/bow-xyk-x/ruji-rune')
eq('random non-pooled denom NOT auto-swappable', rand.status, 'unsupported_token')

console.log(`\n  Result: ${pass} passed, ${fail} failed\n`)
process.exit(fail > 0 ? 1 : 0)
