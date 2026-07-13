/**
 * Honesty guard for the self-host epic. When a self-host BTC node (or offline mode)
 * is active, Bitcoin blockchain data MUST come from the node via the BtcBackend seam
 * — NEVER Pioneer. This patches the Pioneer client so any forbidden BTC call throws
 * loudly instead of silently "cheating" back to Pioneer.
 *
 * Scope: only Bitcoin (matched by networkId in the call args). Other UTXO coins
 * (LTC/DOGE/BCH/Dash/Zcash) and price/history (GetMarketInfo/GetTransactionHistory —
 * the documented Task-2/3 exceptions) pass through untouched.
 *
 * Leaf module (no imports) so both pioneer.ts and btc-backend/index.ts can use it
 * without an import cycle.
 */
const BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'

// Pioneer methods FULLY replaced by the BtcBackend seam — forbidden for BTC when a
// node is on. Deliberately excludes GetPubkeyInfo: the send path already skips it
// (change index is derived from UTXOs), but receive-address discovery + reports still
// use it for BTC and have no node equivalent yet (Task 3), so blocking it globally
// would break those. The money path (UTXOs/fees/broadcast) is what must never cheat.
const GUARDED = ['ListUnspent', 'GetFeeRateByNetwork', 'GetFeeRate', 'Broadcast']

let active = false
/** Set from btc-backend when the node/offline state changes. */
export function setPioneerGuardActive(v: boolean): void {
  if (v !== active) console.log(`[pioneer-guard] BTC→Pioneer calls ${v ? 'BLOCKED (self-host on)' : 'allowed (Pioneer mode)'}`)
  active = v
}

function isBtcArg(arg: any): boolean {
  return (arg?.network ?? arg?.networkId) === BTC_NETWORK_ID
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
