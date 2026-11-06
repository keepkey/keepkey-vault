import { expect, test } from 'bun:test'
import { withDaemonTrusted } from './wallet'

const recorder = (failUntrust = false) => {
  const calls: Array<[string, any]> = []
  return { calls, rpc: { async call(method: string, params: any) {
    calls.push([method, params])
    if (failUntrust && method === 'set_daemon' && params.trusted === false) throw new Error('rpc down')
    return {}
  } } }
}

test('a remote daemon is trusted only around the work, with its TLS pin kept', async () => {
  const r = recorder()
  await withDaemonTrusted(r.rpc, 'https://node.example', 'ab'.repeat(32), async () => { r.calls.push(['work', null]) })
  expect(r.calls.map(([m, p]) => m === 'set_daemon' ? `trust:${p.trusted}:${p.ssl_support}:${p.ssl_allowed_fingerprints[0]}` : m))
    .toEqual([`trust:true:enabled:${'ab'.repeat(32)}`, 'work', `trust:false:enabled:${'ab'.repeat(32)}`])
})

test('the daemon is untrusted again even when the work fails, and a failed untrust surfaces', async () => {
  const r = recorder()
  await expect(withDaemonTrusted(r.rpc, 'https://node.example', 'cd'.repeat(32), async () => { throw new Error('import failed') })).rejects.toThrow('import failed')
  expect(r.calls.at(-1)?.[1].trusted).toBe(false)
  await expect(withDaemonTrusted(recorder(true).rpc, 'https://node.example', 'cd'.repeat(32), async () => 1)).rejects.toThrow('rpc down')
})

test('a loopback daemon is already trusted: no set_daemon calls', async () => {
  const r = recorder()
  expect(await withDaemonTrusted(r.rpc, 'http://127.0.0.1:18081', undefined, async () => 7)).toBe(7)
  expect(r.calls).toEqual([])
})
