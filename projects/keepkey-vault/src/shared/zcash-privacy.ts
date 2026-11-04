export type ZcashPrivacyPage = 'send' | 'shield' | 'receive' | 'scan' | 'history'

export interface ZcashShieldedBalance {
  confirmed: number
  pending: number
  in_flight?: number
  synced_to?: number | null
  notes_unspent?: number
  spendable_confirmed?: number
  spendable_notes_count?: number
  min_confirmations?: number
  max_send?: number
  max_deshield?: number
}

/** Pending notes are a subset of confirmed; in-flight value is not scanned yet. */
export function zcashShieldedAmounts(balance: ZcashShieldedBalance | null) {
  if (!balance) return null
  const { confirmed, pending, in_flight = 0 } = balance
  if (![confirmed, pending, in_flight].every(n => Number.isSafeInteger(n) && n >= 0) || pending > confirmed) return null
  if (balance.spendable_confirmed != null && (!Number.isSafeInteger(balance.spendable_confirmed) || balance.spendable_confirmed < 0 || balance.spendable_confirmed > confirmed)) return null
  return {
    available: balance.spendable_confirmed ?? confirmed - pending,
    pending: pending + in_flight,
    total: confirmed + in_flight,
  }
}

export function zcashScanStatus(state: { height: number | null; balanceKnown: boolean; scanRequired: boolean; scanning: boolean; error?: string | null }) {
  if (state.scanning) return 'scanning'
  if (state.error) return 'failed'
  if (state.height == null) return 'not-scanned'
  if (state.scanRequired || !state.balanceKnown) return 'needs-scan'
  return 'last-scanned'
}

export type ZcashSendRoute = 'shielded' | 'unshield' | 'tex'
/** The sidecar's shielded-only builder cannot pay a transparent recipient. */
export function zcashPrivateSendRoute(recipient: string, memo?: string): ZcashSendRoute {
  const address = recipient.trim()
  const route = address.startsWith('tex1') ? 'tex'
    : address.startsWith('t1') || address.startsWith('t3') ? 'unshield'
    : address.startsWith('u1') ? 'shielded' : null
  if (!route) throw new Error('Use a shielded unified address (u1…), transparent address (t1…/t3…), or TEX address (tex1…).')
  if (route !== 'shielded' && memo?.trim()) throw new Error('Transparent recipients cannot receive an encrypted memo. Remove the memo before sending.')
  return route
}

export function sendZcashByRoute<T>(recipient: string, memo: string | undefined, handlers: Record<ZcashSendRoute, () => Promise<T>>): Promise<T> {
  return handlers[zcashPrivateSendRoute(recipient, memo)]()
}
