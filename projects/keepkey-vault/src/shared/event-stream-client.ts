/** Connection-scoped SSE client. Obsolete readers cannot deliver into a newer
 * wallet/provider session or schedule its reconnect. */
export interface AddressEntry { address: string; networkId: string }
export interface StreamSessionOptions { walletScope?: string; since?: number }
export interface TxIncomingEvent {
  address: string; networkId: string; caip?: string; txid?: string; value?: string
  from?: string; type: 'incoming' | 'outgoing' | 'activity' | 'confirmation_update'; refreshHint?: boolean; cursor?: number
}
export type StreamEvent =
  | { type: 'tx:incoming'; data: TxIncomingEvent }
  | { type: 'tx:confirmed'; data: { address: string; networkId: string; txid?: string; confirmations?: number; cursor?: number; refreshHint?: boolean } }
  | { type: 'block:height'; data: { networkId: string; symbol: string; height: number } }
  | { type: 'connected'; data: { sessionId: string; watching: number; cursor?: number; transport?: string; unsupported?: string[] } }
  | { type: 'sync:required'; data: { refreshHint: true; cursor?: number; reason: 'subscribe' | 'upstream_reconnected' | 'new_block'; networkIds?: string[] } }
export type EventHandler = (event: StreamEvent) => void
export type StatusHandler = (status: { connected: boolean; watching: number; sessionId?: string; cursor?: number }) => void
const MAX_FRAME_CHARS = 262_144
const EVENT_NAMES = new Set(['tx:incoming', 'tx:confirmed', 'block:height', 'connected', 'sync:required'])
const BASE_DELAY = 10_000
type ConnectionStatus = Parameters<StatusHandler>[0]
interface Session {
  base: string; key: string; watchKey: string; addresses: AddressEntry[]
  onEvent: EventHandler; onStatus?: StatusHandler; controller: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>; cancelRetry?: () => void
  delay: number; cursor?: number; status: ConnectionStatus
  walletScope?: string
}
function watches(raw: AddressEntry[]): AddressEntry[] {
  const unique = new Map<string, AddressEntry>()
  for (const entry of raw) {
    const networkId = entry.networkId.trim(), address = entry.address.trim()
    if (!networkId || !address) continue
    const normalized = networkId.startsWith('eip155:') ? address.toLowerCase() : address
    const key = `${networkId}:${normalized}`
    if (!unique.has(key)) unique.set(key, { networkId, address: normalized })
  }
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry)
}
export function createEventStreamClient(options: {
  getBase: () => string; getQueryKey: () => string; fetch?: typeof fetch
  schedule?: (callback: () => void, delay: number) => () => void; random?: () => number
}) {
  let current: Session | null = null
  const fetcher = options.fetch || fetch
  const schedule = options.schedule || ((callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  })
  const isCurrent = (session: Session) => current === session && !session.controller.signal.aborted
  function status(session: Session, value: ConnectionStatus): void {
    if (!isCurrent(session)) return
    session.status = value
    session.onStatus?.(value)
  }
  function retry(session: Session): void {
    if (!isCurrent(session) || session.cancelRetry) return
    const jitter = 0.1 * ((options.random || Math.random)() * 2 - 1)
    session.cancelRetry = schedule(() => {
      session.cancelRetry = undefined
      if (isCurrent(session)) void connect(session)
    }, Math.max(BASE_DELAY, Math.round(session.delay * (1 + jitter))))
    session.delay = Math.min(300_000, session.delay * 2)
  }
  function dispatch(session: Session, frame: string): void {
    if (!isCurrent(session)) return
    let name = '', data = ''
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data += `${data ? '\n' : ''}${line.slice(5).replace(/^ /, '')}`
    }
    if (!EVENT_NAMES.has(name) || !data) return
    let parsed: any
    try { parsed = JSON.parse(data) } catch { return }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    if (Number.isSafeInteger(parsed.cursor) && parsed.cursor > 0) session.cursor = Math.max(session.cursor || 0, parsed.cursor)
    if (name === 'connected') status(session, { connected: true, watching: parsed.watching ?? session.addresses.length,
      sessionId: parsed.sessionId, ...(session.cursor ? { cursor: session.cursor } : {}) })
    if (isCurrent(session)) session.onEvent({ type: name, data: parsed } as StreamEvent)
  }
  async function connect(session: Session): Promise<void> {
    if (!isCurrent(session)) return
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetcher(`${session.base}/api/v1/events/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-api-key': session.key },
        body: JSON.stringify({ addresses: session.addresses, events: ['tx:incoming', 'tx:confirmed'],
          ...(session.walletScope ? { walletScope: session.walletScope } : {}),
          ...(session.cursor ? { since: session.cursor } : {}) }), signal: session.controller.signal,
      })
      if (!isCurrent(session)) { await response.body?.cancel().catch(() => {}); return }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 404) session.delay = Math.max(session.delay, 60_000)
        status(session, { connected: false, watching: 0 }); retry(session); return
      }
      const contentType = response.headers.get('content-type')
      if (contentType && !contentType.includes('text/event-stream')) {
        await response.body.cancel().catch(() => {})
        throw new Error('Unexpected subscription response type')
      }
      session.delay = BASE_DELAY
      reader = response.body.getReader(); session.reader = reader
      const decoder = new TextDecoder()
      let buffered = ''
      while (isCurrent(session)) {
        const { value, done } = await reader.read()
        if (!isCurrent(session)) return
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const frames = buffered.split(/\r?\n\r?\n/); buffered = frames.pop()!
        if (buffered.length > MAX_FRAME_CHARS) throw new Error('Subscription frame exceeds limit')
        for (const frame of frames) {
          if (frame.length > MAX_FRAME_CHARS) throw new Error('Subscription frame exceeds limit')
          dispatch(session, frame)
          if (!isCurrent(session)) return
        }
      }
      status(session, { connected: false, watching: 0 }); retry(session)
    } catch {
      if (!isCurrent(session)) return
      status(session, { connected: false, watching: 0 }); retry(session)
    } finally {
      if (session.reader === reader) session.reader = undefined
      if (reader) {
        await reader.cancel().catch(() => {})
        try { reader.releaseLock() } catch { /* stopped read still settling */ }
      }
    }
  }
  function stop(): void {
    const previous = current; current = null
    if (!previous) return
    previous.cancelRetry?.(); previous.controller.abort()
    void previous.reader?.cancel().catch(() => {})
    previous.onStatus?.({ connected: false, watching: 0 })
  }
  function start(addresses: AddressEntry[], onEvent: EventHandler, onStatus?: StatusHandler, sessionOptions: StreamSessionOptions = {}): void {
    const normalized = watches(addresses)
    if (!normalized.length) { stop(); return }
    const base = options.getBase().replace(/\/$/, ''), key = options.getQueryKey(), watchKey = JSON.stringify(normalized)
    if (current && current.base === base && current.key === key && current.watchKey === watchKey && current.walletScope === sessionOptions.walletScope) {
      current.onEvent = onEvent; current.onStatus = onStatus; onStatus?.(current.status); return
    }
    stop()
    const session: Session = { base, key, watchKey, addresses: normalized, onEvent, onStatus,
      controller: new AbortController(), delay: BASE_DELAY, status: { connected: false, watching: 0 }, walletScope: sessionOptions.walletScope,
      ...(Number.isSafeInteger(sessionOptions.since) && sessionOptions.since! > 0 ? { cursor: sessionOptions.since } : {}) }
    current = session; void connect(session)
  }
  return { start, stop }
}
