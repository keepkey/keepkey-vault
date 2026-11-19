// Automation for the disposable packaged-app fixture. It uses the regular
// engine unlock and the actual WKWebView canvas capture. No network controls.
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { EngineController } from './engine-controller'
import { captureCurrentFrame, signingReviewFrame } from './emulator-window'
import { getActiveFlashName, getLoadedEmulatorLibPath, getLoadedEmulatorLibrarySha256 } from './emulator'

export const PACKAGED_PIN_FIXTURE = 'vault-pin-smoke'

export function packagedPinSmokeDirectory(): string | undefined {
  const profile = process.env.KEEPKEY_PACKAGED_PIN_SMOKE
  if (!profile) return
  if (profile !== homedir() || !/^kk-pin-[a-zA-Z0-9]+$/.test(basename(profile)) ||
      !existsSync(join(profile, '.vault-pin-smoke')) ||
      process.env.KEEPKEY_AUTOSTART_EMULATOR_FLASH !== PACKAGED_PIN_FIXTURE) {
    throw new Error('Packaged PIN smoke requires its own disposable profile and fixture flash')
  }
  return profile
}

export async function runPackagedPinSmoke(engine: EngineController, profile: string) {
  if (!engine.isEmulator || getActiveFlashName() !== PACKAGED_PIN_FIXTURE ||
      engine.getDeviceState().label !== PACKAGED_PIN_FIXTURE || engine.getDeviceState().state !== 'needs_pin') {
    throw new Error('Packaged PIN smoke requires the locked emulator fixture')
  }
  const publish = (name: string, value: unknown) => {
    const file = join(profile, name)
    writeFileSync(file + '.tmp', JSON.stringify(value), {mode: 0o600})
    renameSync(file + '.tmp', file)
  }
  let requests = 0
  let requestAt = 0
  let wrongPin = false
  let unlockError: unknown
  const onPrompt = ({ type }: { type: string }) => {
    if (type === 'current') {
      requests++
      requestAt = Date.now()
    }
  }
  const onError = ({ code }: { code: number }) => { if (code === 7) wrongPin = true }
  engine.on('pin-request', onPrompt)
  engine.on('pin-error', onError)
  const unlock = engine.promptPin().catch(error => { unlockError = error })
  try {
    for (const attempt of [1, 2]) {
      const deadline = Date.now() + 18_000
      const answerPath = join(profile, `answer-${attempt}`)
      while (!existsSync(answerPath)) {
        if (unlockError) throw unlockError
        if (Date.now() > deadline) throw new Error(`PIN smoke timed out on prompt ${attempt}`)
        if (requests >= attempt && Date.now() - requestAt >= 250 && (attempt === 1 || wrongPin)) {
          const raw = signingReviewFrame()
          const png = await captureCurrentFrame(true).catch(() => null)
          if (raw && png && raw === signingReviewFrame()) publish(`frame-${attempt}`, { raw, png })
        }
        await Bun.sleep(120)
      }
      const answer = readFileSync(answerPath, 'utf8')
      if (requests < attempt || (attempt === 2 && !wrongPin) ||
          !(attempt === 1 ? /^[1-9]$/ : /^[1-9]{4}$/).test(answer)) {
        throw new Error(`Invalid smoke answer for prompt ${attempt}`)
      }
      await engine.sendPin(answer)
    }
    await unlock
    if (unlockError) throw unlockError
    if (engine.getDeviceState().state !== 'ready') throw new Error('Fixture failed to unlock')
    publish('result', { path: getLoadedEmulatorLibPath(), sha256: getLoadedEmulatorLibrarySha256(), wrongPin, requests })
  } finally {
    engine.off('pin-request', onPrompt)
    engine.off('pin-error', onError)
  }
}
