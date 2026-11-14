/**
 * Which top-level screen App renders. Kept out of App.tsx so the precedence
 * rules — the setup lock above all — have a test.
 */
export type AppPhase = "splash" | "claimed" | "setup" | "ready" | "leave-bootloader"

/** RAM-only continuity of a wallet already opened on this connection. Device id
 * alone is insufficient: disconnects, setup and passphrase changes end it. */
export interface LivePortfolioSession {
  deviceId: string
  transport: string
  hidden: boolean
}

export function retainLivePortfolioSession(previous: LivePortfolioSession | null, device: {
  state: string
  deviceId?: string
  activeTransport: string | null
  isHiddenWallet?: boolean
  initialized: boolean
  wipePending?: string
}): LivePortfolioSession | null {
  if (!device.initialized || !device.deviceId || !device.activeTransport || device.wipePending) return null
  const current = { deviceId: device.deviceId, transport: device.activeTransport, hidden: !!device.isHiddenWallet }
  if (device.state === 'ready') return current
  if (device.state === 'needs_pin' && previous?.deviceId === current.deviceId
    && previous.transport === current.transport && previous.hidden === current.hidden) return previous
  return null
}

export function resolveAppPhase(p: {
  state: string
  /** Wizard must stay mounted: setup in progress, or the device entered OOB this session. */
  oobLock: boolean
  isClaimed: boolean
  firmwareSkipped: boolean
  wizardComplete: boolean
  /** In bootloader mode with nothing to install: the user only has to replug. */
  bootloaderIdle?: boolean
  /** The same live wallet reached ready before this PIN lock. Never persisted. */
  lockedPortfolioAvailable?: boolean
}): AppPhase {
  // oobLock takes priority — during OOB, transient claim errors are expected
  // (device reboots, brief LIBUSB_ERROR_ACCESS). Don't unmount the wizard.
  if (p.oobLock) return "setup"
  if (p.isClaimed) return "claimed"
  if (["disconnected", "connected_unpaired", "error"].includes(p.state)) return "splash"
  // Firmware update skipped this session — let the user into the app on the
  // older firmware. TopNav keeps showing the "vX → vY" update reminder.
  if (p.firmwareSkipped && p.state === "needs_firmware") return "ready"
  // Nothing to install: setup would only loop back to itself. Ask for a replug.
  if (p.state === "bootloader" && p.bootloaderIdle) return "leave-bootloader"
  if (!p.wizardComplete && ["bootloader", "needs_firmware", "needs_init"].includes(p.state)) return "setup"
  if (p.state === "ready") return "ready"
  if (p.state === "needs_pin" && p.lockedPortfolioAvailable) return "ready"
  return "splash"
}

/**
 * Watch-only (the cached portfolio) shows on any disconnect with a cache — but
 * never over setup. Setup tells the user to unplug to reach the bootloader; a
 * cache from ANY earlier device must not unmount the wizard (it did, v1.5.3+).
 */
export function showWatchOnly(watchOnlyMode: boolean, phase: AppPhase): boolean {
  return watchOnlyMode && phase !== "setup"
}

/** A KeepKey plugged in locked opens its own PIN (then passphrase) prompt, once
 * per connection. Not over a pending wipe or setup, and not over a portfolio the
 * device's auto-lock locked while open: that keeps its explicit Unlock. */
export function autoUnlockKey(p: { phase: AppPhase; state: string; deviceId?: string; activeTransport: string | null; wipePending?: string }): string | null {
  if (p.phase !== 'splash' || p.wipePending || !p.deviceId || !p.activeTransport) return null
  if (p.state !== 'needs_pin' && p.state !== 'needs_passphrase') return null
  return `${p.deviceId}:${p.activeTransport}`
}

/** The connected KeepKey ends watch-only of its own snapshot only once it is
 * unlocked. While it is locked, "Open view-only" keeps the cached wallet open
 * (#633); exiting there dropped the user back on the PIN screen. */
export function watchOnlyEndsForDevice(watchedId: string, device: { state: string; deviceId?: string }): boolean {
  return device.deviceId === watchedId && device.state === 'ready'
}

/** Text under the Unlock button. Backing out of the PIN entry (a 499 cancel) is
 * the user's choice, not an error to show. */
export function unlockErrorText(error: unknown, fallback: string): string | null {
  const message = typeof (error as any)?.message === 'string' ? (error as any).message : ''
  if ((error as any)?.status === 499 || /\bcancel/i.test(message)) return null
  return message || fallback
}
