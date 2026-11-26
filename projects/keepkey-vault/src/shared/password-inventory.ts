import type { PasswordProfile } from './password-bank'

/** Slot numbers follow generation order, including staged replacements. */
export function orderedPasswordProfiles<T extends Pick<PasswordProfile, 'slot' | 'pendingSlot'>>(profiles: readonly T[]): T[] {
  const latestSlot = (profile: T) => Math.max(profile.slot, profile.pendingSlot ?? profile.slot)
  return [...profiles].sort((a, b) => latestSlot(b) - latestSlot(a))
}
