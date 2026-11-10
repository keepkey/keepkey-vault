/** Execute the actual REST router/auth with no listener, device, or network. */
import { mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'rest-zcash-admission-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: profile } } }))
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: class {} }))
mock.module('usb', () => ({ usb: Object.assign(new EventEmitter(), { getDeviceList: () => [] }) }))
mock.module('node-hid', () => ({ devices: () => [], HID: class {} }))
process.dlopen = (() => { throw new Error('Native addons are forbidden in the REST admission fixture') }) as typeof process.dlopen
globalThis.fetch = (() => { throw new Error('Network requests are forbidden in the REST admission fixture') }) as typeof fetch
const db = await import('../../src/bun/db')
const { AuthStore } = await import('../../src/bun/auth')
const { startRestApi } = await import('../../src/bun/rest-api')
db.initDb()

const inputs = [{ addressNList: [0x8000002c, 0x80000000, 0x80000000, 0, 0], txid: '11'.repeat(32), vout: 0, amount: '20000', scriptType: 'p2pkh' }]
const outputs = [{ address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount: '10000', scriptType: 'p2pkh' }]
type Options = { locked?: boolean; wallet?: boolean; approval?: boolean; authenticated?: boolean; allowDevice?: boolean }
async function request(name: string, body: unknown, options: Options = {}) {
  let locked = options.locked ?? true
  const counts = { acquisitions: 0, unlocks: 0, approvals: 0, reads: 0, signs: 0, releases: 0 }
  let signedCoin: string | undefined
  const wallet = {
    getFeatures: async () => { counts.reads++; throw new Error('Device reads are outside this fixture') },
    btcSignTx: async (transaction: any) => { counts.signs++; signedCoin = transaction.coin; return { serializedTx: '01000000000000000000' } },
  }
  const engine: any = Object.assign(new EventEmitter(), {
    wallet: options.wallet === false ? null : wallet, isEmulator: false, isPassphraseWallet: false,
    isSyncing: false, wipeInProgress: false, wipeOnReconnect: false, currentSeedEthAddress: '0x' + '01'.repeat(20),
    getDeviceState: () => ({ state: locked ? 'needs_pin' : 'ready', deviceId: name, firmwareVersion: '7.16.0', capabilities: [] }),
    acquireDeviceOperation: async () => {
      counts.acquisitions++
      if (!options.allowDevice) throw new Error('Unexpected device admission for a blocked REST request')
      if (locked) { counts.unlocks++; locked = false }
      return () => { counts.releases++ }
    },
  })
  Object.defineProperty(engine, 'isLocked', { get: () => locked })
  const auth = new AuthStore()
  const apiKey = auth.pair({ name, url: 'https://synthetic.invalid', imageUrl: '' })
  let route: ((req: Request, server: any) => Response | Promise<Response>) | undefined
  const fakeServer = { hostname: '127.0.0.1', port: 0, timeout() {}, requestIP: () => ({ address: '127.0.0.1' }), stop() {}, upgrade() { throw new Error('No websocket fixture') } }
  const serve = Bun.serve
  let server: ReturnType<typeof startRestApi>
  Bun.serve = ((configuration: any) => { if (route) throw new Error('Unexpected listener'); route = configuration.fetch; return fakeServer }) as typeof Bun.serve
  try {
    server = startRestApi(engine, auth, 0, { onApiLog() {}, getSessionEpoch: () => 0,
      ...(options.approval === false ? {} : { onSigningRequest: async () => { counts.approvals++; return { approved: true } }, onSigningDismissed() {} }),
    }, '127.0.0.1')
  } finally { Bun.serve = serve }
  try {
    const input = new Request('http://rest-admission.invalid/utxo/sign-transaction', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.authenticated === false ? {} : { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(body),
    })
    const response = await route!(input, fakeServer)
    return { status: response.status, data: JSON.parse(await response.text()), counts, signedCoin }
  } finally { server!.stop() }
}

try {
  const zcash = { coin: 'Zcash', inputs, outputs, version: 4 }
  const results: Record<string, unknown> = {}
  results.locked = await request('locked', zcash)
  results.unlocked = await request('unlocked', zcash, { locked: false })
  results['no-device'] = await request('no-device', zcash, { wallet: false })
  results['no-approval-callback'] = await request('no-approval-callback', zcash, { approval: false })
  results['forged-modern-plan'] = await request('forged-modern-plan', { ...zcash, version: 6, zcashTransparent: true, isAlphaEmulator: true, firmwareVersion: '7.17.0', branchId: 0x77190ad9 })
  results['case-variation'] = await request('case-variation', { ...zcash, coin: ' zCaSh ' })
  results['incomplete-zcash'] = await request('incomplete-zcash', { coin: 'Zcash' })
  results.unauthenticated = await request('unauthenticated', zcash, { authenticated: false })
  results.bitcoin = await request('bitcoin', { coin: 'Bitcoin', inputs, outputs }, { allowDevice: true })
  results['bitcoin-default'] = await request('bitcoin-default', { inputs, outputs }, { allowDevice: true })
  console.log(JSON.stringify(results))
} finally { db.closeDb(); rmSync(profile, { recursive: true, force: true }) }
