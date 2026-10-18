/**
 * Keep, per signed EVM transaction, what the approval card showed, so the
 * history dialog can show it again. Without a record, decode the on-chain call
 * data now and say so.
 */
import { utils } from 'ethers'
import { assessSigningRisk } from '../shared/clearsign-risk'
import type { CalldataDecodedInfo, SigningRequestInfo } from '../shared/types'
import type { SignedTxReview, TxClearSign } from '../shared/tx-clearsign'
import { decodeCalldata } from './calldata-decoder'
import { saveSignedTxReview } from './db'

/** The broadcast txid: keccak256 of the signed RLP (legacy) or typed envelope. */
export const evmTxid = (serialized: string) => utils.keccak256(serialized).toLowerCase()

const callSummary = (d?: CalldataDecodedInfo | null) =>
  d && d.source !== 'none' ? [d.dappName !== 'Unknown' && d.dappName, d.method].filter(Boolean).join(': ') || undefined : undefined

/** The card's verdict, recomputed from the very object the card was built from. */
export function signedTxReview(info: SigningRequestInfo, signedMsg: any): SignedTxReview {
  const risk = assessSigningRisk(info)
  // From the card's verdict, not from what was sent: a caller's 0x80 blob this
  // firmware cannot show still signs blind. Unmarked calls with data are blind.
  const blind = info.needsBlindSigning ?? (!info.deviceClearSigns && !!info.data && info.data !== '0x')
  return {
    signedHow: signedMsg?.erc7730 ? 'erc7730'
      : blind ? (signedMsg?.txMetadata ? 'provider' : 'blind')
        : info.deviceClearSigns ? 'native'
          : signedMsg?.txMetadata?.keyId === 0x80 ? 'certified'
            : 'native',
    tier: risk?.tier, headline: risk?.headline, reasons: risk?.reasons ?? [],
    call: callSummary(info.calldataDecoded), provider: info.runtimeProvider?.alias, appName: info.appName,
    signedAt: Date.now(),
  }
}

/** Never throws: a missing record must not fail a signature. */
export function recordSignedEvmTx(
  scope: { deviceId: string; walletId: string }, chainId: number, serialized: string, info: SigningRequestInfo, signedMsg: any,
) {
  try { saveSignedTxReview(`eip155:${chainId}`, evmTxid(serialized), scope.deviceId, scope.walletId, signedTxReview(info, signedMsg)) }
  catch (e: any) { console.warn('[signed-tx-review] not recorded:', e?.message) }
}

// Sentences about what the device could show. Run now, they would describe
// today's firmware, not the signing.
const DEVICE_CLAIM = /your KeepKey|KeepKey firmware|Advanced Mode|signing blind/i

/** The on-chain transaction, as a node returns it. undefined = not available. */
export interface EvmTxFacts { to?: string | null; from?: string; value?: string; data?: string }

/** `received`: someone else's call. Show what it is, not risk lines about "your" funds. */
export async function txClearSign(record: SignedTxReview | null, tx: EvmTxFacts | null | undefined, chainId: number, received = false): Promise<TxClearSign> {
  if (record) return { kind: 'record', ...record }
  if (!tx || typeof tx.data !== 'string' || !tx.to) return { kind: 'none' }
  if (tx.data === '0x' || tx.data === '') return { kind: 'plain' }
  const info: SigningRequestInfo = {
    id: 'decode-now', method: '/eth/sign-transaction', appName: '', chainId,
    to: tx.to, from: tx.from, value: tx.value, data: tx.data,
    calldataDecoded: (await decodeCalldata(tx.to, tx.data, chainId, tx.value)) ?? undefined,
  }
  const reasons = received ? [] : (assessSigningRisk(info)?.reasons ?? []).filter((r) => !DEVICE_CLAIM.test(r.text))
  return { kind: 'decoded', call: callSummary(info.calldataDecoded), reasons }
}

/** The transaction's call data through Pioneer's LookupTx (already used for receipts). */
export async function lookupEvmTx(pioneer: any, networkId: string, txid: string): Promise<EvmTxFacts | undefined> {
  const tx = (await pioneer.LookupTx({ networkId, txid }))?.data?.data?.tx
  if (!tx || typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== txid.toLowerCase()) return undefined
  const data = tx.data ?? tx.input
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return undefined
  const value = tx.value?.hex ?? tx.value
  return { to: tx.to, from: tx.from, value: value == null ? undefined : String(value), data }
}
