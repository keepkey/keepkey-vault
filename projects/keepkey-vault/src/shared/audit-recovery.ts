import type { AuditChainFinding, AuditDerivedAddress } from './types'

/** Address-level scans do not carry `level`: it describes a whole-account
 * scan. Resolve supported Litecoin address paths separately so a receive
 * index is never mistaken for an account number or an unsupported scheme. */
export function auditTrackLevel(
  chain: Pick<AuditChainFinding, 'chainId' | 'family'>,
  found: Pick<AuditDerivedAddress, 'level' | 'addressNList' | 'scriptType'>,
  isHidden: boolean,
): number | null {
  const canTrack = chain.chainId === 'bitcoin' || chain.family === 'evm'
    || (chain.family === 'utxo' && !isHidden)
  if (!canTrack) return null
  if (found.level != null) return found.level
  if (chain.chainId !== 'litecoin' || chain.family !== 'utxo' || isHidden) return null

  const path = found.addressNList
  const H = 0x80000000
  if (!path || path.length !== 5 || path.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff)) return null
  const [purpose, coin, account, change, index] = path
  if (coin !== H + 2 || account < H || (change !== 0 && change !== 1) || index >= H) return null
  const supported = (purpose === H + 44 && (found.scriptType === 'p2pkh' || found.scriptType === 'p2wpkh'))
    || (purpose === H + 49 && found.scriptType === 'p2sh-p2wpkh')
    || (purpose === H + 84 && found.scriptType === 'p2wpkh')
  return supported ? account - H : null
}
