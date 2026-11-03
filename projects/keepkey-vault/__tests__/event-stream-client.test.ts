import { describe, expect, test } from 'bun:test'
import { createEventStreamClient, type StreamEvent } from '../src/shared/event-stream-client'

const watch = { address: '0xAbC', networkId: 'eip155:1' }
const otherWatch = { address: 'ltc1-public-fixture', networkId: 'bip122:ltc' }
const tick = () => Bun.sleep(0)
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>, cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel() { cancelled = true } })
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send: (value: string) => controller.enqueue(new TextEncoder().encode(value)), close: () => controller.close(),
    get cancelled() { return cancelled } }
}
function harness() {
  let base = 'https://first.invalid', key = 'first-key'
  const requests: Array<{ body: any; signal: AbortSignal; resolve: (response: Response) => void }> = []
  const timers: Array<{ run: () => void; cancelled: boolean; delay: number }> = []
  const client = createEventStreamClient({ getBase: () => base, getQueryKey: () => key,
    fetch: (async (_url, init) => new Promise<Response>(resolve => requests.push({ body: JSON.parse(String(init?.body)), signal: init?.signal as AbortSignal, resolve }))) as typeof fetch,
    schedule(run, delay) { const timer = { run, cancelled: false, delay }; timers.push(timer); return () => { timer.cancelled = true } }, random: () => 0.5,
  })
  return { client, requests, timers, setBase: (value: string) => { base = value }, setKey: (value: string) => { key = value } }
}
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

describe('active wallet SSE lease', () => {
  test('late old fetch cannot call the new wallet handler or reconnect', async () => {
    const h = harness(), oldEvents: StreamEvent[] = [], nextEvents: StreamEvent[] = []
    h.client.start([watch], event => oldEvents.push(event))
    h.client.start([otherWatch], event => nextEvents.push(event))
    const old = stream(), next = stream()
    old.send(frame('tx:incoming', { txid: 'old-wallet' }))
    h.requests[0].resolve(old.response); h.requests[1].resolve(next.response)
    next.send(frame('connected', { sessionId: 'next', watching: 1 }))
    await tick()
    expect(h.requests[0].signal.aborted).toBe(true)
    expect(old.cancelled).toBe(true)
    expect(oldEvents).toHaveLength(0)
    expect(nextEvents.map(event => event.type)).toEqual(['connected'])
    expect(h.timers).toHaveLength(0)
    h.client.stop()
  })

  test('queued old-reader data is discarded after stop/restart', async () => {
    const h = harness(), oldEvents: StreamEvent[] = [], nextEvents: StreamEvent[] = []
    h.client.start([watch], event => oldEvents.push(event))
    const old = stream(); h.requests[0].resolve(old.response); await tick()
    old.send(frame('tx:incoming', { txid: 'queued-old-wallet' }))
    h.client.start([otherWatch], event => nextEvents.push(event))
    await tick()
    expect(oldEvents).toHaveLength(0); expect(nextEvents).toHaveLength(0)
    expect(old.cancelled).toBe(true); expect(h.timers).toHaveLength(0)
    h.client.stop()
  })

  test('identical normalized watches replace callbacks without disconnecting', async () => {
    const h = harness(), oldEvents: StreamEvent[] = [], nextEvents: StreamEvent[] = []
    h.client.start([watch, otherWatch], event => oldEvents.push(event))
    const source = stream(); h.requests[0].resolve(source.response); await tick()
    h.client.start([otherWatch, { ...watch, address: watch.address.toLowerCase() }, watch], event => nextEvents.push(event))
    expect(h.requests).toHaveLength(1); expect(h.requests[0].signal.aborted).toBe(false)
    source.send(frame('tx:incoming', { address: watch.address, networkId: watch.networkId, txid: 'current', refreshHint: true }))
    await tick()
    expect(oldEvents).toHaveLength(0); expect(nextEvents).toHaveLength(1)
    h.setKey('different-key'); h.client.start([watch, otherWatch], () => {})
    expect(h.requests).toHaveLength(2); expect(h.requests[0].signal.aborted).toBe(true)
    h.setBase('https://different.invalid'); h.client.start([watch, otherWatch], () => {})
    expect(h.requests).toHaveLength(3)
    h.client.stop()
  })

  test('reconnect carries the latest same-session cursor; wallet switch clears it', async () => {
    const h = harness(), events: StreamEvent[] = []
    h.client.start([watch], event => events.push(event))
    const source = stream(); h.requests[0].resolve(source.response)
    source.send(frame('connected', { sessionId: 'one', watching: 1, cursor: 100 }))
    source.send(frame('sync:required', { refreshHint: true, cursor: 200, reason: 'upstream_reconnected' }))
    source.close(); await tick()
    expect(events.map(event => event.type)).toEqual(['connected', 'sync:required'])
    expect(h.timers).toHaveLength(1); h.timers[0].run()
    expect(h.requests[1].body.since).toBe(200)
    h.client.start([otherWatch], () => {})
    expect(h.requests[2].body.since).toBeUndefined()
    h.client.stop()
  })
  test('durable scope changes reset the live cursor and hidden leases omit durable ownership', async () => {
    const h = harness()
    h.client.start([watch], () => {}, undefined, { walletScope: 'public-wallet-one' })
    expect(h.requests[0].body.walletScope).toBe('public-wallet-one')
    const source = stream(); h.requests[0].resolve(source.response); source.send(frame('connected', { cursor: 123, watching: 1 })); await tick()
    h.client.start([watch], () => {}, undefined, { walletScope: 'public-wallet-two' })
    expect(h.requests[1].body).toMatchObject({ walletScope: 'public-wallet-two' }); expect(h.requests[1].body.since).toBeUndefined()
    h.client.start([watch], () => {})
    expect(h.requests[2].body.walletScope).toBeUndefined(); expect(h.requests[2].body.since).toBeUndefined(); h.client.stop()
  })

  test('accepts CRLF, comments and split multiline JSON; skips unknown/malformed frames', async () => {
    const h = harness(), events: StreamEvent[] = []
    h.client.start([watch], event => events.push(event))
    const source = stream(); h.requests[0].resolve(source.response)
    source.send(': heartbeat\r\nevent: connected\r\ndata: {"sessionId":"s",\r\ndata: "watching":1,"cursor":100}\r')
    source.send('\n\r\nevent: unsupported\r\ndata: {}\r\n\r\nevent: tx:incoming\r\ndata: not-json\r\n\r\n')
    source.send(frame('tx:incoming', { address: watch.address, networkId: watch.networkId, txid: 'hint', refreshHint: true }))
    await tick()
    expect(events.map(event => event.type)).toEqual(['connected', 'tx:incoming'])
    expect((events[1].data as any).value).toBeUndefined()
    h.client.stop()
  })

  test('oversized frames cancel the reader and stopped retries cannot reconnect', async () => {
    const h = harness()
    h.client.start([watch], () => {})
    const source = stream(); h.requests[0].resolve(source.response)
    source.send('data: '+ 'x'.repeat(262_145)); await tick()
    expect(source.cancelled).toBe(true); expect(h.timers).toHaveLength(1)
    h.client.stop(); expect(h.timers[0].cancelled).toBe(true)
    h.timers[0].run(); expect(h.requests).toHaveLength(1)
  })

  test('a synchronous stop from connected status suppresses subsequent callbacks', async () => {
    const h = harness(), events: StreamEvent[] = []
    h.client.start([watch], event => events.push(event), status => { if (status.connected) h.client.stop() })
    const source = stream(); h.requests[0].resolve(source.response)
    source.send(frame('connected', { sessionId: 's', watching: 1 })); await tick()
    expect(events).toHaveLength(0); expect(h.requests[0].signal.aborted).toBe(true)
  })
})
