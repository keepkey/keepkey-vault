/**
 * bex-bridge — the vault side of the MCP agent bridge (EPIC_mcp_agent_bridge.md).
 *
 * The KeepKey browser extension (BEX) background service worker connects ONE
 * outbound WebSocket here (ws://localhost:1646/bex-bridge, authenticated with
 * its existing pairing key). MCP tool calls arriving at POST /mcp are forwarded
 * over this socket as {id, tool, args} and the BEX answers {id, result|error}.
 *
 * Module-singleton style, matching event-stream.ts.
 */

type BridgeSocket = { send(data: string): void; close(): void }

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (err: BridgeError) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BridgeError {
  code: string
  message: string
}

const CALL_TIMEOUT_MS = 30_000 // BEX may need to wake its service worker + hit the wallet

let sock: BridgeSocket | null = null
let connectedAt: number | null = null
const pending = new Map<string, PendingCall>()

export function bridgeConnected(): boolean {
  return sock !== null
}

export function bridgeStatus(): { connected: boolean; connectedAt: number | null } {
  return { connected: sock !== null, connectedAt }
}

export function onBexOpen(ws: BridgeSocket): void {
  // Single BEX per vault: a new connection replaces the old (SW restart case).
  if (sock && sock !== ws) {
    try { sock.close() } catch { /* already gone */ }
    // Fail calls still outstanding on the replaced socket NOW — the old
    // socket's close event hits the `sock !== ws` guard in onBexClose and
    // returns without failing them, so otherwise they'd hang out their full
    // 30s timeout on a socket that can never answer.
    failAllPending({ code: 'bridge_disconnected', message: 'BEX reconnected — replacing socket' })
  }
  sock = ws
  connectedAt = Date.now()
  console.log('[BEX-BRIDGE] extension connected')
}

export function onBexClose(ws: BridgeSocket): void {
  if (sock !== ws) return // stale socket we already replaced
  sock = null
  connectedAt = null
  failAllPending({ code: 'bridge_disconnected', message: 'BEX disconnected mid-call' })
  console.log('[BEX-BRIDGE] extension disconnected')
}

export function onBexMessage(_ws: BridgeSocket, raw: string | Buffer): void {
  let msg: any
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return // malformed frame — ignore
  }
  const entry = msg?.id ? pending.get(msg.id) : undefined
  if (!entry) return
  pending.delete(msg.id)
  clearTimeout(entry.timer)
  if (msg.error) entry.reject({ code: msg.error.code || 'bex_error', message: msg.error.message || 'BEX error' })
  else entry.resolve(msg.result)
}

/** Forward one tool call to the BEX. Rejects with a structured BridgeError — never hangs. */
export function callBex(tool: string, args: unknown): Promise<unknown> {
  if (!sock) {
    return Promise.reject<unknown>({
      code: 'bridge_disconnected',
      message: 'KeepKey extension is not connected to the vault bridge (is the BEX running with Agent mode enabled?)',
    } satisfies BridgeError)
  }
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject({ code: 'bridge_timeout', message: `BEX did not answer ${tool} within ${CALL_TIMEOUT_MS}ms` })
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      sock!.send(JSON.stringify({ id, tool, args: args ?? {} }))
    } catch (e: any) {
      pending.delete(id)
      clearTimeout(timer)
      reject({ code: 'bridge_disconnected', message: `send failed: ${e?.message || e}` })
    }
  })
}

function failAllPending(err: BridgeError): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(err)
  }
  pending.clear()
}
