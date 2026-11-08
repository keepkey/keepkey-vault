import type { PasswordBankView, PasswordProfile } from './password-bank'
import { PASSWORD_SERVICE_HELPERS } from './password-services'

/** Whitelist metadata explicitly: never spread a future credential record into
 * an API response. Cache absence means refill required, not website expiry. */
export function passwordInventory(view: PasswordBankView, now = Date.now()) {
  const profiles = (view.enabled && view.unlocked ? view.profiles : []).map(p => {
    const findings = (p.riskFindings || []).filter(f => !f.resolvedAt && f.slot === (p.changedAt ? p.slot : null))
    const kinds = findings.map(f => f.kind)
    const state = p.rotationState === 'submitted' ? 'verification-needed' : p.pendingSlot !== undefined ? 'prepared' : !p.changedAt ? 'setup-required' : p.due ? 'review-due' : 'current'
    const priority = state === 'verification-needed' || kinds.includes('compromised') ? 'critical' : kinds.includes('reused') ? 'high' : kinds.includes('weak') || state === 'review-due' ? 'medium' : 'normal'
    const rank = state === 'verification-needed' ? 0 : kinds.includes('compromised') ? 1 : kinds.includes('reused') ? 2 : kinds.includes('weak') ? 3 : state === 'prepared' ? 4 : state === 'setup-required' ? 5 : state === 'review-due' ? 6 : 7
    return {
      id: p.id, origin: p.origin, account: p.account,
      service: PASSWORD_SERVICE_HELPERS.find(h => h.matchOrigins.some(o => o === p.origin))?.id || null,
      location: { slot: p.slot, pendingSlot: p.pendingSlot ?? null },
      rotation: { state, required: kinds.length > 0 || state !== 'current', lastVerifiedAt: p.changedAt ?? null, reviewAt: p.changedAt ? p.changedAt + p.reviewDays * 86400000 : null },
      cache: { state: p.cachedUntil && p.cachedUntil > now ? 'available' : 'needs-rehydration', expiresAt: p.cachedUntil ?? null, pendingExpiresAt: p.pendingCachedUntil ?? null },
      risk: { status: findings.length ? 'reported-findings' : 'not-assessed', findings: findings.map(f => ({ kind: f.kind, source: f.source, mode: f.mode, observedAt: f.observedAt })) },
      priority, rank,
    }
  }).sort((a, b) => a.rank - b.rank || a.account.localeCompare(b.account))
  return {
    enabled: view.enabled, exists: view.exists, unlocked: view.unlocked,
    visibility: !view.enabled ? 'disabled' : view.unlocked ? 'available' : 'locked',
    revision: view.revision, backupRequired: view.backupRequired,
    readyCount: view.readySlots.length,
    counts: { profiles: profiles.length, rotationRequired: profiles.filter(p => p.rotation.required).length, refillRequired: profiles.filter(p => p.cache.state === 'needs-rehydration').length, critical: profiles.filter(p => p.priority === 'critical').length },
    profiles,
    chromeCheckup: { availability: 'user-reported-only', automaticallyScanned: false, absenceOfFindingsMeansSafe: false },
  }
}
export type PasswordInventory = ReturnType<typeof passwordInventory>
export function activePasswordRiskKinds(p: PasswordProfile) {
  return (p.riskFindings || []).filter(f => !f.resolvedAt && f.slot === (p.changedAt ? p.slot : null)).map(f => f.kind)
}
