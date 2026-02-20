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
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const messageListeners = new Map<string, Set<MessageListener>>()

let sendPacket: ((packet: RPCPacket) => void) | null = null

// Handle incoming packets from the Bun process
function handlePacket(packet: RPCPacket) {
  if (packet.type === 'response') {
    const pending = pendingRequests.get(packet.id)
    if (pending) {
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

// Initialize transport — connect to Electrobun's WebSocket or fall back
function initTransport() {
  const w = window as any

  // Check if Electrobun preload has injected globals
  if (w.__electrobunRpcSocketPort && w.__electrobunWebviewId) {
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

// Initialize on module load
initTransport()

/**
 * Make an RPC request to the Bun main process.
 */
export function rpcRequest<T = any>(method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!sendPacket) {
      reject(new Error(`RPC not available (no Electrobun transport) — cannot call ${method}`))
      return
    }

    const id = ++nextRequestId
    pendingRequests.set(id, { resolve, reject })

    // Timeout after 30s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        reject(new Error(`RPC request timed out: ${method}`))
      }
    }, 30000)

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
