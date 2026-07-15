/**
 * mcp — MCP server endpoint (Streamable HTTP, POST /mcp) for the agent bridge.
 * See EPIC_mcp_agent_bridge.md (keepkey-client repo).
 *
 * Agents connect with:  claude mcp add keepkey --transport http http://localhost:1646/mcp
 *
 * ponytail: hand-rolled JSON-RPC instead of @modelcontextprotocol/sdk — the
 * surface we serve is initialize/ping/tools/list/tools/call with plain JSON
 * responses (no SSE stream, no sessions; both optional per spec). Swap in the
 * SDK if we ever need notifications/resources.
 *
 * All tools execute inside the BEX; this file only owns the tool CATALOG and
 * the forwarding. Bridge down → structured bridge_disconnected error
 * (bex_status instead answers truthfully so agents can always probe).
 *
 * TRUST MODEL (accepted risk — see PR discussion): /mcp has NO caller
 * credential, by design, so `claude mcp add` is zero-config. Browsers are
 * excluded at the transport layer (Origin/Sec-Fetch reject in rest-api), but
 * ANY local process — or another OS user able to reach loopback — can call
 * /mcp once the BEX 'Agent mode' toggle (default off) is on, and read the
 * Tier-1 READ-ONLY data (accounts/xpubs, connected sites, provider logs). No
 * signing, no writes. This is a deliberate expansion beyond the bearer-authed
 * REST API for local-agent ergonomics; the Agent-mode toggle is the primary
 * gate. If per-install-secret auth is wanted later, require an Authorization
 * bearer on /mcp and surface the secret in the vault UI for `claude mcp add`.
 */

import { callBex, bridgeStatus, type BridgeError } from './bex-bridge'

// Default to 2025-06-18, which REMOVED JSON-RPC batching — so advertising it
// while this (deliberately single-request) server rejects batches is honest.
const PROTOCOL_VERSION = '2025-06-18'
// Versions whose initialize/ping/tools surface this server is compatible with.
// We echo the client's requested version when it's one of these (MCP
// negotiation), else offer ours.
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])

// Tier-1 read-only tools (Phase 1). Tier-2 control tools land in Phase 2.
const TOOLS = [
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

const TOOL_NAMES = new Set(TOOLS.map(t => t.name))

const json = (body: unknown, status = 200, cors: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } })

const rpcError = (id: unknown, code: number, message: string, data?: unknown, cors: Record<string, string> = {}) =>
  json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }, 200, cors)

const rpcResult = (id: unknown, result: unknown, cors: Record<string, string> = {}) =>
  json({ jsonrpc: '2.0', id: id ?? null, result }, 200, cors)

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

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS }, cors)

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (!TOOL_NAMES.has(name)) return rpcError(id, -32602, `unknown tool: ${name}`, undefined, cors)
      try {
        const result = await callBex(name, args)
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }, cors)
      } catch (e: any) {
        const err = e as BridgeError
        // bex_status must always answer truthfully, even with the bridge down.
        if (name === 'bex_status' && err?.code === 'bridge_disconnected') {
          const status = { bridge: 'down', ...bridgeStatus(), error: err.message }
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }, cors)
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
