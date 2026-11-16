/** Execute the actual REST router/auth with no listener, device, or network. */
import { mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSwapQuoteLeases } from '../../src/bun/swap-quote-lease'
import { assessSwapRisk } from '../../src/shared/swap-risk'
import type { ExecuteSwapParams, SwapAsset, SwapQuote } from '../../src/shared/types'

const profile = mkdtempSync(join(tmpdir(), 'rest-zcash-admission-'))
mock.module('electrobun/main/utils', () => ({ paths: { userData: profile } }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: profile } } }))
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: class {} }))
mock.module('usb', () => ({ usb: Object.assign(new EventEmitter(), { getDeviceList: () => [] }) }))
mock.module('node-hid', () => ({ devices: () => [], HID: class {} }))
process.dlopen = (() => { throw new Error('Native addons are forbidden in the REST admission fixture') }) as typeof process.dlopen
globalThis.fetch = (() => { throw new Error('Network requests are forbidden in the REST admission fixture') }) as typeof fetch
const Utils = await import('electrobun/main/utils')
if (Utils.paths.userData !== profile) throw new Error('The REST fixture must use only its disposable profile')
const db = await import('../../src/bun/db')
const { AuthStore } = await import('../../src/bun/auth')
const { startRestApi } = await import('../../src/bun/rest-api')
db.initDb()

const inputs = [{ addressNList: [0x8000002c, 0x80000000, 0x80000000, 0, 0], txid: '11'.repeat(32), vout: 0, amount: '20000', scriptType: 'p2pkh' }]
const outputs = [{ address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amount: '10000', scriptType: 'p2pkh' }]
type Options = { locked?: boolean; wallet?: boolean; approval?: boolean; authenticated?: boolean; allowDevice?: boolean;
  path?: string; validateSwap?: (params: ExecuteSwapParams) => ExecuteSwapParams }
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
      ...(options.validateSwap ? { validateSwapExecutionHeadless: options.validateSwap,
        executeSwapHeadless: async () => { counts.signs++; return { txid: '11'.repeat(32) } } } : {}),
    }, '127.0.0.1')
  } finally { Bun.serve = serve }
  try {
    const input = new Request('http://rest-admission.invalid' + (options.path ?? '/utxo/sign-transaction'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.authenticated === false ? {} : { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(body),
    })
    const response = await route!(input, fakeServer)
    return { status: response.status, data: JSON.parse(await response.text()), counts, signedCoin }
  } finally { server!.stop() }
}

/** Actual immutable quote claims identify the source; renderer labels alone are not authority. */
function swap(fromChainId: 'zcash' | 'bitcoin', toChainId: 'zcash' | 'bitcoin', change: Record<string, unknown> = {}) {
  const caips = { bitcoin: 'bip122:000000000019d6689c085ae165831e93/slip44:0', zcash: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133' }
  const leases = createSwapQuoteLeases(() => 1_000_000)
  const input = { fromCaip: caips[fromChainId], toCaip: caips[toChainId], amount: '0.01',
    fromAddress: 'public-fixture-source', toAddress: 'public-fixture-destination', isMax: false }
  const quote: SwapQuote = { expectedOutput: '0.01', minimumOutput: '0.0099', memo: '', inboundAddress: 'public-fixture-deposit',
    fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 60, slippageBps: 100, integration: 'nearIntents', swapper: 'NEAR Intents' }
  const risk = assessSwapRisk({ inputAmount: 0.01, expectedAmount: 0.01, minimumAmount: 0.0099, fromPriceUsd: 1, toPriceUsd: 1, sameAssetUnits: false })
  const issued = leases.issue(input, quote, { chainId: fromChainId, decimals: 8 } as SwapAsset,
    { chainId: toChainId, decimals: 8 } as SwapAsset, 0, risk)
  const body = { quoteId: issued.quoteId, fromChainId, toChainId, fromCaip: input.fromCaip, toCaip: input.toCaip,
    amount: input.amount, isMax: false, memo: quote.memo, inboundAddress: quote.inboundAddress,
    expectedOutput: quote.expectedOutput, integration: quote.integration, swapper: quote.swapper, ...change }
  const validateSwap = (params: ExecuteSwapParams) => { const lease = leases.claim(params, 0); lease.finish(false); return lease.params }
  return { body, validateSwap, path: '/api/v2/swap/execute' }
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
  for (const [name, options] of Object.entries({ 'swap-zcash-locked': {}, 'swap-zcash-unlocked': { locked: false },
    'swap-zcash-no-device': { wallet: false }, 'swap-zcash-no-approval-callback': { approval: false },
    'swap-zcash-unauthenticated': { authenticated: false } })) {
    const fixture = swap('zcash', 'bitcoin')
    results[name] = await request(name, fixture.body, { ...fixture, ...options })
  }
  for (const [name, change] of Object.entries({ 'swap-forged-source-chain': { fromChainId: 'bitcoin' },
    'swap-forged-source-caip': { fromCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0' } })) {
    const fixture = swap('zcash', 'bitcoin', change)
    results[name] = await request(name, fixture.body, fixture)
  }
  const incoming = swap('bitcoin', 'zcash')
  results['swap-bitcoin-to-zcash'] = await request('swap-bitcoin-to-zcash', incoming.body, { ...incoming, allowDevice: true })
  results['swap-empty-probe'] = await request('swap-empty-probe', {}, incoming)
  console.log(JSON.stringify(results))
} finally { db.closeDb(); rmSync(profile, { recursive: true, force: true }) }
// Imported production modules may retain background handles; all requests and
// cleanup have completed. Do not leave a fixture subprocess alive indefinitely.
process.exit(0)
