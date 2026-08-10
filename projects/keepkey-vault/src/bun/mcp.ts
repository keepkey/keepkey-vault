/**
 * mcp — MCP server endpoint (Streamable HTTP, POST /mcp) for the agent bridge.
 * See EPIC_mcp_agent_bridge.md (keepkey-client repo).
 *
 * Agents connect with a pairing bearer token (same API keys as the REST API):
 *   claude mcp add keepkey --transport http http://localhost:1646/mcp \
 *     --header "Authorization: Bearer <pairing-key>"
 *
 * ponytail: hand-rolled JSON-RPC instead of @modelcontextprotocol/sdk — the
 * surface we serve is initialize/ping/tools/list/tools/call with plain JSON
 * responses (no SSE stream, no sessions; both optional per spec). Swap in the
 * SDK if we ever need notifications/resources.
 *
 * All tools execute inside the BEX, and the BEX also owns the CATALOG: this
 * file is a dumb pipe that serves whatever bex_list_tools reports and passes
 * tool content straight through. A new BEX tool therefore ships without a vault
 * release. Bridge down → structured bridge_disconnected error, and tools/list
 * serves FALLBACK_TOOLS (bex_status instead answers truthfully so agents can
 * always probe).
 *
 * AUTH: /mcp requires a valid pairing bearer token — the SAME API keys as the
 * rest of the REST API (auth.requireAuth in rest-api's /mcp block). A local
 * process without a paired key cannot read wallet data. Defense in depth:
 * browsers are also excluded at the transport layer (Origin/Sec-Fetch reject),
 * since vault-served content at http://localhost:1646 could otherwise hold the
 * user's token. The BEX 'Agent mode' toggle (default off) remains the gate for
 * the tools actually returning data. Tools are Tier-1 READ-ONLY (no signing).
 */

import { callBex, bridgeStatus, type BridgeError } from './bex-bridge'

// Default to 2025-06-18, which REMOVED JSON-RPC batching — so advertising it
// while this (deliberately single-request) server rejects batches is honest.
const PROTOCOL_VERSION = '2025-06-18'
// Versions whose initialize/ping/tools surface this server is compatible with.
// We echo the client's requested version when it's one of these (MCP
// negotiation), else offer ours.
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])

// FALLBACK ONLY — not the source of truth. The BEX owns the catalog and
// answers bex_list_tools; these five tier-1 entries are served by tools/list
// only when the bridge is down, so `claude mcp add` still succeeds and the
// agent can reach bex_status to find out why. Do NOT add tools here: a new tool
// belongs in the BEX alone (HANDOFF_vault_mcp_dumb_pipe.md, keepkey-client).
const FALLBACK_TOOLS = [
  {
    name: 'bex_status',
    description:
      'KeepKey extension health: extension version, device/vault connection state, active EVM network, bridge status. Works even when the extension bridge is down (reports bridge: "down").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bex_accounts',
    description:
      'Per-chain accounts exactly as the extension returns them to dApps via request_accounts — raw shape preserved (string vs array), plus the underlying pubkey/xpub cache entries.',
    inputSchema: {
      type: 'object',
      properties: {
        chains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chains to query (e.g. ["ethereum","bitcoin","thorchain"]). Default: all supported.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bex_pending_requests',
    description: 'The extension approval queue: requests waiting for user (or agent, Phase 2) approval in the side panel.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bex_connected_sites',
    description: 'Origins that have made provider requests through the extension, with the chains each has touched.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bex_logs',
    description:
      'Structured provider request/response log from the extension background (every injected request, its result or error code). Ring buffer, newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex filter over method/origin/error' },
        since: { type: 'number', description: 'Only entries with timestamp >= this (ms epoch)' },
        limit: { type: 'number', description: 'Max entries returned (default 100)' },
      },
      additionalProperties: false,
    },
  },
]

const json = (body: unknown, status = 200, cors: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } })

const rpcError = (id: unknown, code: number, message: string, data?: unknown, cors: Record<string, string> = {}) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }, 200, cors)

const rpcResult = (id: unknown, result: unknown, cors: Record<string, string> = {}) =>
  json({ jsonrpc: '2.0', id: id ?? null, result }, 200, cors)

// ── Promote the browser while the agent drives it ───────────────────────────
// Acting tools work in the user's real Chrome, which is usually buried behind
// other windows — bring it to the front so the user can WATCH the agent work
// instead of hunting for the window. This lives vault-side on purpose: macOS
// cooperative activation lets one app raise ANOTHER app reliably (`open -b`,
// no TCC/automation prompt), while an app raising itself from a background
// context is focus-throttled. The extension handles which window/tab within
// Chrome; we handle Chrome itself.
const PROMOTE_BROWSER = true // in-code kill switch
// Acting tools only — reads (snapshot/find/read_page/status/logs/…) stay
// silent so agent observation never yanks the user's focus.
const PROMOTE_TOOLS = new Set(['bex_navigate', 'bex_click', 'bex_type', 'bex_select', 'bex_screenshot'])
const PROMOTE_TAB_ACTIONS = new Set(['create', 'select', 'new-window'])
// One promote per burst: re-raising on every click would fight a user who
// deliberately switched away mid-run.
const PROMOTE_DEBOUNCE_MS = 30_000
let lastPromoteAt = 0

function shouldPromote(name: string, args: any): boolean {
  if (!PROMOTE_BROWSER) return false
  if (PROMOTE_TOOLS.has(name)) return true
  return name === 'bex_tabs' && PROMOTE_TAB_ACTIONS.has(args?.action)
}

function promoteBrowser(): void {
  if (process.platform !== 'darwin') return // ponytail: mac only; a Windows raise needs launcher help
  if (process.env.NODE_ENV === 'test') return // bun test sets this; tests fake an open bridge
  if (!bridgeStatus().connected) return // bridge down may mean no Chrome — `open` would LAUNCH it
  const now = Date.now()
  if (now - lastPromoteAt < PROMOTE_DEBOUNCE_MS) return
  lastPromoteAt = now
  try {
    // ponytail: assumes Chrome by bundle id. If Brave/Edge users appear, sniff
    // the bridge websocket's User-Agent instead of guessing harder.
    Bun.spawn(['open', '-b', 'com.google.Chrome'], { stdout: 'ignore', stderr: 'ignore' })
  } catch {
    // Promotion is a courtesy; never let it fail a tool call.
  }
}

/** Handle POST /mcp. Caller has already enforced loopback-only. */
export async function handleMcpRequest(req: Request, cors: Record<string, string>): Promise<Response> {
  // Validate the negotiated protocol version header when present (the spec says
  // to reject an unsupported one, not ignore it). Absent is fine — the version
  // is negotiated in the initialize body.
  const hdrVersion = req.headers.get('mcp-protocol-version')
  if (hdrVersion && !SUPPORTED_PROTOCOL_VERSIONS.has(hdrVersion)) {
    return rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${hdrVersion}`, undefined, cors)
  }

  let msg: any
  try {
    msg = await req.json()
  } catch {
    return rpcError(null, -32700, 'Parse error', undefined, cors)
  }
  // Batching was removed in 2025-06-18 (the version we advertise); reject it
  // explicitly rather than silently mishandling it.
  if (Array.isArray(msg)) return rpcError(null, -32600, 'batch requests are not supported', undefined, cors)

  // Every Request/Notification object must declare jsonrpc "2.0" — reject 1.0
  // or a missing version rather than processing it.
  if (!msg || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"', undefined, cors)
  }

  const { id, method, params } = msg

  if (typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid Request: missing method', undefined, cors)
  }
  // A notification — a notifications/* method, or any request with no id —
  // gets an empty 202 and no JSON-RPC body, per the Streamable HTTP spec.
  if (method.startsWith('notifications/') || id === undefined) {
    return new Response(null, { status: 202, headers: cors })
  }

  switch (method) {
    case 'initialize': {
      // Echo the client's requested version when we support it, else offer ours.
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null
      return rpcResult(id, {
        protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'keepkey-vault', version: '1.0.0' },
      }, cors)
    }

    case 'ping':
      return rpcResult(id, {}, cors)

    case 'tools/list': {
      // The BEX owns its catalog; we serve whatever it reports. This is what
      // keeps a new tool a one-repo change.
      try {
        const { tools } = (await callBex('bex_list_tools', {})) as { tools: unknown[] }
        return rpcResult(id, { tools }, cors)
      } catch {
        // Bridge down (BEX closed, or Agent mode off) — serve the static
        // fallback so tools/list still succeeds. Note: a connected-but-
        // unresponsive BEX costs the full CALL_TIMEOUT_MS before landing here.
        return rpcResult(id, { tools: FALLBACK_TOOLS }, cors)
      }
    }

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      // We validate the SHAPE of the request; the BEX owns which names are real.
      // A falsy/non-string name must be rejected here: the BEX drops frames with
      // a non-truthy `tool` without replying (mcpBridge.ts `if (!msg?.id ||
      // !msg?.tool) return`), so forwarding one would hang out the full
      // CALL_TIMEOUT_MS instead of failing now.
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'Invalid params: name must be a non-empty string', undefined, cors)
      }
      if (shouldPromote(name, args)) promoteBrowser()
      try {
        const result = (await callBex(name, args)) as any
        // The BEX may answer with MCP content blocks already (bex_snapshot
        // returns pre-formatted text; bex_screenshot returns an image). Pass
        // those through untouched — JSON-stringifying them would double-encode
        // the text and mangle the image.
        if (result && Array.isArray(result.content)) return rpcResult(id, result, cors)
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }, cors)
      } catch (e: any) {
        const err = e as BridgeError
        // bex_status must always answer truthfully, even with the bridge down.
        if (name === 'bex_status' && err?.code === 'bridge_disconnected') {
          const status = { bridge: 'down', ...bridgeStatus(), error: err.message }
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }, cors)
        }
        // An unknown tool is a PROTOCOL error per the MCP tools spec, not a
        // tool-execution failure — isError is for a valid tool that failed. The
        // BEX still owns the names; we only translate its verdict back into the
        // JSON-RPC envelope the spec asks for.
        if (err?.code === 'unknown_tool') {
          return rpcError(id, -32602, err.message || `unknown tool: ${name}`, undefined, cors)
        }
        // Tool-level failure → isError result (MCP convention), never a hang.
        const payload = { error: err?.code || 'tool_error', message: err?.message || String(e) }
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true }, cors)
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${method}`, undefined, cors)
  }
}
