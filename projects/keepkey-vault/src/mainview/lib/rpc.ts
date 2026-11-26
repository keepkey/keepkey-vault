/**
 * Browser-side RPC client for communicating with the Bun main process.
 *
 * This is a lightweight implementation of Electrobun's RPC protocol that
 * works within Vite-bundled code without needing to import electrobun/view
 * (which requires Electrobun's preload globals).
 *
 * When Electrobun preload is available, it uses the encrypted WebSocket transport.
 * In dev/HMR mode without Electrobun, it falls back to a no-op stub so the UI renders.
 */
import { retryWhileDeviceBusy, withUnlockRetry } from '../../shared/device-access-error'
import { dispatchBackendSettingsChanged } from './app-settings-loader'

type RPCPacket =
  | { type: 'request'; id: number; method: string; params: any }
  | { type: 'response'; id: number; success: true; payload: any }
  | { type: 'response'; id: number; success: false; error?: string }
  | { type: 'message'; id: string; payload: any }

type MessageListener = (payload: any) => void

let nextRequestId = 0
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const messageListeners = new Map<string, Set<MessageListener>>()

let sendPacket: ((packet: RPCPacket) => void) | null = null
let reconnectAttempts = 0
// After a reconnect the settings readers re-read: a push sent while the socket was down was lost (audit v6 H10).
let connectedOnce = false
const MAX_RECONNECT_DELAY = 10000
const MAX_RECONNECT_ATTEMPTS = 50

/** Electrobun serializes a thrown value's `.message` verbatim, and hdwallet
 *  failures carry a decoded protobuf Failure OBJECT there ({code, message}).
 *  Normalize to the human string ("Action cancelled") instead of letting
 *  "[object Object]" reach an error banner. */
function rpcErrorText(e: unknown): string {
  if (typeof e === 'string') return e || 'RPC request failed'
  const m = (e as any)?.message
  if (typeof m === 'string') return m || 'RPC request failed'
  if (e == null) return 'RPC request failed'
  console.error('[rpc] non-string error payload:', e)
  try { return JSON.stringify(e) } catch { return String(e) }
}

// Handle incoming packets from the Bun process
function handlePacket(packet: RPCPacket) {
  if (packet.type === 'response') {
    const pending = pendingRequests.get(packet.id)
    if (pending) {
      clearTimeout(pending.timer)
      pendingRequests.delete(packet.id)
      if (packet.success) {
        pending.resolve(packet.payload)
      } else {
        pending.reject(new Error(rpcErrorText(packet.error)))
      }
    }
    return
  }

  if (packet.type === 'message') {
    const listeners = messageListeners.get(packet.id)
    if (listeners) {
      for (const listener of listeners) {
        listener(packet.payload)
      }
    }
    return
  }
}

/** Reject all pending requests (called on socket close/error) */
function rejectAllPending(reason: string) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
  }
  pendingRequests.clear()
}

/** Electrobun 2.x delivers Bun's replies by calling receiveMessageFromHost in
 *  the page (on Windows, every reply arrives this way, never on the socket).
 *  Until a receiver is registered, the preload queues them in
 *  __electrobunPendingHostMessages. Register both the 2.x and 1.x names,
 *  whatever transport sends, then drain the queue. */
function registerHostReceiver(w: any) {
  w.__electrobun = w.__electrobun || {}
  const receive = (msg: any) => {
    try {
      handlePacket(typeof msg === 'string' ? JSON.parse(msg) : msg)
    } catch (err) {
      console.error('[rpc] Failed to handle host message:', err)
    }
  }
  w.__electrobun.receiveMessageFromHost = receive
  w.__electrobun.receiveMessageFromBun = receive
  const queued = w.__electrobunPendingHostMessages
  if (Array.isArray(queued) && queued.length) {
    w.__electrobunPendingHostMessages = []
    for (const msg of queued) receive(msg)
  }
}

// Initialize transport — connect to Electrobun's WebSocket or fall back
function initTransport() {
  const w = window as any

  // Check if Electrobun preload has injected globals
  if ((w.__electrobunHostSocketPort ?? w.__electrobunRpcSocketPort) && w.__electrobunWebviewId) {
    registerHostReceiver(w)
    connectWebSocket(w)
  } else if (w.__electrobunBunBridge) {
    // Fallback: postMessage bridge (used when socket unavailable)
    registerHostReceiver(w)

    sendPacket = (packet: RPCPacket) => {
      w.__electrobunBunBridge?.postMessage(JSON.stringify(packet))
    }
  } else {
    // Dev mode without Electrobun — stub everything
    console.warn('[rpc] Electrobun not available — RPC calls will be stubbed')
    sendPacket = null
  }
}

function connectWebSocket(w: any) {
  const port = w.__electrobunHostSocketPort ?? w.__electrobunRpcSocketPort
  const webviewId = w.__electrobunWebviewId

  // 127.0.0.1, as Electrobun's own client: "localhost" can resolve to ::1 first.
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket?webviewId=${webviewId}`)

  socket.addEventListener('message', async (event) => {
    try {
      const data = typeof event.data === 'string' ? event.data : await event.data.text()
      const parsed = JSON.parse(data)

      // If encrypted, decrypt first
      if (parsed.encryptedData && w.__electrobun_decrypt) {
        const decrypted = await w.__electrobun_decrypt(parsed.encryptedData, parsed.iv, parsed.tag)
        handlePacket(JSON.parse(decrypted))
      } else {
        handlePacket(parsed)
      }
    } catch (err) {
      console.error('[rpc] Failed to parse message:', err)
    }
  })

  socket.addEventListener('open', () => {
    console.log('[rpc] Connected to Bun via WebSocket')
    reconnectAttempts = 0
    if (connectedOnce) dispatchBackendSettingsChanged('reconnect')
    connectedOnce = true
  })

  socket.addEventListener('close', () => {
    console.warn('[rpc] WebSocket closed — rejecting pending requests')
    sendPacket = null
    rejectAllPending('WebSocket connection closed')
    scheduleReconnect(w)
  })

  socket.addEventListener('error', (err) => {
    console.error('[rpc] WebSocket error:', err)
    // 'close' event will fire after 'error', so reconnect is handled there
  })

  sendPacket = async (packet: RPCPacket) => {
    // A reconnecting socket holds the packet until it opens: a dropped sign
    // request (no timeout) or Cancel would vanish. If it closes instead, the
    // close handler rejects the pending request.
    if (socket.readyState === WebSocket.CONNECTING) {
      await new Promise(resolve => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('close', resolve, { once: true })
      })
    }
    if (socket.readyState !== WebSocket.OPEN) {
      console.warn('[rpc] Socket not open, dropping packet')
      return
    }

    const json = JSON.stringify(packet)

    // If encryption is available, encrypt
    if (w.__electrobun_encrypt) {
      try {
        const { encryptedData, iv, tag } = await w.__electrobun_encrypt(json)
        socket.send(JSON.stringify({ encryptedData, iv, tag }))
        return
      } catch {
        // Fall through to unencrypted
      }
    }

    socket.send(json)
  }
}

function scheduleReconnect(w: any) {
  reconnectAttempts++
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`[rpc] Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`)
    return
  }
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY)
  console.log(`[rpc] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
  setTimeout(() => connectWebSocket(w), delay)
}

// Initialize on module load
initTransport()

/**
 * Make an RPC request to the Bun main process.
 * @param method - RPC method name
 * @param params - Optional parameters
 * @param timeoutMs - Timeout in ms (default 30s). Pass 0 for no timeout (device-interactive ops).
 */
/** A read refused because the KeepKey is locked opens the PIN dialog and runs again
 *  once unlocked, so "Unlock KeepKey to load this account" is never shown.
 *  A request refused because the KeepKey is busy waits for it and runs again, so
 *  "KeepKey is busy with another request" is never shown. The wait ends (and the
 *  busy error is thrown) once isCurrent() is false: closed dialog, Cancel, stale inputs. */
export function rpcRequest<T = any>(method: string, params?: any, timeoutMs = 30000, isCurrent: () => boolean = () => true, onBusy?: () => void): Promise<T> {
  const run = () => retryWhileDeviceBusy(() => rawRpcRequest<T>(method, params, timeoutMs), isCurrent, 500, onBusy)
  if (method === 'requestDeviceUnlock') return run()
  return withUnlockRetry(run, () => rawRpcRequest<void>('requestDeviceUnlock', undefined, 0))
}

function rawRpcRequest<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!sendPacket) {
      reject(new Error(`RPC not available (no Electrobun transport) — cannot call ${method}`))
      return
    }

    const id = ++nextRequestId

    // timeoutMs === 0 means no timeout (user-interactive operations like firmware flash)
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id)
            reject(new Error(`RPC request timed out: ${method}`))
          }
        }, timeoutMs)
      : (undefined as any as ReturnType<typeof setTimeout>)

    pendingRequests.set(id, { resolve, reject, timer })

    sendPacket({ type: 'request', id, method, params })
  })
}

/**
 * Listen for messages from the Bun main process.
 */
/**
 * Fire-and-forget RPC call — sends the packet but never registers a pending
 * request. Used during drag/resize mousemove where latency matters and we
 * don't need a response.
 */
export function rpcFire(method: string, params?: any): void {
  if (!sendPacket) return
  sendPacket({ type: 'request', id: ++nextRequestId, method, params })
}

/**
 * Re-emit a message locally to all subscribers of `messageName`. Used when one
 * UI component receives a Bun message and needs to forward it to a sibling
 * component that has just mounted (e.g. SwapRpcMount opens a dialog and needs
 * the dialog's listener — registered after mount — to also see the original
 * payload).
 */
export function dispatchLocalRpcMessage(messageName: string, payload: any): void {
  const listeners = messageListeners.get(messageName)
  if (!listeners) return
  for (const listener of listeners) listener(payload)
}

/**
 * Listen for messages from the Bun main process.
 */
export function onRpcMessage(messageName: string, listener: MessageListener): () => void {
  if (!messageListeners.has(messageName)) {
    messageListeners.set(messageName, new Set())
  }
  messageListeners.get(messageName)!.add(listener)

  return () => {
    messageListeners.get(messageName)?.delete(listener)
  }
}
