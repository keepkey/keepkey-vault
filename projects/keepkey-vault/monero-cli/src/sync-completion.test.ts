import { expect, test } from 'bun:test'
import { MoneroWatchService, nodeSyncStatus, verifyDaemon } from './wallet'
import { WATCH_NODE_UNREACHABLE, WATCH_SCANNING } from './protocol'

const ADDRESS = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
function fixture(height = 150, tip = 200) {
  const service = new MoneroWatchService('/not-used')
  const calls: string[] = []
  let walletHeight = height, fail: Error | null = null
  const session: any = { address: ADDRESS, restoreHeight: 100, daemonUrl: 'http://127.0.0.1:18081',
    daemonSynchronized: true, daemonHeight: tip, nodeAnsweredAt: Date.now(), sendable: true,
    status: { network: 'mainnet', address: ADDRESS, balanceAtomic: '17', unlockedBalanceAtomic: '11', walletHeight: 0,
      transactions: [], monitorReady: false, updatedAt: new Date().toISOString(), canSend: false },
    rpc: { call: async (method: string) => {
      calls.push(method)
      if (fail) throw fail
      if (method === 'get_height') return { height: walletHeight }
      if (method === 'get_balance') return { balance: '17', unlocked_balance: '11' }
      if (method === 'get_transfers') return { in: [], pool: [] }
      throw Error('No unbounded refresh may run: ' + method)
    } },
  }
  ;(service as any).session = session
  return { service, session, calls, height: (value: number) => { walletHeight = value }, fail: (error: Error | null) => { fail = error } }
}

test('snapshot polling remains responsive while bounded Core automatic scanning catches up', async () => {
  const f = fixture()
  expect(await f.service.refresh()).toMatchObject({ walletHeight: 150, daemonHeight: 200, monitorReady: false, balanceAtomic: '17' })
  expect(f.calls).toEqual(['get_height', 'get_balance', 'get_transfers'])
  f.height(200)
  expect(await f.service.refresh()).toMatchObject({ walletHeight: 200, daemonHeight: 200, monitorReady: true })
  expect(f.calls).not.toContain('refresh')
})

test('the restore height alone is never sufficient to mark a partially scanned wallet synced', async () => {
  const f = fixture(100, 200)
  expect((await f.service.refresh()).monitorReady).toBe(false)
  f.height(0)
  expect((await f.service.refresh()).monitorReady).toBe(false)
})

test('a stale or unsynchronized daemon cannot certify a caught-up wallet', async () => {
  const f = fixture(200, 200)
  f.session.nodeAnsweredAt = Date.now() - 60_000
  expect((await f.service.refresh()).monitorReady).toBe(false)
  f.session.nodeAnsweredAt = Date.now(); f.session.daemonSynchronized = false
  expect((await f.service.refresh()).monitorReady).toBe(false)
})

test('an advancing tip revokes readiness until the wallet catches up, without restarting it', async () => {
  const f = fixture(200, 200)
  await f.service.refresh()
  const node = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ result: {
    status: 'OK', nettype: 'mainnet', synchronized: true, offline: false, height: 201,
  } }) })
  try {
    f.session.daemonUrl = `http://127.0.0.1:${node.port}`
    await f.service.probeNode(f.session)
    expect(f.service.getStatus()).toMatchObject({ monitorReady: false, walletHeight: 200, daemonHeight: 201, balanceAtomic: '17' })
    f.height(201)
    expect((await f.service.refresh()).monitorReady).toBe(true)
  } finally { node.stop(true) }
})

test('a daemon that recovers after configuration can reach ready; its startup synchronization flag is not permanent', async () => {
  const f = fixture(200, 200)
  f.session.daemonSynchronized = false; f.session.sendable = false
  await f.service.refresh()
  let synchronized = false
  const node = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ result: {
    status: 'OK', nettype: 'mainnet', synchronized, offline: false, height: 200,
  } }) })
  try {
    f.session.daemonUrl = `http://127.0.0.1:${node.port}`
    await f.service.probeNode(f.session)
    expect(f.service.getStatus()).toMatchObject({ monitorReady: false, error: WATCH_NODE_UNREACHABLE })
    synchronized = true
    await f.service.probeNode(f.session)
    expect(f.service.getStatus().monitorReady).toBe(false)
    await f.service.refresh()
    expect(f.service.getStatus()).toMatchObject({ monitorReady: true, balanceAtomic: '17' })
    expect(f.service.getStatus().error).toBeUndefined()
    expect(f.session.sendable).toBe(true)
  } finally { node.stop(true) }
})

test('a healthy daemon cannot hide a failed wallet RPC behind its last successful snapshot', async () => {
  const f = fixture(200, 200)
  await f.service.refresh()
  f.fail(Error('Monero wallet RPC timed out'))
  await expect(f.service.refresh()).rejects.toThrow('could not refresh')
  const node = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ result: {
    status: 'OK', nettype: 'mainnet', synchronized: true, offline: false, height: 200,
  } }) })
  try {
    f.session.daemonUrl = `http://127.0.0.1:${node.port}`
    await f.service.probeNode(f.session)
    expect(f.service.getStatus()).toMatchObject({ monitorReady: false, error: WATCH_SCANNING, balanceAtomic: '17' })
  } finally { node.stop(true) }
})

test('a wallet timeout retains the last snapshot and distinguishes scanning from a silent daemon', async () => {
  const f = fixture(200, 200)
  await f.service.refresh()
  const observed = f.service.getStatus().updatedAt
  f.fail(Error('Monero wallet RPC timed out'))
  await expect(f.service.refresh()).rejects.toThrow('could not refresh')
  expect(f.service.getStatus()).toMatchObject({ monitorReady: false, error: WATCH_SCANNING, balanceAtomic: '17', updatedAt: observed })
  f.session.nodeAnsweredAt = Date.now() - 60_000
  await expect(f.service.refresh()).rejects.toThrow('could not refresh')
  expect(f.service.getStatus()).toMatchObject({ error: WATCH_NODE_UNREACHABLE, updatedAt: observed })
})

test('a responding height from an unsynchronized, offline, or wrong-network daemon does not grant readiness', async () => {
  const request = async (patch: Record<string, unknown>) => nodeSyncStatus('http://127.0.0.1:18081', undefined, false,
    async () => Response.json({ result: { status: 'OK', nettype: 'mainnet', synchronized: true, offline: false, height: 200, ...patch } }))
  expect(await request({ synchronized: false })).toMatchObject({ synchronized: false, sendable: false })
  expect(await request({ busy_syncing: true })).toMatchObject({ synchronized: false, sendable: false })
  expect(await request({ offline: true })).toMatchObject({ synchronized: false, sendable: false })
  await expect(request({ nettype: 'stagenet' })).rejects.toThrow('could not be read')
})

test('startup verification cannot certify a busy or offline mainnet daemon as synchronized', async () => {
  let patch = { busy_syncing: true, offline: false }
  const node = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ result: {
    status: 'OK', nettype: 'mainnet', synchronized: true, height: 200, ...patch,
  } }) })
  try {
    expect((await verifyDaemon(`http://127.0.0.1:${node.port}`, 0)).synchronized).toBe(false)
    patch = { busy_syncing: false, offline: true }
    expect((await verifyDaemon(`http://127.0.0.1:${node.port}`, 0)).synchronized).toBe(false)
  } finally { node.stop(true) }
})
