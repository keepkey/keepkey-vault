/**
 * SSE-based real-time transaction event streaming.
 *
 * Opens a single persistent SSE connection to pioneer-server with all
 * currently-watched addresses. Reconnects automatically on drop.
 * Closes immediately on stopEventStream().
 *
 * No xpubs — UTXO chains are handled by the watchtower sync worker
 * server-side. Only individual addresses (EVM, Cosmos, XRP, Solana, etc.)
 * are subscribed here.
 */

import { getPioneerApiBase, getQueryKey } from './pioneer'

export interface TxIncomingEvent {
  address: string
  networkId: string
  caip: string
  txid: string
  value: string
  from?: string
  type: 'incoming' | 'outgoing'
}

export type StreamEvent =
  | { type: 'tx:incoming';   data: TxIncomingEvent }
  | { type: 'tx:confirmed';  data: { address: string; networkId: string; txid: string; confirmations: number } }
  | { type: 'block:height';  data: { networkId: string; symbol: string; height: number } }
  | { type: 'connected';     data: { sessionId: string; watching: number } }

export interface AddressEntry { address: string; networkId: string }

type EventHandler = (event: StreamEvent) => void
type StatusHandler = (status: { connected: boolean; watching: number; sessionId?: string }) => void

// Exponential backoff: 10s → doubles each failure → 5-min hard cap.
// 404 skips straight to 60s (endpoint absent during blue/green deploy is not transient).
// Jitter ±10% spreads thundering-herd across a fleet of concurrent retries.
const RECONNECT_BASE_MS = 10_000
const RECONNECT_MAX_MS  = 300_000 // 5 min — covers any realistic blue/green window
const RECONNECT_404_MS  = 60_000  // start here on 404 — the route is gone, not glitching
const SUBSCRIBE_URL_PATH = '/api/v1/events/subscribe'

let controller: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentAddresses: AddressEntry[] = []
let currentHandler: EventHandler | null = null
let onStatusChange: StatusHandler | null = null
let reconnectDelay = RECONNECT_BASE_MS
let consecutiveFailures = 0

export function startEventStream(
  addresses: AddressEntry[],
  onEvent: EventHandler,
  onStatus?: StatusHandler,
): void {
  stopEventStream()
  onStatusChange = onStatus ?? null

  if (!addresses.length) return

  currentAddresses = addresses
  currentHandler = onEvent
  controller = new AbortController()
  reconnectDelay = RECONNECT_BASE_MS
  consecutiveFailures = 0

  connect()
}

export function stopEventStream(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (controller) { controller.abort(); controller = null }
  currentAddresses = []
  currentHandler = null
  onStatusChange?.({ connected: false, watching: 0 })
  onStatusChange = null
}

async function connect(): Promise<void> {
  if (!controller || !currentHandler) return

  const base = getPioneerApiBase()
  const url = `${base}${SUBSCRIBE_URL_PATH}`
  const signal = controller.signal

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'x-api-key': getQueryKey(),
      },
      body: JSON.stringify({
        addresses: currentAddresses,
        events: ['tx:incoming', 'tx:confirmed'],
      }),
      signal,
    })

    if (!resp.ok) {
      consecutiveFailures++
      // 404 = endpoint absent (blue/green gap, version mismatch) — jump to longer tier immediately
      if (resp.status === 404) reconnectDelay = Math.max(reconnectDelay, RECONNECT_404_MS)
      // Only log on first failure then every power-of-2 to avoid log spam
      if (consecutiveFailures === 1 || (consecutiveFailures & (consecutiveFailures - 1)) === 0) {
        console.warn(`[event-stream] Subscribe returned ${resp.status} — retrying in ${Math.round(reconnectDelay / 1000)}s (attempt ${consecutiveFailures})`)
      }
      onStatusChange?.({ connected: false, watching: 0 })
      scheduleReconnect()
      return
    }

    if (!resp.body) {
      consecutiveFailures++
      console.warn('[event-stream] No response body — retrying')
      onStatusChange?.({ connected: false, watching: 0 })
      scheduleReconnect()
      return
    }

    // Successful connection — reset backoff state
    reconnectDelay = RECONNECT_BASE_MS
    consecutiveFailures = 0
    console.log(`[event-stream] Connected — watching ${currentAddresses.length} addresses`)

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop()!

      for (const frame of frames) {
        if (!frame.trim() || frame.startsWith(':')) continue // heartbeat / comment

        const evLine = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim()
        const dataStr = frame.match(/^data:\s*(.+)$/m)?.[1]?.trim()
        if (!evLine || !dataStr) continue

        try {
          const data = JSON.parse(dataStr)
          if (evLine === 'connected') {
            onStatusChange?.({ connected: true, watching: data.watching ?? currentAddresses.length, sessionId: data.sessionId })
          }
          currentHandler?.({ type: evLine as any, data })
        } catch { /* malformed JSON — skip */ }
      }
    }

    // Stream ended normally — reconnect
    console.log('[event-stream] Stream closed, reconnecting...')
    onStatusChange?.({ connected: false, watching: 0 })
    scheduleReconnect()

  } catch (err: any) {
    if (err.name === 'AbortError') return // intentional close — do not reconnect
    consecutiveFailures++
    if (consecutiveFailures === 1 || (consecutiveFailures & (consecutiveFailures - 1)) === 0) {
      console.warn('[event-stream] Connection error:', err.message, `— retrying in ${Math.round(reconnectDelay / 1000)}s (attempt ${consecutiveFailures})`)
    }
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (!controller) return // already stopped
  if (reconnectTimer) clearTimeout(reconnectTimer)
  // Jitter ±10% to spread retries across concurrent clients
  const jitter = reconnectDelay * 0.1 * (Math.random() * 2 - 1)
  const delay = Math.max(RECONNECT_BASE_MS, Math.round(reconnectDelay + jitter))
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}
