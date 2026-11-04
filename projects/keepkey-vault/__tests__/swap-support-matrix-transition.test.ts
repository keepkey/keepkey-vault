import { afterEach, beforeEach, expect, test } from 'bun:test'
import { assessAvailability, loadSupportedChains, _resetDynamicChains } from '../src/shared/swap-support-matrix'

const originalFetch = globalThis.fetch
const chain = 'eip155:9000001'
const asset = `${chain}/slip44:60`
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}
const coverage = (provider: string) => Response.json({ [provider]: [chain] })
beforeEach(() => _resetDynamicChains())
afterEach(() => { globalThis.fetch = originalFetch; _resetDynamicChains() })

test('late coverage from the previous server cannot replace the selected server catalog', async () => {
  const oldResponse = deferred<Response>()
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).startsWith('https://old.example/') ? oldResponse.promise : coverage('relay')) as typeof fetch
  const previous = loadSupportedChains('https://old.example')
  await loadSupportedChains('https://selected.example')
  expect(assessAvailability(asset).providers).toEqual(['relay'])
  oldResponse.resolve(coverage('thorchain')); await previous
  expect(assessAvailability(asset).providers).toEqual(['relay'])
})

test('an unavailable selected server cannot be silently replaced by a previous server response', async () => {
  const oldResponse = deferred<Response>()
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).startsWith('https://old.example/') ? oldResponse.promise : new Response('{}', { status: 503 })) as typeof fetch
  const previous = loadSupportedChains('https://old.example')
  await loadSupportedChains('https://selected.example')
  expect(assessAvailability(asset).status).toBe('unsupported_chain')
  oldResponse.resolve(coverage('relay')); await previous
  expect(assessAvailability(asset).status).toBe('unsupported_chain')
})
