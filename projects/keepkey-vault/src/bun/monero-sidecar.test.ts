import { afterEach, describe, expect, test } from 'bun:test'
import { createMoneroSidecarManager } from './monero-sidecar'
import { MAX_IPC_LINE, MONERO_VERSION, SIDECAR_VERSION, atomic, parseExactJson, validateConfiguration, validateWalletStatus } from '../../monero-cli/src/protocol'
import { DigestWalletRpc, parseDigest } from '../../monero-cli/src/digest'

const ADDRESS = '4' + '1'.repeat(94)
const VIEW = '12'.repeat(32)
const config = { walletId: 'device:' + ADDRESS, network: 'mainnet' as const, address: ADDRESS,
  viewKey: VIEW, restoreHeight: 3000000, daemonUrl: 'https://node.example' }
const status = { network: 'mainnet' as const, address: ADDRESS, balanceAtomic: '18446744073709551615',
  unlockedBalanceAtomic: '84653050000', walletHeight: 3799260, transactions: [], monitorReady: true,
  updatedAt: new Date().toISOString(), canSend: false as const }

function fakeWorker(options: { ready?: boolean; version?: string; hang?: string; response?: any } = {}) {
  let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>
  let resolveExit!: (code: number) => void, ended = false
  const encoder = new TextEncoder(), requests: any[] = [], kills: any[] = []
  const send = (value: unknown) => { if (!ended) stdout.enqueue(encoder.encode(JSON.stringify(value) + '\n')) }
  const exit = () => { if (ended) return; ended = true; stdout.close(); stderr.close(); resolveExit(0) }
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller } }),
    exited: new Promise<number>(resolve => { resolveExit = resolve }),
    stdin: { write(value: string) {
      const request = JSON.parse(value); requests.push(request)
      if (request.cmd === 'quit') return
      if (request.cmd !== options.hang) queueMicrotask(() => send({ ok: true, _req_id: request._req_id, result: options.response ?? status }))
    }, flush() {} },
    kill(signal?: any) { kills.push(signal); exit() },
  }
  queueMicrotask(() => { if (options.ready !== false) send({ ok: true, ready: true, version: options.version ?? SIDECAR_VERSION, binaryVersion: MONERO_VERSION }) })
  return { proc, send, exit, requests, kills, bytes(value: string) { stdout.enqueue(encoder.encode(value)) } }
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const clean of cleanups.splice(0)) clean() })
function manager(worker: ReturnType<typeof fakeWorker>, overrides = {}) {
  const result = createMoneroSidecarManager({ spawn: () => worker.proc, startupTimeoutMs: 50, requestTimeoutMs: 40, ...overrides })
  cleanups.push(() => { result.stop(); worker.exit() })
  return result
}

describe('managed Monero sidecar boundary', () => {
  test('startup is deduplicated and ready does not require watch credentials', async () => {
    const worker = fakeWorker(); let spawns = 0
    const sidecar = manager(worker, { spawn: () => { spawns++; return worker.proc } })
    await Promise.all([sidecar.start(), sidecar.start(), sidecar.start()])
    expect(spawns).toBe(1)
    expect(sidecar.status()).toEqual({ state: 'ready', configured: false, version: SIDECAR_VERSION, binaryVersion: MONERO_VERSION })
    expect(worker.requests).toHaveLength(0)
  })

  test('configure passes view bytes only through private IPC and returns public status', async () => {
    const worker = fakeWorker(), sidecar = manager(worker)
    const result = await sidecar.configureWatch({ ...config, viewKey: new Uint8Array(Buffer.from(VIEW, 'hex')) })
    expect(worker.requests[0].cmd).toBe('configure_watch')
    expect(worker.requests[0].params.viewKey).toBe(VIEW)
    expect(result.balanceAtomic).toBe('18446744073709551615')
    expect(Object.keys(result)).not.toContain('viewKey')
    expect(sidecar.status().configured).toBe(true)
    expect((await sidecar.getWalletStatus()).address).toBe(ADDRESS)
  })

  test('configuration rejects seeds, spend keys, other networks and insecure daemons before spawning', async () => {
    let spawns = 0; const worker = fakeWorker({ ready: false })
    const sidecar = manager(worker, { spawn: () => { spawns++; return worker.proc } })
    for (const input of [{ ...config, spendKey: VIEW }, { ...config, mnemonic: 'public test seed' },
      { ...config, network: 'stagenet' }, { ...config, daemonUrl: 'http://node.example' },
      { ...config, daemonUrl: 'https://user:password@node.example' }]) {
      await expect(sidecar.configureWatch(input as any)).rejects.toThrow()
    }
    expect(spawns).toBe(0)
  })

  test('wrong worker version and startup timeout fail closed', async () => {
    const wrong = manager(fakeWorker({ version: '999' }))
    await expect(wrong.start()).rejects.toThrow()
    expect(wrong.status().state).toBe('error')
    const hanging = manager(fakeWorker({ ready: false }), { startupTimeoutMs: 10 })
    await expect(hanging.start()).rejects.toThrow()
    expect(hanging.status().configured).toBe(false)
  })

  test('request timeout invalidates the worker and rejects pending work', async () => {
    const worker = fakeWorker({ hang: 'get_status' }), sidecar = manager(worker, { requestTimeoutMs: 10 })
    await sidecar.configureWatch(config)
    await expect(sidecar.getWalletStatus()).rejects.toThrow('timed out')
    expect(sidecar.status().state).toBe('error')
    expect(worker.requests.at(-1).cmd).toBe('quit')
  })

  test('stop rejects in-flight operations and a late old exit cannot invalidate a new worker', async () => {
    const old = fakeWorker({ hang: 'get_status' }), fresh = fakeWorker({ ready: false })
    let count = 0
    const sidecar = manager(old, { spawn: () => count++ === 0 ? old.proc : fresh.proc })
    cleanups.push(fresh.exit)
    await sidecar.configureWatch(config)
    const pending = sidecar.getWalletStatus()
    sidecar.stop()
    await expect(pending).rejects.toThrow('stopped')
    const restart = sidecar.start()
    fresh.send({ ok: true, ready: true, version: SIDECAR_VERSION, binaryVersion: MONERO_VERSION })
    await restart
    old.exit()
    await Bun.sleep(1)
    expect(sidecar.status().state).toBe('ready')
    expect(fresh.kills).toHaveLength(0)
  })

  test('oversized or malformed worker lines terminate without forwarding child content', async () => {
    const worker = fakeWorker(), sidecar = manager(worker)
    await sidecar.start()
    worker.bytes('x'.repeat(MAX_IPC_LINE + 1))
    await Bun.sleep(1)
    expect(sidecar.status().state).toBe('error')
    expect(sidecar.status().error).not.toContain('xxx')
  })

  test('status rejects changed wallet identity and secret-bearing responses', async () => {
    const worker = fakeWorker({ response: { ...status, address: '4' + '2'.repeat(94) } }), sidecar = manager(worker)
    await expect(sidecar.configureWatch(config)).rejects.toThrow('changed')
    expect(() => validateWalletStatus({ ...status, viewKey: VIEW })).toThrow()
    expect(() => validateWalletStatus({ ...status, unlockedBalanceAtomic: '18446744073709551616' })).toThrow()
  })
})

describe('exact money and local Digest RPC', () => {
  test('uint64 money stays exact while JSON strings and escaped digits remain unchanged', () => {
    const value = parseExactJson('{"balance":18446744073709551615,"height":3799260,"text":"key12\\\"3","fraction":1.5}')
    expect(value.balance).toBe('18446744073709551615')
    expect(value.height).toBe('3799260')
    expect(value.text).toBe('key12"3')
    expect(value.fraction).toBe('1.5')
    expect(() => parseExactJson('{"balance":01}')).toThrow()
    for (const token of ['1.00000000000000001', '1e-999', '1e3']) {
      expect(() => atomic(parseExactJson(`{"balance":${token}}`).balance)).toThrow()
    }
    expect(() => validateWalletStatus({ ...status, balanceAtomic: 1.00000000000000001 })).toThrow()
  })

  test('Digest challenge parsing refuses unsupported or malformed challenges', () => {
    expect(parseDigest('Digest realm="monero", nonce="abcd", algorithm=MD5, qop="auth"').nonce).toBe('abcd')
    expect(parseDigest('Digest qop="auth",algorithm=MD5-sess,realm="monero-rpc",nonce="abcd",stale=false').algorithm).toBe('MD5-sess')
    for (const value of ['Basic xyz', 'Digest realm="a", nonce="b", algorithm=SHA-256, qop="auth"',
      'Digest realm="a", realm="b", nonce="b", qop="auth"', 'Digest realm="a", nonce="b"']) {
      expect(() => parseDigest(value)).toThrow()
    }
  })

  test('RPC allowlist refuses transfer/sign/export methods without any exchange', async () => {
    const rpc = new DigestWalletRpc(1, 'test', 'test')
    for (const method of ['transfer', 'transfer_split', 'sign_transfer', 'relay_tx', 'query_key_spend']) {
      await expect(rpc.call(method)).rejects.toThrow('unavailable')
    }
    rpc.close()
  })

  test('RPC authenticates a bounded challenge and preserves uint64 response values', async () => {
    const rpc = new DigestWalletRpc(1, 'test', 'test')
    let calls = 0
    ;(rpc as any).exchange = async () => ++calls === 1
      ? { status: 401, challenge: 'Digest realm="monero", nonce="abc", algorithm=MD5, qop="auth"', body: '' }
      : { status: 200, body: '{"jsonrpc":"2.0","id":"1","result":{"balance":18446744073709551615}}' }
    expect((await rpc.call('get_balance')).balance).toBe('18446744073709551615')
    expect(calls).toBe(2)
    expect((rpc as any).authorization()).toContain('uri="/json_rpc"')
    rpc.close()
  })

  test('actual Core MD5-sess challenges produce the session HA1 response algorithm', async () => {
    const rpc = new DigestWalletRpc(1, 'public-test', 'public-test')
    let calls = 0
    ;(rpc as any).exchange = async () => ++calls === 1
      ? { status: 401, challenge: 'Digest qop="auth",algorithm=MD5-sess,realm="monero-rpc",nonce="abcd",stale=false', body: '' }
      : { status: 200, body: '{"jsonrpc":"2.0","id":"1","result":{"version":65568}}' }
    expect((await rpc.call('get_version')).version).toBe('65568')
    expect((rpc as any).authorization()).toContain('algorithm=MD5-sess')
    rpc.close()
  })

  test('watch configuration primary address and exact numeric bounds are enforced', () => {
    expect(validateConfiguration(config).daemonUrl).toBe('https://node.example')
    expect(validateConfiguration({ ...config, daemonUrl: 'http://127.0.0.1:18081' }).daemonUrl).toBe('http://127.0.0.1:18081')
    expect(() => validateConfiguration({ ...config, restoreHeight: -1 })).toThrow()
    expect(() => validateConfiguration({ ...config, viewKey: '0'.repeat(64) })).toThrow()
  })
})
