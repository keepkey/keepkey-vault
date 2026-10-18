/** ClearSign facts for one transaction in the history dialog. */
import type { RiskReason, SigningTier } from './clearsign-risk'

/** What the KeepKey was given to show: its own decode, a description it
 *  checked, or nothing (blind). */
export type SignedHow = 'native' | 'certified' | 'erc7730' | 'provider' | 'blind'

/** What the approval card showed when this transaction was signed. */
export interface SignedTxReview {
  signedHow: SignedHow
  tier?: SigningTier
  headline?: string
  reasons: RiskReason[]
  call?: string
  provider?: string
  appName?: string
  signedAt: number
}

export type TxClearSign =
  | ({ kind: 'record' } & SignedTxReview)
  /** No record: Desktop's decode of the on-chain call data, run now. */
  | { kind: 'decoded'; call?: string; reasons: RiskReason[] }
  | { kind: 'plain' }
  | { kind: 'none' }

/** A call KeepKey Desktop decoded (`call`) is known: "not on this firmware
 *  yet", not "blind" (owner rule, as on the approval card). */
export function signedHowText(r: Pick<SignedTxReview, 'signedHow' | 'provider' | 'call'>): string {
  const raw = r.call ? 'raw data, this firmware cannot show it yet (Advanced Mode)' : 'blind (Advanced Mode)'
  switch (r.signedHow) {
    case 'native': return 'clear-signed'
    case 'certified': return 'clear-signed, from a KeepKey-certified description'
    case 'erc7730': return 'clear-signed, from a KeepKey ClearSign description'
    case 'provider': return `${raw}. Described by ${r.provider ? `'${r.provider}'` : 'a ClearSign provider'}, not checked by KeepKey`
    case 'blind': return raw
  }
}
