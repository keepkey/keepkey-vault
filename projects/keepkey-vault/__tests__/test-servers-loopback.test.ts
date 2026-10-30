/**
 * Test servers bind 127.0.0.1, the address the tests call. A port-0 server on
 * the wildcard address can be given a port another process already holds on
 * 127.0.0.1 (macOS allows both binds); that process then answers the test's
 * request. In `make test-unit` this showed up as random failures that pass
 * alone: a REST observation row missing, an ERC-7730 observation left as the
 * previous test's.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-test-servers-loopback-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const { startRestApi } = await import('../src/bun/rest-api')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const LOOPBACK = '127.0.0.1'

function restServer(port: number) {
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, currentSeedEthAddress: null, wallet: {},
    getDeviceState: () => ({ state: 'disconnected' }), getCachedFeaturesSnapshot: () => undefined,
  })
  const auth: any = { requireAuth: () => { throw new Error('no auth here') }, extractBearerToken: () => undefined, validate: () => false }
  return startRestApi(engine, auth, port, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => ({ approved: false }) as any, onSigningDismissed: () => {},
  } as any, LOOPBACK)
}

/** The text of the call starting at `at`, through its closing parenthesis. */
function callText(src: string, at: number): string {
  let depth = 0
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced call at ${at}`)
}

describe('test servers listen where the tests call them', () => {
  test('the REST API binds the address it is given', async () => {
    const server = restServer(0)
    try {
      expect(server.hostname).toBe(LOOPBACK)
      const res = await fetch(`http://${LOOPBACK}:${server.port}/api/v1/health/fast`)
      expect(await res.json()).toMatchObject({ status: 'ok' })
    } finally { server.stop(true) }
  })

  test('a port another listener holds on 127.0.0.1 is refused, never shared', () => {
    // On the wildcard address macOS accepts this bind, and the other listener
    // keeps answering every request sent to 127.0.0.1.
    const other = Bun.serve({ hostname: LOOPBACK, port: 0, fetch: () => new Response('another process') })
    try {
      expect(() => restServer(other.port)).toThrow()
    } finally { other.stop(true) }
  })

  test('every test that starts a server binds it to 127.0.0.1', () => {
    const root = join(import.meta.dir, '..')
    const self = 'test-servers-loopback.test.ts'
    const unbound: string[] = []
    let calls = 0
    for (const file of new Bun.Glob('{__tests__,src}/**/*.test.ts').scanSync({ cwd: root })) {
      if (file.endsWith(self)) continue
      const src = readFileSync(join(root, file), 'utf8')
      for (const m of src.matchAll(/\bstartRestApi\(|\bBun\.serve\(/g)) {
        calls++
        const call = callText(src, m.index!)
        const bound = m[0].startsWith('startRestApi')
          ? call.replace(/\s+/g, '').endsWith(`,'${LOOPBACK}')`)
          : call.includes(`hostname: '${LOOPBACK}'`)
        if (!bound) unbound.push(`${file}: ${call.slice(0, 60).replace(/\s+/g, ' ')}`)
      }
    }
    expect(calls).toBeGreaterThan(0) // the scan is not empty
    expect(unbound).toEqual([])
  })
})
