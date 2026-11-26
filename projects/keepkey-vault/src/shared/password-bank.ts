export const PASSWORD_BANK_ALGORITHM = 'keepkey-ckv-base64url-v1' as const
/** The unlock session lasts this long and is never extended; a cached password
 *  ends with it, so it is also the longest cache duration the bank accepts. */
export const PASSWORD_CACHE_MAX_MINUTES = 15
export interface PasswordProfile {
  id: string
  origin: string
  account: string
  slot: number
  /** Stored for older Vault versions; always settled to 'active' on unlock. */
  pendingSlot?: number
  rotationState: 'active' | 'prepared' | 'submitted'
  changedAt?: number
  reviewDays: number
  createdAt: number
}
export interface PasswordBankView {
  enabled: boolean
  exists: boolean
  walletPending?: boolean
  unlocked: boolean
  bankId?: string
  algorithm: typeof PASSWORD_BANK_ALGORITHM
  profiles: (PasswordProfile & { cachedUntil?: number; due: boolean })[]
  readySlots: { slot: number; symbolFormat: boolean; cachedUntil?: number }[]
  revision: number
}
export interface PasswordBankBackup {
  format: 'keepkey-password-bank'
  version: 1 | 2
  bankId: string
  iv: string
  ciphertext: string
  tag: string
}
export function passwordOrigin(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS login domain without a path, port or credentials')
  }
  if (!url.hostname.includes('.') || url.hostname === 'localhost') throw new Error('Use the full login domain')
  return url.origin
}

