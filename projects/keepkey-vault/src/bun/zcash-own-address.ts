/** The connected wallet's Zcash unified address (u1…) as an own Address Book row (KEEPKEY-180).
 *
 * The sidecar holds one viewing key per process: the last one loaded, which may belong to another wallet
 * (another seed, or a passphrase wallet used earlier). So the cached unified address is only taken when its
 * key is the one remembered for this wallet's identity. Nothing here asks the device or derives an address:
 * it reuses the unified address the device already gave the sidecar. */
import type { OwnAddressSeed } from './db'

/** Seeded English default; addressbook-label.ts translates it while untouched. */
export const OWN_UNIFIED_LABEL = 'My ZEC unified address'

type Part = string | Uint8Array
type CachedFvk = { address: string; fvk: { ak: Part; nk: Part; rivk: Part } } | null
type Fvk = { ak?: Part; nk?: Part; rivk?: Part } | null

const hex = (v: Part) => typeof v === 'string' ? v.toLowerCase() : Buffer.from(v).toString('hex')
/** The unified address comes from the whole viewing key, so all three parts must be the same key's. */
const sameKey = (a: Fvk, b: Fvk) => (['ak', 'nk', 'rivk'] as const).every(part => !!a?.[part] && !!b?.[part] && hex(a[part]!) === hex(b[part]!))

export function ownZcashUnifiedAddress(args: { cached: CachedFvk; remembered: Fvk; networkId: string | undefined }): OwnAddressSeed | null {
  const { cached, remembered, networkId } = args
  if (!cached || !remembered || !networkId) return null
  if (!/^u1[02-9ac-hj-np-z]+$/.test(cached.address)) return null // a mainnet unified address (bech32m)
  if (!sameKey(remembered, cached.fvk)) return null // another wallet's key
  return {
    address: cached.address, networkId, chainId: 'zcash-shielded', chainFamily: 'zcash-shielded',
    symbol: 'ZEC', label: OWN_UNIFIED_LABEL, derivationPath: "m/32'/133'/0'", addressIndex: 0,
  }
}
