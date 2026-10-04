/**
 * bex-bridge — the vault side of the MCP agent bridge (EPIC_mcp_agent_bridge.md).
 *
 * Each KeepKey browser extension (BEX) instance — one per Chrome profile that
 * has Agent mode on — connects an outbound WebSocket here
 * (ws://localhost:1646/bex-bridge, authenticated with its pairing key). MCP tool
 * calls arriving at POST /mcp are forwarded to ONE instance as {id, tool, args}
 * and it answers {id, result|error}.
 *
 * MULTI-CLIENT: every connected instance is a "browser" with a vault-assigned
 * id (b1-<run>, …). A call names its target with `browser`; with exactly one
 * connected it may be omitted. With several connected and none named, the call
 * is REFUSED (browser_ambiguous) — never routed to an arbitrary instance, since
 * that would silently send a signing request to a nondeterministically chosen
 * wallet (the bug the old single-slot eviction caused).
 *
 * Ids carry a per-run suffix, so one learned before a vault restart fails with
 * unknown_browser instead of reaching whichever profile reconnected first.
 *
 * ponytail: ids are per connection, so an MV3 service-worker restart gives that
 * profile a new id. If agents need ids that survive restarts, have the BEX send
 * a persisted instance id on connect and key clients on it.
 *
 * Module-singleton style, matching event-stream.ts.
 */

type BridgeSocket = { send(data: string): void; close(code?: number, reason?: string): void }

type PendingCall = {
  ws: BridgeSocket
  resolve: (value: unknown) => void
  reject: (err: BridgeError) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BridgeError {
  code: string
  message: string
}

export interface BrowserInfo {
  browser: string
  connectedAt: number
  lastSeenAt: number
}

const CALL_TIMEOUT_MS = 30_000 // BEX may need to wake its service worker + hit the wallet

/**
 * A client silent this long is treated as dead (SW restart whose close frame
 * never arrived) and dropped, so a ghost never makes routing ambiguous. Must
 * stay comfortably above the BEX heartbeat (20s, mcpBridge.ts HEARTBEAT_MS).
 */
const STALE_MS = 45_000

type Client = BrowserInfo & { ws: BridgeSocket }

const clients = new Map<BridgeSocket, Client>()
const pending = new Map<string, PendingCall>()
let nextId = 1
const RUN = crypto.randomUUID().slice(0, 6) // ids never repeat across vault runs

/** Live clients, oldest first. Drops any that have gone silent. */
function liveClients(): Client[] {
  const now = Date.now()
  for (const c of [...clients.values()]) {
    if (now - c.lastSeenAt >= STALE_MS) {
      try { c.ws.close() } catch { /* already gone */ }
      drop(c.ws, 'BEX went silent — dropped as stale')
    }
  }
  return [...clients.values()]
}

export function listBrowsers(): BrowserInfo[] {
  return liveClients().map(({ browser, connectedAt, lastSeenAt }) => ({ browser, connectedAt, lastSeenAt }))
}

export function bridgeConnected(): boolean {
  return liveClients().length > 0
}

export function bridgeStatus(): { connected: boolean; connectedAt: number | null; browsers: string[] } {
  const live = liveClients()
  return {
    connected: live.length > 0,
    connectedAt: live.length ? live[live.length - 1].connectedAt : null,
    browsers: live.map(c => c.browser),
  }
}

export function onBexOpen(ws: BridgeSocket): void {
  const now = Date.now()
  const browser = `b${nextId++}-${RUN}`
  clients.set(ws, { ws, browser, connectedAt: now, lastSeenAt: now })
  console.log(`[BEX-BRIDGE] extension connected as ${browser} (${clients.size} connected)`)
}

export function onBexClose(ws: BridgeSocket): void {
  const c = clients.get(ws)
  if (!c) return // already dropped as stale
  drop(ws, 'BEX disconnected mid-call')
  console.log(`[BEX-BRIDGE] ${c.browser} disconnected (${clients.size} connected)`)
}

export function onBexMessage(ws: BridgeSocket, raw: string | Buffer): void {
  // Any frame is proof of life, heartbeat pings included — they carry no id and
  // fall out below, but they still keep the client fresh.
  const c = clients.get(ws)
  if (c) c.lastSeenAt = Date.now()
  let msg: any
  try {
    msg = JSON.parse(String(raw))
  } catch {
    return // malformed frame — ignore
  }
  const entry = msg?.id ? pending.get(msg.id) : undefined
  if (!entry || entry.ws !== ws) return // only the instance we asked may answer
  pending.delete(msg.id)
  clearTimeout(entry.timer)
  if (msg.error) entry.reject({ code: msg.error.code || 'bex_error', message: msg.error.message || 'BEX error' })
  else entry.resolve(msg.result)
}

/** Pick the target instance, or explain why none can be chosen. */
function resolveClient(browser?: string): Client | BridgeError {
  const live = liveClients()
  if (!live.length) {
    return {
      code: 'bridge_disconnected',
      message: 'KeepKey extension is not connected to the vault bridge (is the BEX running with Agent mode enabled?)',
    }
  }
  const ids = live.map(c => c.browser).join(', ')
  if (browser) {
    return live.find(c => c.browser === browser)
      ?? { code: 'unknown_browser', message: `No connected KeepKey browser "${browser}". Connected: ${ids}. Call bex_browsers.` }
  }
  if (live.length > 1) {
    return {
      code: 'browser_ambiguous',
      message: `${live.length} KeepKey browsers are connected (${ids}). Pass "browser" to choose one — call bex_browsers to tell them apart.`,
    }
  }
  return live[0]
}

/** Forward one tool call to a BEX instance. Rejects with a structured BridgeError — never hangs. */
export function callBex(tool: string, args: unknown, browser?: string, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  const target = resolveClient(browser)
  if (!('ws' in target)) return Promise.reject<unknown>(target)
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject({ code: 'bridge_timeout', message: `BEX ${target.browser} did not answer ${tool} within ${timeoutMs}ms` })
    }, timeoutMs)
    pending.set(id, { ws: target.ws, resolve, reject, timer })
    try {
      target.ws.send(JSON.stringify({ id, tool, args: args ?? {} }))
    } catch (e: any) {
      pending.delete(id)
      clearTimeout(timer)
      reject({ code: 'bridge_disconnected', message: `send failed: ${e?.message || e}` })
    }
  })
}

/** Forget a client and fail ITS in-flight calls now, not after the 30s timeout. */
function drop(ws: BridgeSocket, message: string): void {
  clients.delete(ws)
  for (const [id, entry] of pending) {
    if (entry.ws !== ws) continue
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject({ code: 'bridge_disconnected', message })
  }
}
