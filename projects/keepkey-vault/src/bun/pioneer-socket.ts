/**
 * Minimal Socket.IO v4 client over Bun native WebSocket.
 *
 * socket.io-client crashes Electrobun's Bun runtime, so we speak the
 * Engine.IO v4 / Socket.IO v4 framing protocol directly:
 *
 *   Engine.IO frame prefix (single char):
 *     '0' = OPEN (server → client handshake JSON)
 *     '2' = PING  (server → client)
 *     '3' = PONG  (client → server, in response to PING)
 *     '4' = MESSAGE (application payload)
 *
 *   Socket.IO sub-type inside a MESSAGE frame:
 *     '0' = CONNECT  (join namespace)
 *     '2' = EVENT    (42["event-name", data])
 *
 * Auth flow:
 *   1. WebSocket connects to ws://host/socket.io/?EIO=4&transport=websocket
 *   2. Server sends: 0{"sid":"...","pingInterval":25000,"pingTimeout":20000}
 *   3. Client sends: 40        (SIO CONNECT to default namespace /)
 *   4. Server sends: 40{...}   (connected ack)
 *   5. Client sends: 42["authenticate",{"queryKey":"..."}]
 *   6. Server sends: 42["authenticated",{"success":true,"username":"..."}]
 *   7. Server sends pings (2) → client replies pong (3)
 *   8. Events arrive as: 42["event-name", payload]
 */

import { getPioneerApiBase } from './pioneer'

const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS  = 60_000

export interface PioneerSocketOptions {
  queryKey: string
  onEvent: (event: string, data: unknown) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

export class PioneerSocket {
  private ws: WebSocket | null = null
  private opts: PioneerSocketOptions
  private stopped = false
  private reconnectDelay = RECONNECT_BASE_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: PioneerSocketOptions) {
    this.opts = opts
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
  }

  private connect() {
    const base = getPioneerApiBase().replace(/\/+$/, '')
    const wsUrl = base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket'
    console.log('[PioneerSocket] connecting to', wsUrl)

    try {
      this.ws = new WebSocket(wsUrl)
    } catch (e: any) {
      console.warn('[PioneerSocket] constructor threw:', e.message)
      this.scheduleReconnect()
      return
    }

    this.ws.onmessage = (evt) => this.handleFrame(String(evt.data))

    this.ws.onclose = (evt) => {
      console.log(`[PioneerSocket] closed (code=${evt.code})`)
      this.opts.onDisconnect?.()
      if (!this.stopped) this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      // onclose will fire immediately after; no need to double-log
    }
  }

  private handleFrame(raw: string) {
    if (!raw.length) return
    const eioType = raw[0]

    // EIO OPEN handshake → join default namespace
    if (eioType === '0') { this.send('40'); return }

    // EIO PING → PONG
    if (eioType === '2') { this.send('3'); return }

    // Only process EIO MESSAGE frames from here on
    if (eioType !== '4') return

    const sio = raw.slice(1)

    // SIO CONNECT ack ("40{...}") → authenticate
    if (sio[0] === '0') {
      console.log('[PioneerSocket] namespace connected — authenticating')
      this.send(`42["authenticate",${JSON.stringify({ queryKey: this.opts.queryKey })}]`)
      return
    }

    // SIO EVENT ("42[...]")
    if (sio[0] === '2') {
      try {
        const parsed = JSON.parse(sio.slice(1))
        if (!Array.isArray(parsed) || parsed.length < 1) return
        const [eventName, data] = parsed as [string, unknown]

        if (eventName === 'authenticated') {
          const d = data as any
          console.log('[PioneerSocket] authenticated as', d?.username)
          this.reconnectDelay = RECONNECT_BASE_MS // reset backoff on success
          this.opts.onConnect?.()
          return
        }

        this.opts.onEvent(eventName, data)
      } catch { /* malformed frame — ignore */ }
    }
  }

  private send(msg: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg)
  }

  private scheduleReconnect() {
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
        this.connect()
      }
    }, this.reconnectDelay)
  }
}
