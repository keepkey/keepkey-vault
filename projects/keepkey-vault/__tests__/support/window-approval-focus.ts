/** Production approval callbacks/router, without GUI, sockets or saved profile. */
import { mock } from 'bun:test'
import ts from 'typescript'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'vault-window-focus-'))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: profile } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: profile } }))
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: class {} }))
mock.module('usb', () => ({ usb: Object.assign(new EventEmitter(), { getDeviceList: () => [] }) }))
mock.module('node-hid', () => ({ devices: () => [], HID: class {} }))
// The router imports USB metadata helpers even though these cases use a fake
// engine. Never initialize a native addon's callbacks in this isolated child.
process.dlopen = (() => { throw new Error('Native addons are forbidden in the focus fixture') }) as typeof process.dlopen
globalThis.fetch = (() => { throw new Error('Network requests are forbidden in the focus fixture') }) as typeof fetch
const db = await import('../../src/bun/db')
const { AuthStore } = await import('../../src/bun/auth')
const { startRestApi } = await import('../../src/bun/rest-api')
db.initDb()

const source = ts.createSourceFile('index.ts', readFileSync(process.env.WINDOW_APPROVAL_FOCUS_SOURCE || new URL('../../src/bun/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
function collect<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node) => { if (matches(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return found
}
function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`Production focus fixture cannot find ${label}`)
  return value
}
const namedFunction = (name: string) => required(source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name), name) as ts.FunctionDeclaration
const variable = (name: string) => required(collect(source, ts.isVariableDeclaration).find(node => ts.isIdentifier(node.name) && node.name.text === name), name)
const rest = required(variable('restCallbacks').initializer, 'REST callbacks') as ts.ObjectLiteralExpression
const wc = required(collect(namedFunction('getOrCreateWcManager'), ts.isNewExpression).find(node => node.expression.getText(source) === 'WalletConnectManager')?.arguments?.[0], 'WalletConnect callbacks') as ts.ObjectLiteralExpression
const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(source) === name) as ts.PropertyAssignment | undefined
const rpcProperty = (name: string) => collect(source, ts.isPropertyAssignment).find(node => node.name.getText(source) === name)
const expression = (node: ts.Node) => node.getText(source)
const callbackObject = (object: ts.ObjectLiteralExpression, names: string[]) => `{${names.flatMap(name => {
  const node = property(object, name)
  return node ? [expression(node)] : []
}).join(',')}}`

// Ownership is a source-level boundary as well as a runtime invariant: no
// startup, PIN/state event, arbitrary RPC or device-read handler can opt in.
const allowedOwners = new Set(['onSigningRequest', 'requestSigningApproval', 'onPairRequest', 'onPairApprovalRequest'])
const approvalOwners = collect(source, ts.isCallExpression).flatMap(call => {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'acquireWindowFocus') return []
  let owner: ts.Node | undefined = call.parent
  while (owner && !ts.isPropertyAssignment(owner)) owner = owner.parent
  const name = owner && ts.isPropertyAssignment(owner) ? owner.name.getText(source) : '<startup>'
  return allowedOwners.has(name) ? [] : [name]
})
for (const call of collect(source, ts.isCallExpression)) {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'setAlwaysOnTop' || call.arguments[0]?.kind !== ts.SyntaxKind.TrueKeyword) continue
  let owner: ts.Node | undefined = call.parent
  while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
  if (!owner || !ts.isFunctionDeclaration(owner) || owner.name?.text !== 'acquireWindowFocus') approvalOwners.push('<direct elevation>')
}

const timers = new Map<ReturnType<typeof setTimeout>, { ms: number; fire: () => void }>()
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
  const timer = realSetTimeout(callback, ms, ...args)
  if (ms === 600_000 || ms === 900_000) timers.set(timer, { ms, fire: () => callback(...args) })
  return timer
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); realClearTimeout(timer) }) as typeof clearTimeout
function expireApproval(ms: number) {
  const entry = required([...timers.entries()].find(([, timer]) => timer.ms === ms), `pending ${ms}ms approval timer`)
  realClearTimeout(entry[0]); timers.delete(entry[0]); entry[1].fire()
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  const end = performance.now() + 2000
  while (!predicate() && performance.now() < end) await Bun.sleep(1)
  if (!predicate()) throw new Error('Synthetic approval did not reach its pending state')
}

const transpiler = new Bun.Transpiler({ loader: 'ts' })
const focusFunctions = ['_emitWindowFocusChanged', 'acquireWindowFocus', 'releaseWindowFocus', 'requestSigningApprovalDecision'].map(name => expression(namedFunction(name))).join('\n')
const windowInitializer = expression(required(variable('mainWindow').initializer, 'window constructor'))
const unlockCallback = expression(required(rpcProperty('requestDeviceUnlock')?.initializer, 'unlock RPC'))
const restCallbackNames = ['onDeviceRequest', 'onSigningRequest', 'onSigningDismissed', 'onPairRequest', 'onPairDismissed']
const code = transpiler.transformSync(`
  const {mainWindow, rpc, auth, engine, BrowserWindow, pkg, url, attachSigningPolicySnapshot,
    attachSafeKnownAddresses, attachSafeCallPreviews, attachSafeMessagePreimage, reviewTapeRecording, recordReviewCard, deviceOperationContext} = dependencies;
  let _alwaysOnTopRefs = 0;
  const blindSigningApprovalIds = new Set();
  const pendingSigningApprovalInfo = new Map();
  ${focusFunctions}
  return {
    rest: ${callbackObject(rest, restCallbackNames)},
    wc: ${callbackObject(wc, ['requestSigningApproval', 'onPairApprovalRequest', 'onPairApprovalDismiss'])},
    unlock: ${unlockCallback},
    launch: () => ${windowInitializer},
    state: () => ({refs: _alwaysOnTopRefs, alwaysOnTop: _alwaysOnTopRefs > 0}),
  };
`)
const createCallbacks = new Function('dependencies', code)
let sequence = 0
function harness() {
  const auth = new AuthStore()
  const calls: Array<boolean | string> = []
  const events: string[] = []
  const unlock = deferred()
  const device = { locked: true, acquisitions: 0 }
  const address = '0x0000000000000000000000000000000000000001'
  const wallet = { getFeatures: async () => ({ deviceId: 'focus-fixture', initialized: true, majorVersion: 7, minorVersion: 17, patchVersion: 0, pinProtection: true, pinCached: !device.locked }), ethGetAddress: async () => address }
  const engine: any = Object.assign(new EventEmitter(), {
    wallet, isEmulator: false, isPassphraseWallet: false, isSyncing: false, wipeInProgress: false, wipeOnReconnect: false, currentSeedEthAddress: address,
    requestDeviceUnlock: () => unlock.promise,
    acquireDeviceOperation: async () => { device.acquisitions++; await unlock.promise; return () => {} },
    getDeviceState: () => ({ state: device.locked ? 'needs_pin' : 'ready', deviceId: 'focus-fixture', firmwareVersion: '7.17.0', capabilities: [] }),
  })
  Object.defineProperty(engine, 'isLocked', { get: () => device.locked })
  const dependencies = {
    auth, engine, mainWindow: { setAlwaysOnTop: (value: boolean) => calls.push(value), focus: () => calls.push('focus') },
    rpc: { send: new Proxy({}, { get: (_target, name: string) => () => { events.push(name) } }) },
    BrowserWindow: class { options: any; constructor(options: any) { this.options = options } }, pkg: { version: 'synthetic' }, url: 'about:blank',
    attachSigningPolicySnapshot() {}, attachSafeKnownAddresses() {}, attachSafeCallPreviews: async () => {}, attachSafeMessagePreimage: async () => {},
    reviewTapeRecording: () => false, recordReviewCard() { throw new Error('A real-device callback cannot record a tape') },
    deviceOperationContext: { getStore: () => undefined },
  }
  const callbacks = createCallbacks(dependencies)
  let server: ReturnType<typeof startRestApi> | undefined
  let handleRequest: ((request: Request, server: typeof requestServer) => Response | Promise<Response>) | undefined
  // startRestApi receives the same server surface used by these routes, but
  // no native listener is created. macOS CI hit a native Bun crash in the HTTP
  // fixture; its exact cause is unproven. rest-demand-unlock.test.ts separately
  // exercises real HTTP routing.
  const requestServer = {
    hostname: '127.0.0.1', port: 0,
    timeout(_request: Request, _seconds: number) {},
    requestIP: (_request: Request) => ({ address: '127.0.0.1', family: 'IPv4', port: 0 }),
    upgrade() { throw new Error('WebSocket upgrade is outside the focus fixture') },
    stop() {},
  }
  const pendingRequests = new Set<Promise<{ status: number; body: string }>>()
  const apiKey = auth.pair({ name: `focus-fixture-${++sequence}`, url: 'https://focus.example.invalid', imageUrl: '' })
  const request = (route: string, body?: unknown, access?: string) => {
    if (!server) {
      // Capture the actual production router only during synchronous creation;
      // the production auth, request scopes, lease and approval paths run below.
      const serve = Bun.serve
      Bun.serve = ((options: any) => {
        if (handleRequest) throw new Error('Unexpected second focus-fixture listener')
        handleRequest = required(options.fetch, 'production REST fetch router')
        return requestServer
      }) as typeof Bun.serve
      try {
        server = startRestApi(engine, auth, 0, { ...callbacks.rest, onApiLog() {}, getVersion: () => 'synthetic', getSessionEpoch: () => 0 } as any, '127.0.0.1')
      } finally { Bun.serve = serve }
    }
    const pending = (async () => {
      const input = new Request(`http://window-focus.invalid${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(access ? { 'X-KeepKey-Device-Access': access } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const response = await required(handleRequest, 'production REST fetch router')(input, requestServer)
      return { status: response.status, body: await response.text() }
    })()
    pendingRequests.add(pending)
    void pending.then(() => pendingRequests.delete(pending), () => pendingRequests.delete(pending))
    return pending
  }
  const stop = async () => {
    // A failed assertion while pairing is pending must still let its router
    // handler finish before the fixture closes its isolated SQLite profile.
    auth.rejectPairing()
    device.locked = false
    unlock.resolve()
    await Promise.allSettled([...pendingRequests])
    server?.stop()
    server = undefined
    handleRequest = undefined
  }
  return { auth, callbacks, calls, events, device, request, unlock: () => { device.locked = false; unlock.resolve() }, stop }
}
const info = (id: string) => ({ id, method: '/eth/sign', address: 'synthetic', message: 'synthetic' })
const pairInfo = () => ({ name: `Approval ${++sequence}`, url: 'https://approval.example.invalid', imageUrl: '' })
const results: Record<string, unknown> = { approvalOwners, manualOverride: !!rpcProperty('setWindowAlwaysOnTop') }

try {
  {
    const h = harness()
    const window = h.callbacks.launch()
    results.launch = { elevated: window.options.alwaysOnTop === true, calls: h.calls }
  }
  {
    const h = harness()
    const request = h.callbacks.unlock()
    await Bun.sleep(1)
    const pending = h.callbacks.state()
    h.unlock(); await request
    results.pin = { pending, done: h.callbacks.state(), calls: h.calls }
  }
  {
    const h = harness()
    try {
      const health = (await h.request('/api/health')).status
      const body = { address_n: [0x8000002c, 0x8000003c, 0x80000000, 0, 0] }
      const cacheMiss = (await h.request('/addresses/eth', body, 'cached')).status
      const cacheLeases = h.device.acquisitions
      const request = h.request('/addresses/eth', body, 'foreground')
      await until(() => h.device.acquisitions === 1)
      const pending = h.callbacks.state()
      h.unlock()
      const foreground = (await request).status
      results.reads = { health, cacheMiss, cacheLeases, pending, foreground, foregroundLeases: h.device.acquisitions, calls: h.calls }
    } finally { await h.stop() }
  }
  for (const outcome of ['approve', 'reject', 'abort', 'timeout']) {
    const h = harness(), abort = new AbortController(), id = `sign-${outcome}`
    const request = h.callbacks.rest.onSigningRequest(info(id), abort.signal)
    await until(() => h.callbacks.state().refs === 1)
    const pending = h.callbacks.state()
    if (outcome === 'approve') h.auth.approveSigningRequest(id)
    else if (outcome === 'reject') h.auth.rejectSigningRequest(id)
    else if (outcome === 'abort') abort.abort()
    else expireApproval(900_000)
    const decision = await request
    results[id] = { pending, approved: decision.approved, done: h.callbacks.state(), calls: h.calls }
  }
  for (const outcome of ['approve', 'reject', 'timeout']) {
    const h = harness()
    try {
      const request = h.request('/auth/pair', pairInfo())
      await until(() => h.auth.getPendingPair() !== null)
      const pending = h.callbacks.state()
      if (outcome === 'approve') h.auth.approvePairing()
      else if (outcome === 'reject') h.auth.rejectPairing()
      else expireApproval(600_000)
      results[`pair-${outcome}`] = { pending, status: (await request).status, done: h.callbacks.state(), calls: h.calls }
    } finally { await h.stop() }
  }
  {
    const h = harness()
    try {
      const sign = h.callbacks.rest.onSigningRequest(info('overlap'))
      await until(() => h.callbacks.state().refs === 1)
      const pair = h.request('/auth/pair', pairInfo())
      await until(() => h.auth.getPendingPair() !== null)
      const both = h.callbacks.state()
      h.auth.approveSigningRequest('overlap'); await sign
      const afterSign = h.callbacks.state()
      h.auth.rejectPairing(); await pair
      results.overlap = { both, afterSign, done: h.callbacks.state(), calls: h.calls }
    } finally { await h.stop() }
  }
  {
    const h = harness()
    const sign = h.callbacks.wc.requestSigningApproval(info('wc-sign'))
    await until(() => h.callbacks.state().refs === 1)
    h.callbacks.wc.onPairApprovalRequest({ id: 'wc-pair' })
    const both = h.callbacks.state()
    h.callbacks.wc.onPairApprovalDismiss('wc-pair')
    const afterPair = h.callbacks.state()
    h.auth.rejectSigningRequest('wc-sign')
    const approved = await sign
    results.walletConnect = { both, afterPair, approved, done: h.callbacks.state(), calls: h.calls }
  }
} finally {
  for (const timer of timers.keys()) realClearTimeout(timer)
  globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout
  db.closeDb(); rmSync(profile, { recursive: true, force: true })
}
console.log(JSON.stringify(results))
