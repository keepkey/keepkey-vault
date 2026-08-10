/**
 * Unit test for the Pioneer honesty guard — blocks BTC→Pioneer money calls when a
 * self-host node is on, passes everything else through. No network.
 * Run: bun src/bun/pioneer-guard.test.ts
 */
import { installPioneerGuard, setPioneerGuardActive } from './pioneer-guard'

const BTC = 'bip122:000000000019d6689c085ae165831e93'
const LTC = 'bip122:12a765e31ffd4059bada1e25190f6e98'
let pass = 0
function ok(c: boolean, msg: string) { if (!c) throw new Error(`FAIL ${msg}`); pass++ }
function threw(fn: () => any): boolean { try { fn(); return false } catch { return true } }

// A fake client whose methods just echo — the guard patches them in place.
const client: any = {
  ListUnspent: (a: any) => ({ called: 'ListUnspent', a }),
  GetFeeRateByNetwork: (a: any) => ({ called: 'fee', a }),
  Broadcast: (a: any) => ({ called: 'Broadcast', a }),
  GetMarketInfo: (a: any) => ({ called: 'price', a }),   // NOT guarded — price exception
  GetPubkeyInfo: (a: any) => ({ called: 'pubkey', a }),  // NOT guarded — address discovery
}
installPioneerGuard(client)

// Pioneer mode (guard inactive): everything passes.
setPioneerGuardActive(false)
ok(client.ListUnspent({ network: BTC }).called === 'ListUnspent', 'inactive: BTC ListUnspent passes')
ok(client.Broadcast({ networkId: BTC }).called === 'Broadcast', 'inactive: BTC Broadcast passes')

// Self-host on: BTC money calls throw, other coins + price/pubkey pass.
setPioneerGuardActive(true)
ok(threw(() => client.ListUnspent({ network: BTC })), 'active: BTC ListUnspent blocked')
ok(threw(() => client.GetFeeRateByNetwork({ networkId: BTC })), 'active: BTC fee blocked')
ok(threw(() => client.Broadcast({ networkId: BTC })), 'active: BTC Broadcast blocked')
ok(client.ListUnspent({ network: LTC }).called === 'ListUnspent', 'active: LTC ListUnspent passes')
ok(client.GetMarketInfo([BTC]).called === 'price', 'active: price (GetMarketInfo) passes')
ok(client.GetPubkeyInfo({ network: BTC }).called === 'pubkey', 'active: BTC GetPubkeyInfo passes (not guarded)')

// Idempotent install must not double-wrap.
installPioneerGuard(client)
ok(threw(() => client.Broadcast({ networkId: BTC })), 're-install: still blocks once, no double-wrap')

setPioneerGuardActive(false)
console.log(`[pioneer-guard] OK — ${pass} assertions passed`)
