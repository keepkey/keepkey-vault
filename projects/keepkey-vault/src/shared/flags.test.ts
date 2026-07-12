/**
 * Bitcoin-only firmware detection + the "show only Bitcoin" chain restriction.
 * Run: bun src/shared/flags.test.ts
 */
import { isBitcoinOnlyVariant } from './flags'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log(`  ✅ ${label}`); pass++ }
  else { console.error(`  ❌ ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++ }
}

// Detection contract — matches firmware fsm_msg_common.h firmware_variant strings.
eq('KeepKeyBTC → btc-only', isBitcoinOnlyVariant('KeepKeyBTC'), true)
eq('EmulatorBTC → btc-only', isBitcoinOnlyVariant('EmulatorBTC'), true)
eq('bitcoin-only-locked → NOT btc-only fw (multi-chain refusing seed)', isBitcoinOnlyVariant('bitcoin-only-locked'), false)
eq('KeepKey (multi-chain) → not btc-only', isBitcoinOnlyVariant('KeepKey'), false)
eq('undefined → not btc-only', isBitcoinOnlyVariant(undefined), false)

// The Dashboard visibleChains predicate (Dashboard.tsx): btc-only ⇒ only bitcoin.
const fixture = [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'cosmos' }]
const restrict = (variant?: string) =>
  fixture.filter(c => (isBitcoinOnlyVariant(variant) ? c.id === 'bitcoin' : true)).map(c => c.id)
eq('btc-only shows exactly [bitcoin]', restrict('KeepKeyBTC'), ['bitcoin'])
eq('multi-chain shows all chains', restrict('KeepKey'), ['bitcoin', 'ethereum', 'cosmos'])

console.log(`\n  Result: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
