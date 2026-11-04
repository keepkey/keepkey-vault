export interface PioneerSocketOptions {
  queryKey: string
  onEvent: (event: string, data: unknown) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

/** Engine.IO 4 / Socket.IO default-namespace compatibility. Every callback is
 * bound to its originating socket, rather than whichever socket is current. */
export class PioneerSocketClient {
  private ws: WebSocket | null = null
  private stopped = true
  private generation = 0
  private reconnectDelay = 5_000
  private cancelRetry?: () => void
  private authenticated = false
  constructor(private readonly opts: PioneerSocketOptions, private readonly dependencies: {
    getBase: () => string
    createSocket?: (url: string) => WebSocket
    schedule?: (callback: () => void, delay: number) => () => void
  }) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.generation++
    this.reconnectDelay = 5_000
    this.connect(this.generation)
  }
  stop(): void {
    this.stopped = true
    this.generation++
    this.cancelRetry?.(); this.cancelRetry = undefined
    const old = this.ws, wasAuthenticated = this.authenticated
    this.ws = null; this.authenticated = false
    old?.close()
    if (wasAuthenticated) this.opts.onDisconnect?.()
  }
  private connect(generation: number): void {
    if (this.stopped || generation !== this.generation) return
    const base = this.dependencies.getBase().replace(/\/+$/, '')
    let socket: WebSocket
    try { socket = (this.dependencies.createSocket || (url => new WebSocket(url)))(base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket') }
    catch { this.retry(generation); return }
    this.ws = socket
    this.authenticated = false
    const active = () => !this.stopped && generation === this.generation && this.ws === socket
    const send = (value: string) => { if (active() && socket.readyState === 1) socket.send(value) }
    socket.onmessage = event => {
      if (!active()) return
      const raw = String(event.data)
      if (raw.length > 1_000_000) { socket.close(); return }
      if (raw[0] === '0') { send('40'); return }
      if (raw === '2') { send('3'); return }
      if (raw.startsWith('40')) { send('42'+JSON.stringify(['authenticate', { queryKey: this.opts.queryKey }])); return }
      if (!raw.startsWith('42')) return
      try {
        const parsed = JSON.parse(raw.slice(2))
        if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
        const [name, data] = parsed
        if (name === 'authenticated') {
          // Legacy Pioneer serializes the acknowledgement as a JSON string.
          const payload = typeof data === 'string' ? JSON.parse(data) : data
          if (payload?.success !== true) { this.authenticated = false; socket.close(); return }
          if (!this.authenticated) {
            this.authenticated = true
            this.reconnectDelay = 5_000
            this.opts.onConnect?.()
          }
          return
        }
        if (active() && this.authenticated) this.opts.onEvent(name, data)
      } catch { /* malformed frames do not authenticate or dispatch */ }
    }
    socket.onclose = () => {
      if (!active()) return
      const wasAuthenticated = this.authenticated
      this.ws = null; this.authenticated = false
      if (wasAuthenticated) this.opts.onDisconnect?.()
      this.retry(generation)
    }
    socket.onerror = () => { /* onclose owns retry */ }
  }
  private retry(generation: number): void {
    if (this.stopped || generation !== this.generation || this.cancelRetry) return
    const schedule = this.dependencies.schedule || ((callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    })
    this.cancelRetry = schedule(() => {
      this.cancelRetry = undefined
      if (this.stopped || generation !== this.generation) return
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
      this.connect(generation)
    }, this.reconnectDelay)
  }
}
