/** Actual manager, production WC callbacks and hdwallet wire, with no network/native device. Run isolated. */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import * as Ethereum from '@keepkey/device-protocol/lib/messages-ethereum_pb'
import { Transport, create, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('usb', () => ({ usb: new EventEmitter() }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/tmp/kk-wc-session-unused' } } }))
const originalFetch = globalThis.fetch
globalThis.fetch = (async () => { throw new Error('Network forbidden in WalletConnect session fixture') }) as typeof fetch
afterAll(() => { globalThis.fetch = originalFetch })
const { EngineController } = await import('../src/bun/engine-controller')
const { deviceOperationContext } = await import('../src/bun/device-operation')
const managerSource = process.env.WC_SESSION_MANAGER_SOURCE || new URL('../src/bun/walletconnect.ts', import.meta.url).href
const { WalletConnectManager } = await import(managerSource)

// Execute the actual production session getter, coordinator callback, signing
// callback and host-card callback, without importing the native app entrypoint.
const indexText = readFileSync(new URL('../src/bun/index.ts', import.meta.url), 'utf8')
const source = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let callbackProperties: ts.NodeArray<ts.ObjectLiteralElementLike> | undefined
function visit(node: ts.Node) {
  if (ts.isNewExpression(node) && node.expression.getText(source) === 'WalletConnectManager') {
    const options = node.arguments?.[0]
    if (options && ts.isObjectLiteralExpression(options)) callbackProperties = options.properties
  }
  ts.forEachChild(node, visit)
}
visit(source)
const transpiler = new Bun.Transpiler({ loader: 'ts' })
function productionCallback(name: string, dependencies: Record<string, unknown>) {
  const property = callbackProperties?.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === name)
  if (!property || !ts.isPropertyAssignment(property)) throw new Error(`Missing production WC callback ${name}`)
  const code = transpiler.transformSync(`const callback = ${property.initializer.getText(source)};`)
  return new Function(...Object.keys(dependencies), `${code};return callback`)(...Object.values(dependencies))
}

const T = Messages.MessageType
const ADDRESS = '0x' + '11'.repeat(20)
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const sleep = (ms = 2) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check() && Date.now() < end) await sleep()
  expect(check()).toBe(true)
}
class MemoryKeepKey implements TransportDelegate {
  readonly received: number[] = []
  private replies: Uint8Array[] = []
  holdSign = false
  onFeatures: (() => void) | undefined
  async isOpened() { return true }
  async getDeviceID() { return 'synthetic-a' }
  async connect() {}
  async disconnect() {}
  async tryConnectDebugLink() { return false }
  reply(type: number, message: { serializeBinary(): Uint8Array }) {
    const payload = message.serializeBinary(), frame = new Uint8Array(8 + payload.length)
    frame.set([35, 35, type >> 8, type & 255]); new DataView(frame.buffer).setUint32(4, payload.length); frame.set(payload, 8)
    for (let offset = 0; offset < frame.length; offset += 63) {
      const packet = new Uint8Array(64); packet[0] = 63; packet.set(frame.slice(offset, offset + 63), 1); this.replies.push(packet)
    }
  }
  finishSign() {
    const signature = new Ethereum.EthereumMessageSignature()
    signature.setAddress(new Uint8Array(20).fill(0x11)); signature.setSignature(new Uint8Array(65).fill(0x22))
    this.reply(T.MESSAGETYPE_ETHEREUMMESSAGESIGNATURE, signature)
  }
  async writeChunk(packet: Uint8Array) {
    const type = (packet[3] << 8) | packet[4]; this.received.push(type)
    if (type === T.MESSAGETYPE_GETFEATURES) {
      this.onFeatures?.()
      const features = new Messages.Features()
      features.setMajorVersion(7); features.setMinorVersion(17); features.setInitialized(true); features.setDeviceId('synthetic-a')
      this.reply(T.MESSAGETYPE_FEATURES, features)
    } else if (type === T.MESSAGETYPE_ETHEREUMSIGNMESSAGE && !this.holdSign) this.finishSign()
  }
  async readChunk() {
    for (;;) { const next = this.replies.shift(); if (next) return next; await sleep() }
  }
}

async function fixture() {
  const device = new MemoryKeepKey(), transport = await Transport.create(new core.Keyring(), device), wallet = create(transport)
  const engine = new EngineController()
  Object.assign(engine, { wallet, activeTransport: 'webusb', lastState: 'ready', seedEthAddress: 'seed-a',
    cachedFeatures: { initialized: true, deviceId: 'synthetic-a', majorVersion: 7, minorVersion: 17, patchVersion: 0 } })
  ;(engine as any).attachTransportListeners()
  const state = { enabled: true, epoch: 0, focus: 0, enrichment: null as Promise<void> | null, signEnrichment: null as Promise<void> | null, disconnect: null as Promise<void> | null }
  const decision = deferred<{ approved: boolean }>(), shown = deferred<void>(), pairShown = deferred<string>(), enriching = deferred<void>()
  const signing = deferred<void>()
  const disconnecting = deferred<void>()
  const cards: any[] = [], dismissed: string[] = [], paired: any[] = [], rejected: any[] = []
  const responses: any[] = [], listeners = new Map<string, (event: any) => void>()
  const sessions: Record<string, any> = Object.fromEntries(['topic-a', 'topic-b'].map(topic => [topic, {
    topic, expiry: Math.floor(Date.now() / 1000) + 3600,
    peer: { metadata: { name: topic, url: 'https://example.invalid', icons: [] } }, namespaces: { eip155: { chains: ['eip155:1'] } },
  }]))
  const getter = (enabled: boolean, epoch: number) => productionCallback('getWalletSession', { engine, walletConnectEnabled: enabled, activitySessionEpoch: epoch })()
  const runDeviceOperation = productionCallback('runDeviceOperation', { engine, deviceOperationContext })
  const ethSignMessage = productionCallback('ethSignMessage', { engine, isBitcoinOnlyVariant: () => false })
  const requestSigningApproval = productionCallback('requestSigningApproval', {
    deviceOperationContext, attachSigningPolicySnapshot() {}, attachSafeKnownAddresses() {},
    attachSafeCallPreviews: async () => { enriching.resolve(); if (state.enrichment) await state.enrichment }, attachSafeMessagePreimage: async () => {},
    rpc: { send: { 'signing-request': (info: any) => { cards.push(info); shown.resolve() } } },
    acquireWindowFocus: () => { state.focus++ }, releaseWindowFocus: () => { state.focus-- },
    requestSigningApprovalDecision: () => decision.promise,
  })
  const manager = new WalletConnectManager({
    getWalletSession: () => getter(state.enabled, state.epoch), runDeviceOperation,
    getEvmAddressInfo: () => ({ address: ADDRESS, addressIndex: 2 }),
    ensureEvmAddressInfo: async () => ({ address: ADDRESS, addressIndex: 2 }),
    ethSignMessage: async (params: any) => { signing.resolve(); if (state.signEnrichment) await state.signEnrichment; return ethSignMessage(params) }, requestSigningApproval,
    recordClearSignObservation: () => undefined, finalizeClearSignObservation() {}, dismissSigning: (id: string) => dismissed.push(id),
    onPairApprovalRequest: (info: any) => pairShown.resolve(info.id), onPairApprovalDismiss() {}, onSessionsChanged() {}, log() {},
  } as any)
  const start = () => (manager as any).handleRequest('personal_sign', ['0x6869', ADDRESS], 'eip155:1', 'Synthetic only') as Promise<string>
  const retire = async (field: string) => {
    if (field === 'wallet') (engine as any).wallet = create(transport)
    else if (field === 'deviceId') (engine as any).cachedFeatures.deviceId = 'synthetic-b'
    else if (field === 'seed') (engine as any).seedEthAddress = 'seed-b'
    else if (field === 'epoch') state.epoch++
    else if (field === 'hidden') (engine as any).hiddenWalletActive = true
    else if (field === 'disabled') state.enabled = false
    else if (field === 'destroy') await manager.destroy()
  }
  const setPairTransport = () => { (manager as any).web3wallet = {
    approveSession: async (value: any) => { paired.push(value) }, rejectSession: async (value: any) => { rejected.push(value) },
    getActiveSessions: () => ({}),
  } }
  const setSessionTransport = () => {
    ;(manager as any).web3wallet = {
      on: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      getActiveSessions: () => ({ ...sessions }),
      respondSessionRequest: async (value: any) => { responses.push(value) },
      disconnectSession: async ({ topic }: { topic: string }) => { disconnecting.resolve(); if (state.disconnect) await state.disconnect; delete sessions[topic] },
    }
    ;(manager as any).setupListeners()
  }
  const startTopic = (topic: string, id: number) => (manager as any).onSessionRequest({ topic, id, params: {
    chainId: 'eip155:1', request: { method: 'personal_sign', params: ['0x6869', ADDRESS] },
  } }) as Promise<void>
  return { manager, engine, device, wallet, state, decision, shown, pairShown, enriching, signing, disconnecting, cards, dismissed, paired, rejected,
    responses, listeners, sessions, start, startTopic, retire, setPairTransport, setSessionTransport }
}

describe('WalletConnect request/session ownership', () => {
  test.each(['wallet', 'deviceId', 'seed', 'locked'])('unverified initial %s cannot use a cached account to open an approval', async missing => {
    const f = await fixture()
    if (missing === 'wallet') f.engine.wallet = null
    else if (missing === 'deviceId') (f.engine as any).cachedFeatures.deviceId = undefined
    else if (missing === 'seed') (f.engine as any).seedEthAddress = null
    else (f.engine as any).lastState = 'needs_pin'
    f.decision.resolve({ approved: true }) // Drain a faulty old implementation without waiting for its stale card.
    const outcome = await f.start().then(value => value, error => error)
    expect(f.cards).toHaveLength(0)
    expect(f.device.received).toEqual([])
    expect(outcome).toMatchObject({ status: 409 })
    expect(outcome.message).toContain('unlock KeepKey')
  })

  test('a current approval signs through the production coordinator callback', async () => {
    const f = await fixture(), result = f.start()
    await f.shown.promise
    expect(f.device.received).toEqual([]) // No lease/PIN/device action while the host card waits.
    f.decision.resolve({ approved: true })
    expect(await result).toBe('0x' + '22'.repeat(65))
    expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES, T.MESSAGETYPE_ETHEREUMSIGNMESSAGE])
    expect(f.state.focus).toBe(0)
  })

  test.each(['wallet', 'deviceId', 'seed', 'epoch', 'hidden', 'disabled', 'destroy'])('%s retirement during approval prevents any sign write', async field => {
    const f = await fixture(), result = f.start().then(value => value, error => error)
    await f.shown.promise
    await f.retire(field)
    f.decision.resolve({ approved: true })
    const outcome = await result
    expect(f.device.received).toEqual([])
    expect(outcome).toMatchObject({ status: 409 })
    expect(f.state.focus).toBe(0)
    expect(f.dismissed).toEqual([f.cards[0].id])
  })

  test('hidden-to-standard transition with an unresolved identity retires the old approval', async () => {
    const f = await fixture()
    ;(f.engine as any).hiddenWalletActive = true
    const result = f.start().then(value => value, error => error)
    await f.shown.promise
    ;(f.engine as any).hiddenWalletActive = false
    ;(f.engine as any).seedEthAddress = null
    f.decision.resolve({ approved: true })
    const outcome = await result
    expect(f.device.received).toEqual([])
    expect(outcome).toMatchObject({ status: 409 })
    expect(f.dismissed).toEqual([f.cards[0].id])
  })

  test('a session change during actual production card enrichment cannot open or sign the stale card', async () => {
    const f = await fixture(), enrichment = deferred<void>()
    f.state.enrichment = enrichment.promise
    const result = f.start().then(value => value, error => error)
    await f.enriching.promise
    await f.retire('epoch'); f.decision.resolve({ approved: true }); enrichment.resolve()
    const outcome = await result
    expect(f.cards).toHaveLength(0)
    expect(f.device.received).toEqual([])
    expect(outcome).toMatchObject({ status: 409 })
    expect(f.state.focus).toBe(0)
  })

  test('another REST owner blocks WC signing instead of receiving a queued invisible job', async () => {
    const f = await fixture(), result = f.start().then(value => value, error => error)
    await f.shown.promise
    const release = await f.engine.acquireDeviceOperation()
    try {
      f.decision.resolve({ approved: true })
      const outcome = await result
      expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
      expect(outcome).toMatchObject({ status: 409 })
    } finally { release() }
    await sleep(5)
    expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
  })

  test('acquiring a current device lease cannot replace the older WC card session', async () => {
    const f = await fixture(), result = f.start().then(value => value, error => error)
    await f.shown.promise
    f.device.onFeatures = () => { f.state.epoch++ }
    f.decision.resolve({ approved: true })
    const outcome = await result
    expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
    expect(outcome).toMatchObject({ status: 409 })
  })

  test('session change during signing enrichment is fenced at the actual sign wire', async () => {
    const f = await fixture(), enrichment = deferred<void>()
    f.state.signEnrichment = enrichment.promise
    const result = f.start().then(value => value, error => error)
    await f.shown.promise; f.decision.resolve({ approved: true }); await f.signing.promise
    await f.retire('epoch'); enrichment.resolve()
    const outcome = await result
    expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
    expect(outcome).toMatchObject({ status: 409 })
  })

  test('a session change after dispatch still drains automatic acknowledgements and holds the device lease', async () => {
    const f = await fixture(); f.device.holdSign = true
    const result = f.start().then(value => value, error => error)
    await f.shown.promise; f.decision.resolve({ approved: true })
    await until(() => f.device.received.includes(T.MESSAGETYPE_ETHEREUMSIGNMESSAGE))
    await f.retire('epoch')
    let nextOwner = false
    const next = f.engine.acquireDeviceOperation().then(release => { nextOwner = true; release() })
    f.device.reply(T.MESSAGETYPE_BUTTONREQUEST, new Messages.ButtonRequest())
    await until(() => f.device.received.includes(T.MESSAGETYPE_BUTTONACK))
    expect(nextOwner).toBe(false)
    f.device.finishSign()
    expect(await result).toMatchObject({ status: 409 })
    await next
    expect(nextOwner).toBe(true)
    expect(f.device.received.filter(type => type === T.MESSAGETYPE_ETHEREUMSIGNMESSAGE)).toHaveLength(1)
  })

  test('pair approval cannot advertise accounts collected for the retired wallet', async () => {
    const f = await fixture(); f.setPairTransport()
    const pending = (f.manager as any).onSessionProposal({ id: 42, params: {
      requiredNamespaces: { eip155: { chains: ['eip155:1'], methods: ['personal_sign'], events: [] } }, optionalNamespaces: {},
      proposer: { metadata: { name: 'Synthetic only', url: 'https://example.invalid', icons: [] } },
    } })
    const id = await f.pairShown.promise
    await f.retire('epoch'); f.manager.approvePair(id)
    await pending
    expect(f.paired).toHaveLength(0)
    expect(f.rejected).toHaveLength(1)
    expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
  })

  test('disconnect intent retires one pending topic before remote SDK completion while another dApp remains valid', async () => {
    const f = await fixture(), remote = deferred<void>()
    f.setSessionTransport(); f.state.disconnect = remote.promise
    const first = f.startTopic('topic-a', 1)
    await f.shown.promise
    const disconnect = f.manager.disconnectSession('topic-a')
    await f.disconnecting.promise
    try {
      const other = f.startTopic('topic-b', 2)
      await until(() => f.cards.length === 2)
      f.decision.resolve({ approved: true })
      await Promise.all([first, other])
      expect(f.responses.find(value => value.response.id === 1).response.error.message).toContain('disconnected or expired')
      expect(f.responses.find(value => value.response.id === 2).response.result).toBe('0x' + '22'.repeat(65))
      expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES, T.MESSAGETYPE_ETHEREUMSIGNMESSAGE])
      // Even if the SDK still advertises it, the revoked cryptographic topic cannot be reused.
      await f.startTopic('topic-a', 3)
      expect(f.cards).toHaveLength(2)
      expect(f.responses.find(value => value.response.id === 3).response.error).toBeDefined()
    } finally { remote.resolve(); await disconnect }
  })

  test('disconnect during card enrichment cannot display or sign its old request', async () => {
    const f = await fixture(), enrichment = deferred<void>(), remote = deferred<void>()
    f.setSessionTransport(); f.state.enrichment = enrichment.promise; f.state.disconnect = remote.promise
    const request = f.startTopic('topic-a', 4)
    await f.enriching.promise
    const disconnect = f.manager.disconnectSession('topic-a')
    await f.disconnecting.promise
    try {
      f.decision.resolve({ approved: true }); enrichment.resolve(); await request
      expect(f.cards).toHaveLength(0)
      expect(f.device.received).toEqual([])
      expect(f.responses[0].response.error.message).toContain('disconnected or expired')
    } finally { remote.resolve(); await disconnect }
  })

  test('disconnect during acquired signing enrichment prevents its new sign exchange', async () => {
    const f = await fixture(), enrichment = deferred<void>(), remote = deferred<void>()
    f.setSessionTransport(); f.state.signEnrichment = enrichment.promise; f.state.disconnect = remote.promise
    const request = f.startTopic('topic-a', 5)
    await f.shown.promise; f.decision.resolve({ approved: true }); await f.signing.promise
    const disconnect = f.manager.disconnectSession('topic-a')
    await f.disconnecting.promise
    try {
      enrichment.resolve(); await request
      expect(f.device.received).toEqual([T.MESSAGETYPE_GETFEATURES])
      expect(f.responses[0].response.error.message).toContain('disconnected or expired')
    } finally { remote.resolve(); await disconnect }
  })

  test('SDK session_delete retires an open approval even before its session cache is removed', async () => {
    const f = await fixture(); f.setSessionTransport()
    const request = f.startTopic('topic-a', 6)
    await f.shown.promise
    f.listeners.get('session_delete')!({ topic: 'topic-a', id: 6 })
    f.decision.resolve({ approved: true }); await request
    expect(f.device.received).toEqual([])
    expect(f.responses[0].response.error.message).toContain('disconnected or expired')
  })

  test('expiry retires the pending topic and cannot be undone by stale SDK cache data', async () => {
    const f = await fixture(); f.setSessionTransport()
    const request = f.startTopic('topic-a', 7)
    await f.shown.promise
    f.sessions['topic-a'].expiry = Math.floor(Date.now() / 1000) - 1
    f.decision.resolve({ approved: true }); await request
    expect(f.device.received).toEqual([])
    expect(f.responses[0].response.error.message).toContain('disconnected or expired')
    f.sessions['topic-a'].expiry = Math.floor(Date.now() / 1000) + 3600
    await f.startTopic('topic-a', 8)
    expect(f.cards).toHaveLength(1)
    expect(f.responses[1].response.error).toBeDefined()
  })
})
