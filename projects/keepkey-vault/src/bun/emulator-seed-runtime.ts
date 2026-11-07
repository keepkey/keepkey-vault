import { createEmulatorSeedBackup } from './emulator-seed-backup'
import { getActiveFlashName, getEmulatorInstance, getEmulatorStatus } from './emulator'
import { displaySeedWords } from './emulator-window'

type Engine = {
  isEmulator: boolean
  wallet: object | null
  emuDelegate: unknown
  getDeviceState(): { state: string }
  getEmulatorMnemonic(): Promise<string | null>
}
const backups = new WeakMap<Engine, ReturnType<typeof createEmulatorSeedBackup>>()

export function revealEmulatorSeed(engine: Engine, enabled: () => boolean) {
  let backup = backups.get(engine)
  if (!backup) {
    backup = createEmulatorSeedBackup({
      session: () => {
        if (!enabled() || !engine.isEmulator || engine.getDeviceState().state !== 'ready' || getEmulatorStatus().state !== 'running') return null
        const wallet = engine.wallet as { transport?: { delegate?: object } } | null
        const delegate = wallet?.transport?.delegate
        if (!wallet || !delegate || delegate !== engine.emuDelegate) return null
        return { wallet, delegate, instance: getEmulatorInstance(), flashName: getActiveFlashName() }
      },
      readLive: () => engine.getEmulatorMnemonic(),
      display: displaySeedWords,
    })
    backups.set(engine, backup)
  }
  return backup()
}
