import { expect, test } from 'bun:test'
import { createMoneroRequestQueue } from './request-queue'
import { createMoneroSidecarManager } from '../../src/bun/monero-sidecar'
import { MONERO_VERSION, SIDECAR_VERSION } from './protocol'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('cached status bypasses a held preparation while every other command keeps mutation order', async () => {
  const held = gate(), started: string[] = []
  const queue = createMoneroRequestQueue(async value => {
    started.push(value.cmd)
    if (value.cmd === 'create_transfer') await held.promise
  })
  const preparing = queue.submit({ cmd: 'create_transfer' })
  await Promise.resolve()
  for (const cmd of ['configure_watch', 'import_key_images', 'export_outputs', 'refresh', 'relay_tx', 'lookup_tx', 'unknown']) {
    void queue.submit({ cmd })
  }
  await queue.submit({ cmd: 'get_status' })
  expect(started).toEqual(['create_transfer', 'get_status'])
  held.release()
  await preparing; await queue.drain()
  expect(started).toEqual(['create_transfer', 'get_status', 'configure_watch', 'import_key_images', 'export_outputs', 'refresh', 'relay_tx', 'lookup_tx', 'unknown'])
})

test('status polling cannot invalidate the worker while prepare outlasts the status watchdog', async () => {
  const address = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'
  const status = { network: 'mainnet' as const, address, balanceAtomic: '17', unlockedBalanceAtomic: '11', walletHeight: 200,
    monitorReady: true, transactions: [], updatedAt: new Date().toISOString(), canSend: false }
  const config = { network: 'mainnet' as const, walletId: 'public-test-wallet', address, viewKey: '12'.repeat(32), restoreHeight: 100, daemonUrl: 'https://node.example' }
  const held = gate(), preparing = gate(), encoder = new TextEncoder(), started: string[] = [], kills: unknown[] = []
  let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>
  let finishExit!: (code: number) => void, ended = false
  const send = (value: unknown) => { if (!ended) stdout.enqueue(encoder.encode(JSON.stringify(value) + '\n')) }
  const exit = () => { if (!ended) { ended = true; stdout.close(); stderr.close(); finishExit(0) } }
  const queue = createMoneroRequestQueue(async request => {
    started.push(request.cmd)
    if (request.cmd === 'create_transfer') {
      preparing.release(); await held.promise
      send({ ok: false, _req_id: request._req_id, error: 'The watch wallet cannot build this transaction' })
    } else send({ ok: true, _req_id: request._req_id, result: status })
  })
  const proc = {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller } }),
    exited: new Promise<number>(resolve => { finishExit = resolve }),
    stdin: { write(value: string) {
      const request = JSON.parse(value)
      if (request.cmd === 'quit') { exit(); return }
      void queue.submit(request)
    }, flush() {} },
    kill(signal?: unknown) { kills.push(signal); exit() },
  }
  const manager = createMoneroSidecarManager({ spawn: () => proc, startupTimeoutMs: 1000, requestTimeoutMs: 20 })
  queueMicrotask(() => send({ ok: true, ready: true, version: SIDECAR_VERSION, binaryVersion: MONERO_VERSION, sendReady: true }))
  try {
    await manager.configureWatch(config)
    const draft = manager.createTransfer({ address, amountAtomic: '1', priority: 0 }).catch(error => error)
    await preparing.promise
    const nextMutation = manager.configureWatch(config)
    for (let i = 0; i < 3; i++) {
      expect((await manager.getWalletStatus()).balanceAtomic).toBe('17')
      await Bun.sleep(25)
    }
    expect(manager.status()).toMatchObject({ state: 'ready', configured: true })
    expect(started.filter(cmd => cmd === 'configure_watch')).toHaveLength(1)
    expect(kills).toHaveLength(0)
    held.release()
    expect((await draft).message).toBe('The watch wallet cannot build this transaction')
    await nextMutation
    expect(started.filter(cmd => cmd === 'configure_watch')).toHaveLength(2)
    expect(manager.status().state).toBe('ready')
  } finally { held.release(); manager.stop(); exit(); await queue.drain() }
})
