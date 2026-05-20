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

import { getPioneerApiBase, QUERY_KEY } from './pioneer'

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

const RECONNECT_DELAY_MS = 10_000
const SUBSCRIBE_URL_PATH = '/api/v1/events/subscribe'

let controller: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let currentAddresses: AddressEntry[] = []
let currentHandler: EventHandler | null = null
let onStatusChange: StatusHandler | null = null

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
        'x-api-key': QUERY_KEY,
      },
      body: JSON.stringify({
        addresses: currentAddresses,
        events: ['tx:incoming', 'tx:confirmed'],
      }),
      signal,
    })

    if (!resp.ok) {
      console.warn(`[event-stream] Subscribe returned ${resp.status} — retrying in ${RECONNECT_DELAY_MS / 1000}s`)
      onStatusChange?.({ connected: false, watching: 0 })
      scheduleReconnect()
      return
    }

    if (!resp.body) {
      console.warn('[event-stream] No response body — retrying')
      onStatusChange?.({ connected: false, watching: 0 })
      scheduleReconnect()
      return
    }

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
    console.warn('[event-stream] Connection error:', err.message, `— retrying in ${RECONNECT_DELAY_MS / 1000}s`)
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (!controller) return // already stopped
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, RECONNECT_DELAY_MS)
}
