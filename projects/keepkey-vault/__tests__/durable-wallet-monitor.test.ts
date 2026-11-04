import { expect, test } from 'bun:test'
import { createDurableWalletMonitor, monitorCursorContext, type DurableMonitorSession } from '../src/bun/durable-wallet-monitor'
const session: DurableMonitorSession = { walletScope: 'vault:public-fixture', base: 'https://fixture.invalid', queryKey: 'fixture',
  scope: { epoch: 1, deviceId: 'fixture', walletId: 'fixture:public', wallet: {} } }
const addresses = [{ address: 'public-account', networkId: 'bip122:ltc' }]
const event = { id: '1', eventId: 'stable-1', eventName: 'tx:incoming', payload: { watchedAddress: 'public-account', networkId: 'bip122:ltc', txid: 'payment', refreshHint: true } }
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function harness(flush: () => Promise<boolean> = async () => true) {
  let allowed = true
  const requests: Array<{ path: string; body: any }> = [], delivered: any[] = [], cursors = new Map<string, string>()
  let replay = 0
  const monitor = createDurableWalletMonitor({ isCurrent: () => allowed,
    readCursor: key => cursors.get(key), writeCursor: (key, value) => { cursors.set(key, value) },
    deliver: value => { delivered.push(value); return true }, flush, now: () => 100,
    fetch: (async (url, init) => {
      const path = String(url).split('/events/')[1], body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ path, body })
      if (path.startsWith('replay')) return Response.json(replay++ ? { events: [], cursor: 'opaque-db-1' } : { events: [event], cursor: 'opaque-db-1' })
      return path === 'ack' ? new Response(null, { status: 204 }) : Response.json({ enabled: body.enabled })
    }) as typeof fetch,
  })
  return { monitor, requests, delivered, cursors, setAllowed: (value: boolean) => { allowed = value } }
}
test('registers durable ownership, replays hints, and persists the opaque cursor after refresh and acknowledgement', async () => {
  const h = harness(); h.monitor.replace(session, addresses); await tick(); await tick()
  expect(h.requests[0]).toMatchObject({ path: 'watches', body: { walletScope: session.walletScope, addresses, enabled: true } })
  expect(h.delivered).toEqual([{ type: event.eventName, data: event.payload }])
  expect(h.requests.find(request => request.path === 'ack')?.body).toEqual({ walletScope: session.walletScope, cursor: 'opaque-db-1', eventIds: ['stable-1'] })
  expect(h.cursors.get(monitorCursorContext(session))).toBe('opaque-db-1')
  await h.monitor.replay(); expect(h.requests.at(-1)?.path).toContain('after=opaque-db-1')
  h.monitor.stop(); expect(h.requests.filter(request => request.body?.enabled === false)).toEqual([])
})
test('failed processing never acknowledges or advances the persisted cursor', async () => {
  const h = harness(async () => false); h.monitor.replace(session, addresses); await tick(); await tick()
  expect(h.requests.some(request => request.path === 'ack')).toBe(false); expect(h.cursors.size).toBe(0)
  h.monitor.stop()
})
test('wallet switches during processing cannot acknowledge into the next wallet', async () => {
  let finish!: (ok: boolean) => void
  const h = harness(() => new Promise(resolve => { finish = resolve }))
  h.monitor.replace(session, addresses); await tick(); await tick()
  h.setAllowed(false); h.monitor.stop(); finish(true); await tick()
  expect(h.requests.some(request => request.path === 'ack')).toBe(false); expect(h.cursors.size).toBe(0)
})
test('explicit suspension is separate from closing and has a newer revision than registration', async () => {
  const h = harness(); h.monitor.replace(session, addresses); await tick(); await tick(); await h.monitor.suspend()
  const replacements = h.requests.filter(request => request.path === 'watches')
  expect(replacements[1].body).toMatchObject({ walletScope: session.walletScope, enabled: false, addresses: [] })
  expect(replacements[1].body.revision).toBeGreaterThan(replacements[0].body.revision)
})
test('a private or obsolete session never registers or persists any monitoring state', () => {
  const h = harness(); h.setAllowed(false); h.monitor.replace(session, addresses)
  expect(h.requests).toEqual([]); expect(h.cursors.size).toBe(0)
})
test('opaque cursors are isolated by normalized provider, authentication key and wallet', async () => {
  expect(monitorCursorContext(session)).toBe(monitorCursorContext({ ...session, base: 'https://FIXTURE.invalid/' }))
  for (const other of [{ ...session, base: 'https://other.invalid' }, { ...session, queryKey: 'other-key' }, { ...session, walletScope: 'other-wallet' }]) {
    const h = harness(); h.cursors.set(monitorCursorContext(session), '1000000-from-other-queue')
    h.monitor.replace(other, addresses); await tick(); await tick()
    expect(h.requests.find(request => request.path.startsWith('replay'))?.path).not.toContain('after=')
    expect(h.cursors.get(monitorCursorContext(session))).toBe('1000000-from-other-queue')
    h.monitor.stop()
  }
})
test('live event acknowledgements use the scoped stable IDs without advancing an unrelated opaque cursor', async () => {
  const h = harness(); h.monitor.replace(session, addresses); await tick(); await tick()
  await h.monitor.acknowledge(['live-event'])
  expect(h.requests.at(-1)?.body).toEqual({ walletScope: session.walletScope, eventIds: ['live-event'] })
  expect(h.cursors.get(monitorCursorContext(session))).toBe('opaque-db-1')
  h.monitor.stop()
})
test('registration retries transient failures with bounded delays', async () => {
  const requests: any[] = [], delays: number[] = []; let failures = 0
  const monitor = createDurableWalletMonitor({ isCurrent: () => true, readCursor: () => undefined, writeCursor: () => {}, deliver: () => true, flush: async () => true,
    wait: async ms => { delays.push(ms) }, fetch: (async (url, options) => {
      requests.push({ url: String(url), body: options?.body && JSON.parse(String(options.body)) })
      if (String(url).endsWith('watches') && failures++ < 2) return new Response('', { status: 503 })
      return Response.json(String(url).includes('replay') ? { events: [] } : {})
    }) as typeof fetch })
  monitor.replace(session, addresses); await tick(); await tick()
  expect(delays).toEqual([2000, 10000]); expect(requests.filter(request => request.url.endsWith('watches'))).toHaveLength(3)
  monitor.stop()
})
test('registration recovers after an extended outage and stopping cancels the next rate-limited retry', async () => {
  for (const cancel of [false, true]) {
    const delays: number[] = []; let attempts = 0, resume!: () => void
    const monitor = createDurableWalletMonitor({ isCurrent: () => true, readCursor: () => undefined, writeCursor: () => {}, deliver: () => true, flush: async () => true,
      wait: async ms => { delays.push(ms); if (delays.length === 4) await new Promise<void>(resolve => { resume = resolve }) },
      fetch: (async (url) => { if (String(url).endsWith('watches') && attempts++ < 4) return new Response('', { status: 503 })
        return Response.json(String(url).includes('replay') ? { events: [] } : {})
      }) as typeof fetch })
    monitor.replace(session, addresses); await tick(); await tick()
    expect(attempts).toBe(4); expect(delays).toEqual([2000, 10000, 30000, 60000])
    if (cancel) monitor.stop()
    resume(); await tick(); await tick(); expect(attempts).toBe(cancel ? 4 : 5); monitor.stop()
  }
})
test('unaccepted replay rows cannot advance the page cursor or be acknowledged', async () => {
  const requests: string[] = [], cursors: string[] = []
  const monitor = createDurableWalletMonitor({ isCurrent: () => true, readCursor: () => undefined, writeCursor: (_key, cursor) => { cursors.push(cursor) },
    deliver: () => false, flush: async () => true, fetch: (async url => {
      const path = String(url).split('/events/')[1]; requests.push(path)
      return Response.json(path.startsWith('replay') ? { events: [event], cursor: 'unowned' } : {})
    }) as typeof fetch })
  monitor.replace(session, addresses); await tick(); await tick()
  expect(requests).toHaveLength(2); expect(cursors).toEqual([]); expect(requests).not.toContain('ack'); monitor.stop()
})
test('reconnect replay waits for successful registration instead of consuming an older watch inventory', async () => {
  let register!: () => void; const requests: string[] = []
  const monitor = createDurableWalletMonitor({ isCurrent: () => true, readCursor: () => undefined, writeCursor: () => {}, deliver: () => true, flush: async () => true,
    fetch: (async url => { const path = String(url).split('/events/')[1]; requests.push(path)
      if (path === 'watches') await new Promise<void>(resolve => { register = resolve })
      return Response.json(path.startsWith('replay') ? { events: [] } : {})
    }) as typeof fetch })
  monitor.replace(session, addresses); await monitor.replay(); expect(requests).toEqual(['watches'])
  register(); await tick(); expect(requests[1]).toContain('replay?'); monitor.stop()
})
test('long queues continue after yielding, and stopped-wallet continuations cannot run', async () => {
  for (const stopAtYield of [false, true]) {
    let pages = 0, resume!: () => void; const cursors: string[] = []
    const monitor = createDurableWalletMonitor({ isCurrent: () => true, readCursor: () => cursors.at(-1), writeCursor: (_key, value) => { cursors.push(value) },
      deliver: () => true, flush: async () => true, wait: () => new Promise<void>(resolve => { resume = resolve }), fetch: (async url => {
        if (!String(url).includes('replay?')) return Response.json({})
        pages++; return Response.json({ events: Array.from({ length: pages <= 10 ? 100 : 1 }, (_, i) => ({ ...event, eventId: `${pages}-${i}` })), cursor: String(pages * 100) })
      }) as typeof fetch })
    monitor.replace(session, addresses)
    for (let i = 0; i < 15; i++) await tick()
    expect(pages).toBe(10); expect(cursors.at(-1)).toBe('1000')
    if (stopAtYield) monitor.stop()
    resume(); await tick(); await tick()
    expect(pages).toBe(stopAtYield ? 10 : 11); expect(cursors.at(-1)).toBe(stopAtYield ? '1000' : '1100'); monitor.stop()
  }
})
test('failed explicit disable reports failure and keeps the live registration usable', async () => {
  let disabled = false
  const monitor = createDurableWalletMonitor({ isCurrent: () => true, readCursor: () => undefined, writeCursor: () => {}, deliver: () => true, flush: async () => true,
    fetch: (async (url, options) => { if (options?.body && JSON.parse(String(options.body)).enabled === false) { disabled = true; return new Response('', { status: 503 }) }
      return Response.json(String(url).includes('replay') ? { events: [] } : {})
    }) as typeof fetch })
  monitor.replace(session, addresses); await tick(); await expect(monitor.suspend()).rejects.toThrow('Offline mode was not enabled')
  expect(disabled).toBe(true); await monitor.replay(); monitor.stop()
})
