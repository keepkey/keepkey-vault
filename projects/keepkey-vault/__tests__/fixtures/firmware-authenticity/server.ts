/** Isolated real-wizard QA. Every native mutation is denied and recorded. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const settings = {
  passwordManagerEnabled: false, moneroEnabled: false, moneroAvailable: false,
  zcashPrivacyEnabled: false, btcMultisigEnabled: false, walletConnectEnabled: false,
  emulatorEnabled: false, hiveEnabled: false, offlineMode: false, restApiEnabled: false,
  alphaFirmware: false, preReleaseUpdates: false, appLanguage: 'en',
}
const defaultDevice = {
  state: 'ready', activeTransport: 'webusb', updatePhase: 'idle', bootloaderMode: false,
  needsBootloaderUpdate: false, needsFirmwareUpdate: false, needsInit: false,
  initialized: true, passphraseProtection: false, isOob: false, isEmulator: false,
  firmwareVersion: '7.99.0', bootloaderVersion: '2.1.4', label: 'Synthetic firmware QA',
  latestFirmware: '7.16.0', latestFirmwareBitcoinOnly: '7.16.0', latestBootloader: '2.1.4',
  latestFirmwareHash: 'b'.repeat(64), firmwareHash: 'f'.repeat(64), firmwareVerified: false,
  bootloaderHash: 'a'.repeat(64), bootloaderVerified: true, bootloaderRelease: 'v2.1.4',
  firmwareSignaturesVerified: false, firmwareChannel: 'latest', installedBitcoinOnly: false,
  installFirmware: { version: 'v7.16.0', signed: true },
  installBootloader: { version: 'v2.1.4', signed: true },
  installWipeReason: { multi: 'unsigned-to-signed', bitcoinOnly: 'unsigned-to-signed' },
}
let scenario = 'normal'
let overrides: Record<string, unknown> = {}
type Call = { method: string; params?: unknown; blocked?: boolean; error?: string }
let calls: Call[] = []
const deviceFor = (mode: string) => {
  const device: Record<string, unknown> = { ...defaultDevice, ...overrides }
  if (mode === 'disconnected') Object.assign(device, { state: 'disconnected', activeTransport: null })
  if (mode === 'needs-bootloader') Object.assign(device, { needsBootloaderUpdate: true, bootloaderVersion: '2.1.0' })
  if (mode === 'unknown-lineage') delete device.installedBitcoinOnly
  if (mode === 'verified') Object.assign(device, { firmwareVersion: '7.16.0', firmwareVerified: true, firmwareRelease: 'v7.16.0' })
  return device
}
const rpc = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(req) {
  const { method, params } = await req.json()
  const call: Call = { method, params }; calls.push(call)
  const mode = req.headers.get('X-Fixture-Scenario') || scenario
  try {
    let payload: unknown = {}
    switch (method) {
      case 'testReset': scenario = params?.scenario || 'normal'; overrides = {}; calls = []; break
      case 'testCalls': payload = [...calls]; break
      case 'testState': payload = { scenario, settings, device: deviceFor(scenario), calls }; break
      case 'testSetDeviceState': overrides = { ...overrides, ...params }; payload = deviceFor(scenario); break
      case 'getDeviceState': payload = deviceFor(mode); break
      case 'getAppSettings': payload = settings; break
      case 'getFeatures': payload = { initialized: true, pinProtection: true, passphraseProtection: false, majorVersion: 7, minorVersion: 99, patchVersion: 0 }; break
      case 'logOnboarding': break
      default:
        call.blocked = true
        throw new Error(`Native RPC is disabled in firmware UI QA: ${method}`)
    }
    return Response.json({ success: true, payload })
  } catch (error: any) {
    call.error = error.message
    return Response.json({ success: false, error: error.message })
  }
} })

// Optional old-source override proves the new action is a regression assertion.
const authenticitySource = resolve(import.meta.dir, '../../../src/mainview/components/FirmwareAuthenticity.tsx')
const baselineFile = process.env.QA_FIRMWARE_BASELINE_FILE
const baselinePlugin = {
  name: 'qa-firmware-authenticity-baseline', enforce: 'pre' as const,
  load(id: string) {
    if (baselineFile && id.split('?')[0] === authenticitySource) return readFileSync(baselineFile, 'utf8')
  },
}
const port = Number(process.env.FIRMWARE_QA_PORT || 5204)
const vite = await createServer({
  configFile: false, plugins: [baselinePlugin, react()], root: import.meta.dir,
  server: {
    host: '127.0.0.1', port, strictPort: true,
    fs: { allow: [new URL('../../../..', import.meta.url).pathname] },
    proxy: { '/__test_rpc': `http://127.0.0.1:${rpc.port}` },
  },
})
await vite.listen()
console.log(`Synthetic firmware authenticity fixture: http://127.0.0.1:${port}`)
