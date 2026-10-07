/**
 * Which top-level screen App renders. Kept out of App.tsx so the precedence
 * rules — the setup lock above all — have a test.
 */
export type AppPhase = "splash" | "claimed" | "setup" | "ready"

export function resolveAppPhase(p: {
  state: string
  /** Wizard must stay mounted: setup in progress, or the device entered OOB this session. */
  oobLock: boolean
  isClaimed: boolean
  firmwareSkipped: boolean
  wizardComplete: boolean
}): AppPhase {
  // oobLock takes priority — during OOB, transient claim errors are expected
  // (device reboots, brief LIBUSB_ERROR_ACCESS). Don't unmount the wizard.
  if (p.oobLock) return "setup"
  if (p.isClaimed) return "claimed"
  if (["disconnected", "connected_unpaired", "error"].includes(p.state)) return "splash"
  // Firmware update skipped this session — let the user into the app on the
  // older firmware. TopNav keeps showing the "vX → vY" update reminder.
  if (p.firmwareSkipped && p.state === "needs_firmware") return "ready"
  if (!p.wizardComplete && ["bootloader", "needs_firmware", "needs_init"].includes(p.state)) return "setup"
  if (p.state === "ready") return "ready"
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
