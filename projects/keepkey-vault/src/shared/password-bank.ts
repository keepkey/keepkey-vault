export const PASSWORD_BANK_ALGORITHM = 'keepkey-ckv-base64url-v1' as const
export type PasswordRiskKind = 'compromised' | 'reused' | 'weak'
export interface PasswordRiskFinding {
  kind: PasswordRiskKind
  source: 'user' | 'chrome-password-checkup'
  mode: 'user-reported'
  observedAt: number
  slot: number | null // null: the pre-migration website password is not in KeepKey
  resolvedAt?: number
}
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
  riskFindings?: PasswordRiskFinding[]
}
export interface PasswordAgentApproval {
  id: string
  profileId: string
  account: string
  origin: string
  browser: string
  tabId: number
  fieldLabel: string
  pending: boolean
  expiresAt: number
}
export interface PasswordBankView {
  enabled: boolean
  exists: boolean
  unlocked: boolean
  bankId?: string
  algorithm: typeof PASSWORD_BANK_ALGORITHM
  profiles: (PasswordProfile & { cachedUntil?: number; pendingCachedUntil?: number; due: boolean })[]
  readySlots: { slot: number; cachedUntil?: number }[]
  backupRequired: boolean
  revision: number
}
export interface PasswordBankBackup {
  format: 'keepkey-password-bank'
  version: 1
  bankId: string
  iv: string
  ciphertext: string
  tag: string
}
export interface PasswordBrowserTarget {
  browser: string
  tabId: number
  title: string
  origin: string
  documentToken: string
  targets: { ref: string; label: string }[]
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

/** Explicit identity-provider origins, never a wildcard or suffix match. */
export function passwordFillOrigins(loginOrigin: string): string[] {
  const guide = PASSWORD_ROTATION_GUIDES.find(g => g.loginOrigin === loginOrigin)
  return [...new Set([loginOrigin, ...(guide ? [new URL(guide.settingsUrl).origin] : []), ...(guide?.id === 'microsoft' ? ['https://account.live.com'] : [])])]
}
