export const PASSWORD_BANK_ALGORITHM = 'keepkey-ckv-base64url-v1' as const
/** The unlock session lasts this long and is never extended; a cached password
 *  ends with it, so it is also the longest cache duration the bank accepts. */
export const PASSWORD_CACHE_MAX_MINUTES = 15
export interface PasswordProfile {
  id: string
  origin: string
  account: string
  slot: number
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
  profiles: (PasswordProfile & { cachedUntil?: number; pendingCachedUntil?: number; due: boolean })[]
  readySlots: { slot: number; symbolFormat: boolean; cachedUntil?: number }[]
  backupRequired: boolean
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

export const PASSWORD_ROTATION_GUIDES = [
  { id: 'google', name: 'Google', loginOrigin: 'https://accounts.google.com', settingsUrl: 'https://myaccount.google.com/security', note: 'Open Password under Security and sign-in. Complete reauthentication or MFA yourself. Changing it can sign out other sessions.' },
  { id: 'github', name: 'GitHub', loginOrigin: 'https://github.com', settingsUrl: 'https://github.com/settings/security', note: 'Open Change password. Complete any account verification yourself.' },
  { id: 'microsoft', name: 'Microsoft', loginOrigin: 'https://login.live.com', settingsUrl: 'https://account.microsoft.com/security', note: 'Open password security. Complete account verification yourself.' },
] as const
