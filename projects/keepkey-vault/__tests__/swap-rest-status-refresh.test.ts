import { afterAll, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SwapHistoryRecord } from '../src/shared/types'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-rest-swap-status-'))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { startRestApi } = await import('../src/bun/rest-api')
db.initDb()
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const walletId = 'test-device:0x1111111111111111111111111111111111111111'
function fixture(refresh?: (txid: string, scope: any, rescan: boolean) => Promise<any>, foreign = false) {
  const txid = '0x' + crypto.randomUUID().replaceAll('-', '')
  const record: SwapHistoryRecord = { id: crypto.randomUUID(), deviceId: 'test-device', walletId: foreign ? 'other-wallet' : walletId,
    txid, fromAsset: 'BASE.ETH', toAsset: 'ETH.ETH', fromSymbol: 'ETH', toSymbol: 'ETH', fromChainId: 'base', toChainId: 'ethereum',
    fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:1/slip44:60', fromAmount: '0.006065', quotedOutput: '0.006011',
    minimumOutput: '0.00583', slippageBps: 300, feeBps: 30, feeOutbound: '0', integration: 'nearIntents', memo: '',
    inboundAddress: 'deposit', status: 'pending', createdAt: 1, updatedAt: 1, estimatedTimeSeconds: 42 }
  db.insertSwapHistory(record)
  let epoch = 1
  const engine: any = Object.assign(new EventEmitter(), { isPassphraseWallet: false, currentSeedEthAddress: walletId.split(':')[1], wallet: {},
    getDeviceState: () => ({ state: 'ready', deviceId: 'test-device', firmwareVersion: '7.17.0' }), getCachedFeaturesSnapshot: () => undefined })
  const auth: any = { requireAuth: () => ({ name: 'test' }), extractBearerToken: () => 'test', validate: () => true }
  const server = startRestApi(engine, auth, 0, { onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    getSessionEpoch: () => epoch, onSigningRequest: async () => { throw new Error('Status reads must never sign') },
    refreshSwapStatus: refresh,
  }, '127.0.0.1')
  return { txid, engine, setEpoch: () => { epoch++ }, stop: () => server.stop(true),
    read: (query = '') => fetch(`http://127.0.0.1:${server.port}/api/v1/swaps/${txid}${query}`, { headers: { Authorization: 'Bearer test' } }) }
}

test('ordinary history reads stay cached, while refresh invokes the tracker and returns its persisted settlement', async () => {
  let calls = 0
  const f = fixture(async (txid, scope, rescan) => {
    calls++; expect(scope).toEqual({ deviceId: 'test-device', walletId }); expect(rescan).toBe(false)
    db.updateSwapHistoryStatus(txid, 'completed', { deviceId: scope.deviceId, walletId: scope.walletId, receivedOutput: '0.006011', outboundTxid: '0xpayout', completedAt: 123 })
    return { statusCheck: { checkedAt: 123 } }
  })
  try {
    expect((await (await f.read()).json() as any).status).toBe('pending'); expect(calls).toBe(0)
    const response = await f.read('?refresh=true')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'completed', receivedOutput: '0.006011', outboundTxid: '0xpayout', statusCheck: { checkedAt: 123 } })
    expect(calls).toBe(1)
  } finally { f.stop() }
})
test('manual rescan reaches the tracker explicitly', async () => {
  const f = fixture(async (_txid, _scope, rescan) => { expect(rescan).toBe(true); return { statusCheck: { checkedAt: 1 } } })
  try { expect((await f.read('?refresh=true&rescan=true')).status).toBe(200) } finally { f.stop() }
})
test('a missing refresh implementation is visible rather than a successful cached check', async () => {
  const f = fixture()
  try { expect((await f.read('?refresh=true')).status).toBe(503) } finally { f.stop() }
})
test('another wallet cannot cause provider reads for this swap', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return null }, true)
  try { expect((await f.read('?refresh=true')).status).toBe(404); expect(calls).toBe(0) } finally { f.stop() }
})
test('a wallet/session change during refresh cannot return the old wallet result', async () => {
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const f = fixture(async () => { entered(); await new Promise<void>(resolve => { finish = resolve }); return { statusCheck: { checkedAt: 1 } } })
  try {
    const response = f.read('?refresh=true'); await started
    f.engine.currentSeedEthAddress = '0x2222222222222222222222222222222222222222'; f.setEpoch(); finish()
    expect((await response).status).toBe(404)
  } finally { f.stop() }
})
test('overlapping active-page checks share one provider refresh', async () => {
  let calls = 0, finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const f = fixture(async () => { calls++; entered(); await new Promise<void>(resolve => { finish = resolve }); return { statusCheck: { checkedAt: 1 } } })
  try {
    const first = f.read('?refresh=true'); await started
    const second = f.read('?refresh=true'); await Bun.sleep(10); finish()
    expect((await first).status).toBe(200); expect((await second).status).toBe(200); expect(calls).toBe(1)
  } finally { f.stop() }
})
test('an unavailable provider is returned as unavailable, not freshly verified', async () => {
  const f = fixture(async () => ({ statusCheck: { checkedAt: 100, error: 'unavailable' } }))
  try { expect(await (await f.read('?refresh=true')).json()).toMatchObject({ status: 'pending', statusCheck: { error: 'unavailable' } }) } finally { f.stop() }
})
