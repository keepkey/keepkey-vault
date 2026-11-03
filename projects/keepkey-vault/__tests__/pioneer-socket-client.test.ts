import { describe, expect, test } from 'bun:test'
import { PioneerSocketClient } from '../src/shared/pioneer-socket-client'

class Socket {
  readyState = 1
  sent: string[] = []
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(value: string) { this.sent.push(value) }
  close() { this.closed = true }
  receive(value: string) { this.onmessage?.({ data: value }) }
}
const event = (name: string, data: unknown) => '42'+JSON.stringify([name, data])
function harness() {
  const sockets: Socket[] = [], events: string[] = [], timers: Array<{ run: () => void; cancelled: boolean }> = []
  let connected = 0, disconnected = 0
  const client = new PioneerSocketClient({ queryKey: 'fixture-key', onEvent: name => events.push(name),
    onConnect: () => connected++, onDisconnect: () => disconnected++,
  }, { getBase: () => 'https://fixture.invalid', createSocket: () => {
    const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket
  }, schedule: run => { const timer = { run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } } })
  return { client, sockets, events, timers, get connected() { return connected }, get disconnected() { return disconnected } }
}

describe('Pioneer socket current connection', () => {
  test('only explicit successful auth allows callbacks; supports legacy string acknowledgements', () => {
    const h = harness(); h.client.start(); const socket = h.sockets[0]
    socket.receive('0{}'); socket.receive('40{}')
    expect(socket.sent[0]).toBe('40')
    expect(socket.sent[1]).toContain('authenticate')
    socket.receive(event('transaction:incoming', {})); expect(h.events).toHaveLength(0)
    socket.receive(event('authenticated', { username: 'missing-success' })); expect(h.connected).toBe(0)
    h.client.stop(); h.client.start()
    h.sockets[1].receive(event('authenticated', JSON.stringify({ success: true })))
    h.sockets[1].receive(event('transaction:incoming', {}))
    expect(h.connected).toBe(1); expect(h.events).toEqual(['transaction:incoming'])
    h.client.stop()
  })

  test('old socket frames cannot send through the new socket, emit or reconnect', () => {
    const h = harness(); h.client.start(); const old = h.sockets[0]
    old.receive(event('authenticated', { success: true })); h.client.stop(); h.client.start()
    const next = h.sockets[1], priorDisconnects = h.disconnected
    old.receive('0{}'); old.receive('2'); old.receive('40{}')
    old.receive(event('authenticated', { success: true })); old.receive(event('transaction:incoming', {})); old.onclose?.()
    expect(next.sent).toHaveLength(0); expect(h.events).toHaveLength(0)
    expect(h.connected).toBe(1); expect(h.disconnected).toBe(priorDisconnects); expect(h.timers).toHaveLength(0)
    next.receive(event('authenticated', { success: true })); next.receive('2')
    expect(next.sent).toEqual(['3']); expect(h.connected).toBe(2)
    h.client.stop()
  })

  test('old attempt callbacks after reconnect do not affect the replacement socket', () => {
    const h = harness(); h.client.start(); const old = h.sockets[0]
    old.onclose?.(); expect(h.timers).toHaveLength(1); h.timers[0].run()
    const next = h.sockets[1]
    old.receive(event('authenticated', { success: true })); old.onclose?.()
    expect(h.connected).toBe(0); expect(h.timers).toHaveLength(1)
    next.receive(event('authenticated', { success: true })); expect(h.connected).toBe(1)
    h.client.stop()
  })

  test('stop cancels retries; even a previously queued retry cannot restart', () => {
    const h = harness(); h.client.start(); h.client.start(); expect(h.sockets).toHaveLength(1)
    h.sockets[0].onclose?.(); h.client.stop()
    expect(h.timers[0].cancelled).toBe(true)
    h.timers[0].run(); expect(h.sockets).toHaveLength(1)
  })

  test('false, malformed or string-true auth never succeeds', () => {
    for (const payload of [{ success: false }, { success: 'true' }, 'not-json']) {
      const h = harness(); h.client.start(); h.sockets[0].receive(event('authenticated', payload))
      h.sockets[0].receive(event('transaction:incoming', {}))
      expect(h.connected).toBe(0); expect(h.events).toHaveLength(0); h.client.stop()
    }
  })
})
