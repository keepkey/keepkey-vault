/** Payment-proof secrets stay in the backend and owner-only transaction storage. Never log them. */
import { ed25519 } from '@noble/curves/ed25519'
import type { MoneroPlan } from '../../monero-cli/src/protocol'
import { moneroDestinationAddressKeys } from '../shared/monero-address'
import { MoneroError } from './monero-wire'

export interface MoneroTransactionKeys { txKey: string; additionalTxKeys: string[] }
const L = (1n << 252n) + 27742317777372353535851937790883648493n
const scalar = (key: Uint8Array) => key.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n)
const canonical = (key: Uint8Array) => key.length === 32 && scalar(key) > 0n && scalar(key) < L
const hex = (key: Uint8Array) => Buffer.from(key).toString('hex')
export const TRANSACTION_KEY_ERROR = 'The Monero transaction key does not match the signed transaction. Nothing was sent.'

export function validTransactionKeys(value: unknown): value is MoneroTransactionKeys {
  const keys = value as MoneroTransactionKeys
  const valid = (key: unknown) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) && canonical(Uint8Array.from(Buffer.from(key, 'hex')))
  return !!keys && valid(keys.txKey) && Array.isArray(keys.additionalTxKeys) &&
    [0, 2].includes(keys.additionalTxKeys.length) && keys.additionalTxKeys.every(valid)
}

/** Firmware build_extra: sole subaddress uses r*D; mixed destinations use r*G and per-output keys. */
export function verifyMoneroTransactionKeys(plan: MoneroPlan, extra: Uint8Array, txKey: Uint8Array,
  additional: Uint8Array[], text: (source: string) => string = s => s): MoneroTransactionKeys {
  const bad = (): never => { throw new MoneroError(text(TRANSACTION_KEY_ERROR)) }
  try {
    if (!canonical(txKey) || additional.some(k => !canonical(k))) bad()
    const change = plan.outputs.find(o => o.isChange)?.address
    const recipients = [...new Map(plan.outputs.filter(o => o.address !== change).map(o => [o.address, o])).values()]
    const subs = recipients.filter(o => moneroDestinationAddressKeys(o.address)!.kind === 'subaddress')
    const needAdditional = subs.length > 0 && (recipients.length > subs.length || subs.length > 1)
    if (additional.length !== (needAdditional ? plan.outputs.length : 0)) bad()
    const point = (address?: string) => {
      if (!address) return ed25519.ExtendedPoint.BASE
      const p = ed25519.ExtendedPoint.fromHex(moneroDestinationAddressKeys(address)!.spend, false)
      if (p.isSmallOrder() || !p.isTorsionFree()) bad()
      return p
    }
    const matches = (offset: number, base: ReturnType<typeof point>, key: Uint8Array) =>
      hex(extra.subarray(offset, offset + 32)) === hex(base.multiply(scalar(key)).toRawBytes())
    if (extra[0] !== 1 || !matches(1, point(subs.length === 1 && recipients.length === 1 ? subs[0].address : undefined), txKey)) bad()
    let offset = 33
    if (needAdditional) {
      if (extra[offset++] !== 4 || extra[offset++] !== plan.outputs.length) bad()
      for (const [i, o] of plan.outputs.entries()) {
        const sub = moneroDestinationAddressKeys(o.address)!.kind === 'subaddress'
        if (!matches(offset, point(sub ? o.address : undefined), additional[i])) bad()
        offset += 32
      }
    }
    // Optional encrypted payment ID, including Core's dummy all-zero ID.
    if (extra.length !== offset && (extra.length !== offset + 11 || extra[offset] !== 2 || extra[offset + 1] !== 9 || extra[offset + 2] !== 1)) bad()
    return { txKey: hex(txKey), additionalTxKeys: additional.map(hex) }
  } catch { return bad() }
}
