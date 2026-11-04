// Run in its own Bun command: DB/SDK module doubles must not affect other suites.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
let selectedBase = 'https://api.keepkey.info'
let initializers: Array<Promise<any>> = []
let registrationResults: Array<Promise<Response>> = []
let sdkCalls: Array<{ spec: string; config: any }> = []
let registrationCalls: string[] = []
const previousFetch = globalThis.fetch

mock.module('../src/bun/db', () => ({
  getSetting: (key: string) => key === 'pioneer_api_base' ? selectedBase : key === 'pioneer_query_key' ? 'test-query-key-for-isolated-transitions' : null,
  setSetting: () => {},
}))
mock.module('@pioneer-platform/pioneer-client', () => ({ default: class {
  client = { spec: { paths: {} } }
  private result: Promise<any>
  constructor(spec: string, config: any) {
    sdkCalls.push({ spec, config })
    this.result = initializers.shift() || Promise.resolve({ name: 'default' })
  }
  init() { return this.result }
} }))
mock.module('../src/bun/perf-telemetry', () => ({ instrumentPortfolio: () => {} }))
mock.module('../src/bun/pioneer-guard', () => ({ installPioneerGuard: () => {} }))
const pioneer = await import('../src/bun/pioneer')
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (!url.endsWith('/api/v1/user/register')) throw new Error('Unexpected request in isolated test')
  registrationCalls.push(url)
  return await (registrationResults.shift() || Promise.resolve(new Response('{}', { status: 200 })))
}) as typeof fetch

beforeEach(() => {
  selectedBase = 'https://api.keepkey.info'
  initializers = []; registrationResults = []; sdkCalls = []; registrationCalls = []
  pioneer.resetPioneer(); pioneer.setPioneerOffline(false)
})
afterAll(() => { globalThis.fetch = previousFetch; mock.restore() })
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await Bun.sleep(1) }
  throw new Error('Expected asynchronous transition did not occur')
}

test('the runtime URL resolver ignores environment overrides', () => {
  const previous = process.env.PIONEER_API_BASE
  process.env.PIONEER_API_BASE = 'https://hidden-override.example'
  try {
    selectedBase = ''
    expect(pioneer.getPioneerApiBase()).toBe('https://api.keepkey.info')
    selectedBase = 'https://selected.example/'
    expect(pioneer.getPioneerApiBase()).toBe('https://selected.example')
  } finally {
    if (previous === undefined) delete process.env.PIONEER_API_BASE
    else process.env.PIONEER_API_BASE = previous
  }
})

test('an old initialization cannot replace the selected server after reset', async () => {
  const oldInit = deferred<any>(), newClient = { name: 'new-server' }
  initializers.push(oldInit.promise)
  const old = pioneer.getPioneer().then(value => ({ value }), error => ({ error }))
  await until(() => sdkCalls.length === 1)
  selectedBase = 'https://selected.example'; pioneer.resetPioneer(); initializers.push(Promise.resolve(newClient))
  expect(await pioneer.getPioneer()).toBe(newClient)
  oldInit.resolve({ name: 'old-server' })
  expect((await old as any).error.message).toContain('server changed')
  expect(await pioneer.getPioneer()).toBe(newClient)
  expect(registrationCalls).toEqual(['https://selected.example/api/v1/user/register'])
  expect(sdkCalls[1].config.overrideHost).toBe('selected.example')
})

test('callers cannot obtain the singleton before its registration settles', async () => {
  const registration = deferred<Response>(), client = { name: 'registered-client' }
  initializers.push(Promise.resolve(client)); registrationResults.push(registration.promise)
  let settled = false
  const first = pioneer.getPioneer().then(value => { settled = true; return value })
  await until(() => registrationCalls.length === 1)
  const second = pioneer.getPioneer()
  await Bun.sleep(2)
  expect(settled).toBe(false); expect(sdkCalls).toHaveLength(1)
  registration.resolve(new Response('{}', { status: 200 }))
  expect(await first).toBe(client); expect(await second).toBe(client)
  expect(sdkCalls[0].config.overrideHost).toBe('api.keepkey.info')
})

test('an obsolete initialization failure cannot clear a newer pending initialization', async () => {
  const oldInit = deferred<any>(), newInit = deferred<any>(), client = { name: 'new-server' }
  initializers.push(oldInit.promise)
  const old = pioneer.getPioneer().then(value => ({ value }), error => ({ error }))
  await until(() => sdkCalls.length === 1)
  selectedBase = 'https://selected.example'; pioneer.resetPioneer(); initializers.push(newInit.promise)
  const current = pioneer.getPioneer()
  await until(() => sdkCalls.length === 2)
  oldInit.resolve({ name: 'old-server' })
  expect((await old as any).error.message).toContain('server changed')
  const shared = pioneer.getPioneer()
  await Bun.sleep(2); expect(sdkCalls).toHaveLength(2)
  newInit.resolve(client)
  expect(await current).toBe(client); expect(await shared).toBe(client)
})

test('an old registration cannot complete or clear the new server registration attempt', async () => {
  const oldRegistration = deferred<Response>(), newRegistration = deferred<Response>()
  registrationResults.push(oldRegistration.promise)
  const old = pioneer.ensurePioneerQueryKeyRegistered()
  await until(() => registrationCalls.length === 1)
  selectedBase = 'https://selected.example'; pioneer.resetPioneer()
  registrationResults.push(newRegistration.promise)
  const current = pioneer.ensurePioneerQueryKeyRegistered()
  await until(() => registrationCalls.length === 2)
  oldRegistration.resolve(new Response('{}', { status: 200 }))
  expect(await old).toBe(false)
  const shared = pioneer.ensurePioneerQueryKeyRegistered()
  await Bun.sleep(2); expect(registrationCalls).toHaveLength(2)
  newRegistration.resolve(new Response('{}', { status: 200 }))
  expect(await current).toBe(true); expect(await shared).toBe(true)
  expect(await pioneer.ensurePioneerQueryKeyRegistered()).toBe(true)
  expect(registrationCalls).toHaveLength(2)
})

test('initialization waiting on old registration cannot publish after switching', async () => {
  const oldRegistration = deferred<Response>(), newClient = { name: 'new-server' }
  initializers.push(Promise.resolve({ name: 'old-server' })); registrationResults.push(oldRegistration.promise)
  const old = pioneer.getPioneer().then(value => ({ value }), error => ({ error }))
  await until(() => registrationCalls.length === 1)
  selectedBase = 'https://selected.example'; pioneer.resetPioneer(); initializers.push(Promise.resolve(newClient))
  expect(await pioneer.getPioneer()).toBe(newClient)
  oldRegistration.resolve(new Response('{}', { status: 200 }))
  expect((await old as any).error.message).toContain('server changed')
  expect(await pioneer.getPioneer()).toBe(newClient)
})

test('a retained old SDK object cannot issue new operations after a server change', async () => {
  let calls = 0
  const client = { GetPortfolioBalances: async () => { calls++; return { data: {} } } }
  initializers.push(Promise.resolve(client))
  const returned = await pioneer.getPioneer()
  expect(returned).toBe(client)
  selectedBase = 'https://selected.example'; pioneer.resetPioneer()
  await expect(returned.GetPortfolioBalances({})).rejects.toThrow('server changed')
  expect(calls).toBe(0)
})

test('an old in-flight operation cannot return data after switching servers', async () => {
  const result = deferred<any>(); let calls = 0
  const client = { GetPortfolioBalances: async () => { calls++; return result.promise } }
  initializers.push(Promise.resolve(client))
  const returned = await pioneer.getPioneer()
  const pending = returned.GetPortfolioBalances({}).then((value: any) => ({ value }), (error: Error) => ({ error }))
  expect(calls).toBe(1)
  selectedBase = 'https://selected.example'; pioneer.resetPioneer()
  result.resolve({ data: { obsolete: true } })
  expect((await pending as any).error.message).toContain('server changed')
})
