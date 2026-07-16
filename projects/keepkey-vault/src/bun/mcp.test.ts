/**
 * MCP bridge — JSON-RPC handler conformance + BEX-bridge call lifecycle.
 * Covers the review-hardened paths (parse-error envelope, notification/id-less
 * 202, protocol-version negotiation) and the socket-replace pending-fail fix.
 *
 * Run: bun test src/bun/mcp.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { handleMcpRequest } from './mcp'
import { callBex, onBexOpen, onBexClose, onBexMessage, bridgeConnected } from './bex-bridge'

function post(body: unknown): Request {
  return new Request('http://localhost:1646/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
const call = async (body: unknown, headers?: Record<string, string>) => {
  const req = new Request('http://localhost:1646/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await handleMcpRequest(req, {})
  return { status: res.status, json: res.status === 202 ? null : await res.json() }
}

describe('MCP JSON-RPC handler', () => {
  test('unparseable body → -32700 Parse error envelope (not a bare 400)', async () => {
    const { json } = await call('{not json')
    expect(json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
  })

  test('jsonrpc other than "2.0" → -32600 (does not process 1.0)', async () => {
    const { json } = await call({ jsonrpc: '1.0', id: 1, method: 'ping' })
    expect(json.error.code).toBe(-32600)
  })

  test('unsupported MCP-Protocol-Version header → -32600', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })
    expect(json.error.code).toBe(-32600)
  })

  test('a supported MCP-Protocol-Version header is accepted', async () => {
    const { status } = await call({ jsonrpc: '2.0', method: 'ping' }, { 'MCP-Protocol-Version': '2025-06-18' })
    expect(status).toBe(202) // id-less ping → notification
  })

  test('missing method → -32600 Invalid Request', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 1 })
    expect(json.error.code).toBe(-32600)
  })

  test('batch → -32600', async () => {
    const { json } = await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }])
    expect(json.error.code).toBe(-32600)
  })

  test('notifications/* → 202 no body', async () => {
    const { status, json } = await call({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(status).toBe(202)
    expect(json).toBeNull()
  })

  test('id-less request (a notification) → 202, never a bodied reply', async () => {
    const { status } = await call({ jsonrpc: '2.0', method: 'ping' })
    expect(status).toBe(202)
  })

  test('initialize echoes a supported requested protocol version', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    expect(json.result.protocolVersion).toBe('2024-11-05')
  })

  test('initialize falls back to server version for an unsupported one', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect(json.result.protocolVersion).toBe('2025-06-18')
  })

  test('tools/list serves the static fallback catalog with the bridge DOWN', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = json.result.tools.map((t: any) => t.name)
    expect(names).toContain('bex_status')
    expect(names).toContain('bex_accounts')
  })

  test('unknown method → -32601', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' })
    expect(json.error.code).toBe(-32601)
  })

  test('unknown tool is no longer rejected here — it goes to the BEX, which owns the names', async () => {
    // The vault has no catalog to check against, so an unknown name is NOT a
    // -32602 anymore: it is forwarded, and the BEX's unknown_tool surfaces as
    // an isError result. Bridge down here, so the disconnect is what surfaces —
    // either way, a result, never a JSON-RPC error.
    const { json } = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
    expect(json.error).toBeUndefined()
    expect(json.result.isError).toBe(true)
  })

  test('bex_status answers truthfully with the bridge DOWN (never hangs)', async () => {
    // No socket connected → callBex rejects bridge_disconnected → bex_status
    // special-cases it into a { bridge: "down" } result, not an error.
    const { json } = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bex_status' } })
    const payload = JSON.parse(json.result.content[0].text)
    expect(payload.bridge).toBe('down')
  })
})

describe('MCP dumb pipe (bridge UP)', () => {
  // bex-bridge is a module singleton, so a socket left open by a failing test
  // leaks into the next one. Close in afterEach, not at the end of each test
  // body, which a failed expect() would skip.
  let open: any = null
  afterEach(() => {
    if (open) onBexClose(open)
    open = null
  })

  // A fake BEX that answers each forwarded call with a canned reply, keyed by
  // tool name. Lets us drive the proxied catalog + content passthrough with no
  // extension and no device.
  const fakeBex = (replies: Record<string, unknown>) => {
    const ws = {
      send(raw: string) {
        const { id, tool } = JSON.parse(raw)
        const result = replies[tool]
        queueMicrotask(() =>
          onBexMessage(ws as any, JSON.stringify(
            result === undefined
              ? { id, error: { code: 'unknown_tool', message: `unknown tool: ${tool}` } }
              : { id, result },
          )),
        )
      },
      close() {},
    }
    return ws
  }

  test('tools/list serves the BEX catalog, not the vault fallback', async () => {
    const ws = open = fakeBex({ bex_list_tools: { tools: [{ name: 'bex_screenshot' }, { name: 'bex_click' }] } })
    onBexOpen(ws as any)
    const { json } = await call({ jsonrpc: '2.0', id: 10, method: 'tools/list' })
    expect(json.result.tools.map((t: any) => t.name)).toEqual(['bex_screenshot', 'bex_click'])
  })

  test('a content-block result passes through untouched (image is not stringified)', async () => {
    const shot = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] }
    const ws = open = fakeBex({ bex_screenshot: shot })
    onBexOpen(ws as any)
    const { json } = await call({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'bex_screenshot' } })
    expect(json.result).toEqual(shot) // not double-encoded into a text block
  })

  test('a plain (non-content) result is still text-wrapped', async () => {
    const ws = open = fakeBex({ bex_accounts: { ethereum: '0xabc' } })
    onBexOpen(ws as any)
    const { json } = await call({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'bex_accounts' } })
    expect(JSON.parse(json.result.content[0].text)).toEqual({ ethereum: '0xabc' })
  })

  test("the BEX's unknown_tool surfaces as an isError result", async () => {
    const ws = open = fakeBex({})
    onBexOpen(ws as any)
    const { json } = await call({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'nope' } })
    expect(json.result.isError).toBe(true)
    expect(JSON.parse(json.result.content[0].text).error).toBe('unknown_tool')
  })
})

describe('BEX bridge call lifecycle', () => {
  const fakeWs = () => ({ sent: [] as string[], closed: false, send(d: string) { this.sent.push(d) }, close() { this.closed = true } })

  test('callBex with no socket rejects fast, no pending leak', async () => {
    expect(bridgeConnected()).toBe(false)
    await expect(callBex('bex_status', {})).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  test('replacing the socket fails the old socket in-flight calls immediately', async () => {
    const ws1 = fakeWs()
    onBexOpen(ws1 as any)
    const inflight = callBex('bex_accounts', {}) // sent over ws1, now pending
    const ws2 = fakeWs()
    onBexOpen(ws2 as any) // replaces ws1 — must reject ws1's pending now, not after 30s
    await expect(inflight).rejects.toMatchObject({ code: 'bridge_disconnected' })
    expect(ws1.closed).toBe(true)
    onBexClose(ws2 as any) // cleanup shared module state
    expect(bridgeConnected()).toBe(false)
  })
})
