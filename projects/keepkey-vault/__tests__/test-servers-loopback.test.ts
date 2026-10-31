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
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-test-servers-loopback-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const { startRestApi, restApiLoopbackHosts } = await import('../src/bun/rest-api')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const LOOPBACK = '127.0.0.1'

/** `app` starts it the way Desktop does: no hostname. */
function restServer(port: number, app = false) {
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, currentSeedEthAddress: null, wallet: {},
    getDeviceState: () => ({ state: 'disconnected' }), getCachedFeaturesSnapshot: () => undefined,
  })
  const auth: any = { requireAuth: () => { throw new Error('no auth here') }, extractBearerToken: () => undefined, validate: () => false }
  return startRestApi(engine, auth, port, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => ({ approved: false }) as any, onSigningDismissed: () => {},
  } as any, ...(app ? [] : [LOOPBACK]))
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
      expect(server.hostnames).toEqual([LOOPBACK])
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

/** Another process holding `host`:`port` (0 = any free port), the way a local
 *  program would squat on Desktop's port. Resolves null if it could not bind. */
async function otherProcessHolds(host: string, port = 0) {
  const script = `try { const s = Bun.serve({ hostname: ${JSON.stringify(host)}, port: ${port}, fetch: () => new Response('impostor') }); console.log(s.port) } catch { console.log('refused'); process.exit(0) }; setInterval(() => {}, 1000)`
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' })
  const reader = child.stdout.getReader()
  let out = ''
  while (!out.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const line = out.trim()
  if (!/^\d+$/.test(line)) { child.kill(); return null }
  return { port: Number(line), stop: () => child.kill() }
}

async function answers(url: string): Promise<string | null> {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(3000) })).text() } catch { return null }
}

const hasIpv6Loopback = restApiLoopbackHosts().includes('::1')
const lanAddress = Object.values(networkInterfaces()).flat()
  .find(a => a && !a.internal && a.family === 'IPv4')?.address

describe('Desktop REST API listens on loopback only', () => {
  test('binds 127.0.0.1 and ::1 (where the host has it), never the wildcard', () => {
    const server = restServer(0, true)
    try {
      expect(server.hostnames).toEqual(hasIpv6Loopback ? ['127.0.0.1', '::1'] : ['127.0.0.1'])
    } finally { server.stop(true) }
  })

  test('a port another process holds on 127.0.0.1 makes it refuse to start', async () => {
    const other = await otherProcessHolds('127.0.0.1')
    expect(other).not.toBeNull()
    try {
      expect(() => restServer(other!.port, true)).toThrow(/already in use by another program/)
      expect(await answers(`http://127.0.0.1:${other!.port}/`)).toBe('impostor')
      if (hasIpv6Loopback) expect(await answers(`http://[::1]:${other!.port}/api/v1/health/fast`)).toBeNull()
    } finally { other!.stop() }
  })

  test.skipIf(!hasIpv6Loopback)('a port another process holds on ::1 makes it refuse to start, and it lets 127.0.0.1 go', async () => {
    const other = await otherProcessHolds('::1')
    expect(other).not.toBeNull()
    try {
      expect(() => restServer(other!.port, true)).toThrow(/already in use by another program/)
      expect(await answers(`http://[::1]:${other!.port}/`)).toBe('impostor')
      expect(await answers(`http://127.0.0.1:${other!.port}/api/v1/health/fast`)).toBeNull()
    } finally { other!.stop() }
  })

  test('localhost, 127.0.0.1 and ::1 all reach it, and no other process can take them after it starts', async () => {
    const server = restServer(0, true)
    try {
      const urls = ['localhost', '127.0.0.1', ...(hasIpv6Loopback ? ['[::1]'] : [])]
      for (const host of urls) {
        const body = await answers(`http://${host}:${server.port}/api/v1/health/fast`)
        expect(body && JSON.parse(body)).toMatchObject({ status: 'ok' })
      }
      for (const host of server.hostnames) {
        const squatter = await otherProcessHolds(host, server.port)
        squatter?.stop()
        expect(squatter).toBeNull()
      }
    } finally { server.stop(true) }
  })

  test.skipIf(!lanAddress)('a LAN address does not reach it', async () => {
    const server = restServer(0, true)
    try {
      expect(await answers(`http://${lanAddress}:${server.port}/api/v1/health/fast`)).toBeNull()
    } finally { server.stop(true) }
  })
})
