/**
 * Honesty guard for the self-host epic. When a self-host BTC node (or offline mode)
 * is active, Bitcoin blockchain data MUST come from the node via the BtcBackend seam
 * — NEVER Pioneer. This patches the Pioneer client so any forbidden BTC call throws
 * loudly instead of silently "cheating" back to Pioneer.
 *
 * Scope: only Bitcoin (matched by networkId in the call args). Other UTXO coins
 * (LTC/DOGE/BCH/Dash/Zcash) and price data pass through untouched.
 *
 * Leaf module (no imports) so both pioneer.ts and btc-backend/index.ts can use it
 * without an import cycle.
 */
const BTC_NETWORK_IDS = new Set([
  'bip122:000000000019d6689c085ae165831e93',
  'bip122:000000000933ea01ad0ee984209779ba',
])

// Pioneer methods FULLY replaced by the BtcBackend seam — forbidden for BTC when a
// node is on. Address discovery and history are included: Bitcoin Core cannot
// answer them from scantxoutset, and silently consulting Pioneer would make the
// self-host/offline privacy claim false. Blockbook supplies its own xpub-native
// discovery through BtcBackend instead.
const GUARDED = [
  'ListUnspent', 'GetFeeRateByNetwork', 'GetFeeRate', 'Broadcast',
  'GetPubkeyInfo', 'GetTransactionHistory', 'GetPortfolioBalances',
  'GetBalanceAddressByNetwork', 'LookupUtxoTx', 'UtxoLookup',
]

let active = false
/** Set from btc-backend when the node/offline state changes. */
export function setPioneerGuardActive(v: boolean): void {
  if (v !== active) console.log(`[pioneer-guard] BTC→Pioneer calls ${v ? 'BLOCKED (self-host on)' : 'allowed (Pioneer mode)'}`)
  active = v
}

function isBtcArg(arg: any): boolean {
  const network = arg?.network ?? arg?.networkId ?? arg?.caip
  if (typeof network === 'string' && [...BTC_NETWORK_IDS].some(id => network === id || network.startsWith(`${id}/`))) return true
  for (const list of [arg?.queries, arg?.pubkeys]) {
    if (Array.isArray(list) && list.some((entry: any) => isBtcArg(entry))) return true
  }
  return false
}

/** Patch the client's guarded methods in place (idempotent — safe to call repeatedly). */
export function installPioneerGuard(client: any): void {
  if (!client || client.__btcGuarded) return
  for (const name of GUARDED) {
    const orig = client[name]
    if (typeof orig !== 'function') continue
    client[name] = function (arg: any, ...rest: any[]) {
      if (active && isBtcArg(arg)) {
        throw new Error(
          `[pioneer-guard] Blocked pioneer.${name} for BTC — a self-host node is enabled, so this must go ` +
          `through the node (BtcBackend seam), not Pioneer. This is the zero-Pioneer honesty guard, not a bug.`,
        )
      }
      return orig.call(this, arg, ...rest)
    }
  }
  client.__btcGuarded = true
  console.log('[pioneer-guard] installed on Pioneer client')
}
