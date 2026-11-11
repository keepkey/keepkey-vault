/**
 * Starting a saved emulator wallet on a chosen firmware build.
 *
 * Firmware build and wallet are separate selections (a seed is not tied to the
 * firmware it was made on), so the start screen shows and sets both, and a
 * start runs exactly what it showed: the wallet clicked, on the firmware shown
 * beside it. A build that can't start is refused before the running emulator
 * is touched, and a failed start puts the previous build selection back.
 */
import { homedir } from 'os'
import { validateFlashName } from './emulator-keychain'
import {
  clearSelectedEmulatorBuild, emulatorBuildFlashName, recordEmulatorBuildVersion, resolveEmulatorWalletName,
  selectEmulatorBuild, selectEmulatorWallet, selectedEmulatorBuild, selectedEmulatorWallet, type SelectedEmulatorLibrary,
} from './emulator-library'
import { newEmulatorWalletNameError } from '../shared/emulatorWallets'
import type { EmulatorRunningBuild, EmulatorStatus } from '../shared/types'

export interface EmulatorSessionDeps {
  getEmulatorStatus(): EmulatorStatus
  getActiveFlashName(): string
  /** The running firmware's version as the engine read it, if it has. */
  firmwareVersion?(): string | undefined
  stopEmulator(): unknown
  initEmulator(name: string): EmulatorStatus
  openWindow(): void
  closeWindow(): void
  connectEmulator(): Promise<void>
  disconnectEmulator(): void
  listFlashImages(): string[]
  /** The firmware the next start loads, with this app's library paths. */
  library(): SelectedEmulatorLibrary
  /** Builds a start may pick (listEmulatorBuilds). */
  builds(): Array<{ id: string }>
  home?: string
}

/**
 * `buildId`: undefined keeps the selected build; null is the bundled (or
 * user-installed) library. The old connection is not waited on: disconnecting
 * the engine and stopping the emulator end its pending reads, a PIN prompt's
 * included, within one poll (emulator-transport.ts closedReason).
 *
 * A failed start leaves things as they were: the build selection is put back
 * and the wallet that was running is started again on it.
 * `allowBuildWallet`: a build change may open (create) that build's own
 * "build-<id>" wallet when no wallet is running or selected (first use).
 */
export async function startEmulatorWallet(deps: EmulatorSessionDeps, params: { name: string; buildId?: string | null; allowBuildWallet?: boolean }): Promise<EmulatorStatus> {
  const home = deps.home ?? homedir()
  const name = validateFlashName(params.name)
  const previousBuild = selectedEmulatorBuild(home)
  const targetBuild = params.buildId === undefined ? previousBuild : params.buildId
  const saved = deps.listFlashImages()
  if (!saved.includes(name)) {
    const selectedWallet = selectedEmulatorWallet(home)
    if (selectedWallet === name) throw new Error(`Saved emulator wallet "${name}" is missing. Select an existing wallet.`)
    const buildWallet = name === (targetBuild ? emulatorBuildFlashName(targetBuild) : 'default')
    const firstUseFallback = buildWallet && !selectedWallet && (!saved.length || params.allowBuildWallet === true)
    if (!firstUseFallback) {
      const problem = newEmulatorWalletNameError(name, saved)
      if (problem) throw new Error(`Cannot create emulator wallet: ${problem}`)
    }
  }

  const changeBuild = targetBuild !== previousBuild
  if (changeBuild && targetBuild !== null && !deps.builds().some(build => build.id === targetBuild)) {
    throw new Error('Emulator build is not installed')
  }
  const restoreBuild = () => {
    if (!changeBuild) return
    if (previousBuild) selectEmulatorBuild(previousBuild, home)
    else clearSelectedEmulatorBuild(home)
  }
  if (changeBuild) {
    if (targetBuild) selectEmulatorBuild(targetBuild, home)
    else clearSelectedEmulatorBuild(home)
  }
  // Before anything stops: a start that can't happen leaves the running emulator alone.
  const library = deps.library()
  if (library.problem) {
    restoreBuild()
    throw new Error(library.problem)
  }

  const previousWallet = deps.getEmulatorStatus().state === 'running' ? deps.getActiveFlashName() : null
  if (previousWallet) {
    deps.closeWindow()
    deps.disconnectEmulator()
    deps.stopEmulator()
  }
  try {
    const status = deps.initEmulator(name)
    if (status.state !== 'running') throw new Error(status.error || 'Emulator failed to start')
    deps.openWindow()
    await deps.connectEmulator()
  } catch (error) {
    // Never leave a different firmware or wallet running than the selections say.
    deps.closeWindow()
    deps.disconnectEmulator()
    deps.stopEmulator()
    restoreBuild()
    if (previousWallet) {
      try {
        const restored = deps.initEmulator(previousWallet)
        if (restored.state === 'running') { deps.openWindow(); await deps.connectEmulator() }
      } catch (restoreError) {
        console.error('[emulator] Could not restart the previous wallet:', (restoreError as Error)?.message)
      }
    }
    throw error
  }
  selectEmulatorWallet(name, home)
  return deps.getEmulatorStatus()
}

/** Settings' build select: run the wallet that is running (or the saved one) on
 *  another build. Same path, refusals and restore as a start from the picker. */
export async function activateEmulatorBuild(deps: EmulatorSessionDeps, id: string | null): Promise<{ status: EmulatorStatus; flashName: string }> {
  const home = deps.home ?? homedir()
  const running = deps.getEmulatorStatus().state === 'running' ? deps.getActiveFlashName() : null
  const flashName = resolveEmulatorWalletName({ running, buildId: id, home })
  const status = await startEmulatorWallet(deps, { name: flashName, buildId: id, allowBuildWallet: true })
  const version = deps.firmwareVersion?.()
  if (id && version && /^\d+\.\d+\.\d+$/.test(version)) recordEmulatorBuildVersion(id, version, home)
  return { status, flashName }
}

/**
 * Delete a saved emulator wallet. The seed picker's list can be stale, so the
 * running wallet is refused unless the caller stops it (Settings' "Delete
 * Flash", which says so). Checked again after `prepare` awaits: the wallet may
 * have been started meanwhile.
 */
export async function deleteEmulatorWallet(deps: {
  isRunning(name: string): boolean
  /** Work that must see the wallet's metadata before it goes (monitoring); may await. */
  prepare(name: string): Promise<void>
  stopRunning(): void
  erase(name: string): void
}, params: { name: string; stopIfRunning?: boolean }): Promise<void> {
  const refuse = () => {
    const running = deps.isRunning(params.name)
    if (running && params.stopIfRunning !== true) throw new Error(`"${params.name}" is running. Stop the emulator before deleting it.`)
    return running
  }
  refuse()
  await deps.prepare(params.name)
  // Stop it first so shutdown doesn't re-save the flash about to be deleted.
  if (refuse()) deps.stopRunning()
  deps.erase(params.name)
}

/** What the running emulator is, for the EMU badge: the wallet it loaded and the
 *  build it loaded (recorded at start, not re-resolved from today's selection). */
export function runningEmulatorIdentity(input: {
  flashName: string
  /** The device label from Features, or the one saved for this wallet. */
  label?: string | null
  loaded: SelectedEmulatorLibrary | null
  /** The running firmware's own version, when the engine has read it. */
  firmwareVersion?: string | null
}): Pick<EmulatorStatus, 'wallet' | 'build'> {
  const build: EmulatorRunningBuild = { id: input.loaded?.id ?? null }
  const version = input.firmwareVersion || input.loaded?.version
  if (version) build.version = version
  if (input.loaded?.label) build.label = input.loaded.label
  if (input.loaded?.research) build.research = true
  return { wallet: { name: input.flashName, ...(input.label ? { label: input.label } : {}) }, build }
}
