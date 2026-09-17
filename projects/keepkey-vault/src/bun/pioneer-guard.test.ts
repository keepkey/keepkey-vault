/**
 * Unit test for the Pioneer honesty guard — blocks BTC→Pioneer money calls when a
 * self-host node is on, passes everything else through. No network.
 * Run: bun src/bun/pioneer-guard.test.ts
 */
import { installPioneerGuard, setPioneerGuardActive } from './pioneer-guard'

const BTC = 'bip122:000000000019d6689c085ae165831e93'
const BTC_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'
const LTC = 'bip122:12a765e31ffd4059bada1e25190f6e98'
let pass = 0
function ok(c: boolean, msg: string) { if (!c) throw new Error(`FAIL ${msg}`); pass++ }
function threw(fn: () => any): boolean { try { fn(); return false } catch { return true } }

// A fake client whose methods just echo — the guard patches them in place.
const client: any = {
  ListUnspent: (a: any) => ({ called: 'ListUnspent', a }),
  GetFeeRateByNetwork: (a: any) => ({ called: 'fee', a }),
  Broadcast: (a: any) => ({ called: 'Broadcast', a }),
  GetMarketInfo: (a: any) => ({ called: 'price', a }),
  GetPubkeyInfo: (a: any) => ({ called: 'pubkey', a }),
  GetTransactionHistory: (a: any) => ({ called: 'history', a }),
  GetPortfolioBalances: (a: any) => ({ called: 'portfolio', a }),
  GetBalanceAddressByNetwork: (a: any) => ({ called: 'balance-address', a }),
  LookupUtxoTx: (a: any) => ({ called: 'lookup-current', a }),
  UtxoLookup: (a: any) => ({ called: 'lookup', a }),
}
installPioneerGuard(client)

// Pioneer mode (guard inactive): everything passes.
setPioneerGuardActive(false)
ok(client.ListUnspent({ network: BTC }).called === 'ListUnspent', 'inactive: BTC ListUnspent passes')
ok(client.Broadcast({ networkId: BTC }).called === 'Broadcast', 'inactive: BTC Broadcast passes')

// Self-host on: every BTC chain-data call throws; other coins + price pass.
setPioneerGuardActive(true)
ok(threw(() => client.ListUnspent({ network: BTC })), 'active: BTC ListUnspent blocked')
ok(threw(() => client.ListUnspent({ network: BTC_TESTNET })), 'active: BTC testnet ListUnspent blocked')
ok(threw(() => client.GetFeeRateByNetwork({ networkId: BTC })), 'active: BTC fee blocked')
ok(threw(() => client.Broadcast({ networkId: BTC })), 'active: BTC Broadcast blocked')
ok(client.ListUnspent({ network: LTC }).called === 'ListUnspent', 'active: LTC ListUnspent passes')
ok(client.GetMarketInfo([BTC]).called === 'price', 'active: price (GetMarketInfo) passes')
ok(threw(() => client.GetPubkeyInfo({ network: BTC })), 'active: BTC GetPubkeyInfo blocked')
ok(threw(() => client.GetTransactionHistory({ network: BTC })), 'active: BTC history blocked')
ok(threw(() => client.GetTransactionHistory({ queries: [{ caip: `${BTC}/slip44:0`, pubkey: 'xpub' }] })), 'active: nested BTC history blocked')
ok(threw(() => client.GetTransactionHistory({ queries: [{ caip: `${BTC_TESTNET}/slip44:1`, pubkey: 'tpub' }] })), 'active: nested BTC testnet history blocked')
ok(threw(() => client.GetPortfolioBalances({ pubkeys: [{ caip: `${BTC}/slip44:0`, pubkey: 'xpub' }] })), 'active: BTC portfolio blocked')
ok(threw(() => client.GetBalanceAddressByNetwork({ networkId: BTC, address: 'bc1q' })), 'active: BTC address balance blocked')
ok(threw(() => client.LookupUtxoTx({ networkId: BTC, txid: '00' })), 'active: BTC current raw lookup blocked')
ok(threw(() => client.UtxoLookup({ networkId: BTC, txid: '00' })), 'active: BTC raw lookup blocked')
ok(client.GetPubkeyInfo({ network: LTC }).called === 'pubkey', 'active: LTC GetPubkeyInfo passes')

// Idempotent install must not double-wrap.
installPioneerGuard(client)
ok(threw(() => client.Broadcast({ networkId: BTC })), 're-install: still blocks once, no double-wrap')

setPioneerGuardActive(false)
console.log(`[pioneer-guard] OK — ${pass} assertions passed`)
