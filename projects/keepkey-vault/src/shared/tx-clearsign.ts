/** What the history dialog keeps and says about one EVM transaction. */
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
  /** The decoded or described method, e.g. "approve", "claimAndStake". */
  call?: string
  /** The name the called contract reports for itself, e.g. "Staked Venice Token". */
  contract?: string
  provider?: string
  appName?: string
  signedAt: number
}

/** One row of the dialog's Details section. */
export interface TxDetailLine { label: string; value: string }
