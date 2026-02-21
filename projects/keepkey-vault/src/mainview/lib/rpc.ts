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
const MAX_RECONNECT_DELAY = 10000

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
        pending.reject(new Error(packet.error || 'RPC request failed'))
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

// Initialize transport — connect to Electrobun's WebSocket or fall back
function initTransport() {
  const w = window as any

  // Check if Electrobun preload has injected globals
  if (w.__electrobunRpcSocketPort && w.__electrobunWebviewId) {
    connectWebSocket(w)
  } else if (w.__electrobunBunBridge) {
    // Fallback: postMessage bridge (used when socket unavailable)
    w.__electrobun = w.__electrobun || {}
    w.__electrobun.receiveMessageFromBun = (msg: any) => {
      handlePacket(msg)
    }

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
  const port = w.__electrobunRpcSocketPort
  const webviewId = w.__electrobunWebviewId

  const socket = new WebSocket(`ws://localhost:${port}/socket?webviewId=${webviewId}`)

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
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY)
  console.log(`[rpc] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`)
  setTimeout(() => connectWebSocket(w), delay)
}

// Initialize on module load
initTransport()

/**
 * Make an RPC request to the Bun main process.
 * @param method - RPC method name
 * @param params - Optional parameters
 * @param timeoutMs - Timeout in ms (default 30s, use longer for device-interactive ops)
 */
export function rpcRequest<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!sendPacket) {
      reject(new Error(`RPC not available (no Electrobun transport) — cannot call ${method}`))
      return
    }

    const id = ++nextRequestId

    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        reject(new Error(`RPC request timed out: ${method}`))
      }
    }, timeoutMs)

    pendingRequests.set(id, { resolve, reject, timer })

    sendPacket({ type: 'request', id, method, params })
  })
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
