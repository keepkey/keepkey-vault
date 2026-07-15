/**
 * MCP bridge — JSON-RPC handler conformance + BEX-bridge call lifecycle.
 * Covers the review-hardened paths (parse-error envelope, notification/id-less
 * 202, protocol-version negotiation) and the socket-replace pending-fail fix.
 *
 * Run: bun test src/bun/mcp.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { handleMcpRequest } from './mcp'
import { callBex, onBexOpen, onBexClose, bridgeConnected } from './bex-bridge'

function post(body: unknown): Request {
  return new Request('http://localhost:1646/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
const call = async (body: unknown) => {
  const res = await handleMcpRequest(post(body), {})
  return { status: res.status, json: res.status === 202 ? null : await res.json() }
}

describe('MCP JSON-RPC handler', () => {
  test('unparseable body → -32700 Parse error envelope (not a bare 400)', async () => {
    const { json } = await call('{not json')
    expect(json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
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
    expect(json.result.protocolVersion).toBe('2025-03-26')
  })

  test('tools/list returns the read-only tool catalog', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = json.result.tools.map((t: any) => t.name)
    expect(names).toContain('bex_status')
    expect(names).toContain('bex_accounts')
  })

  test('unknown method → -32601', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' })
    expect(json.error.code).toBe(-32601)
  })

  test('unknown tool → -32602', async () => {
    const { json } = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
    expect(json.error.code).toBe(-32602)
  })

  test('bex_status answers truthfully with the bridge DOWN (never hangs)', async () => {
    // No socket connected → callBex rejects bridge_disconnected → bex_status
    // special-cases it into a { bridge: "down" } result, not an error.
    const { json } = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bex_status' } })
    const payload = JSON.parse(json.result.content[0].text)
    expect(payload.bridge).toBe('down')
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
