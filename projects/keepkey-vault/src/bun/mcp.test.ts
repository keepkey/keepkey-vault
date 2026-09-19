/**
 * MCP bridge — JSON-RPC handler conformance + BEX-bridge call lifecycle.
 * Covers the review-hardened paths (parse-error envelope, notification/id-less
 * 202, protocol-version negotiation) and the socket-replace pending-fail fix.
 *
 * Run: bun test src/bun/mcp.test.ts
 */
import { describe, test, expect, afterEach, setSystemTime } from 'bun:test'
import { handleMcpRequest } from './mcp'
import { callBex, onBexOpen, onBexClose, onBexMessage, bridgeConnected, listBrowsers } from './bex-bridge'

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

  test('an unknown (but well-formed) tool name is forwarded, not rejected on the catalog', async () => {
    // The vault has no catalog to check against, so the name itself is the
    // BEX's call. Bridge is down here, so what surfaces is the disconnect —
    // an execution failure, hence isError rather than a protocol error.
    const { json } = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
    expect(json.error).toBeUndefined()
    expect(json.result.isError).toBe(true)
  })

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-string', 42],
  ])('a %s tool name → -32602 immediately, never a 30s bridge timeout', async (_label, name) => {
    // The BEX drops frames with a falsy `tool` without ever replying, so
    // forwarding one would hang until CALL_TIMEOUT_MS. Shape is ours to check.
    const { json } = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name } })
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
        // Mirrors the real BEX: a frame without a truthy id/tool is dropped with
        // NO reply (mcpBridge.ts `if (!msg?.id || !msg?.tool) return`). That
        // silence is exactly what makes an unvalidated name hang for 30s.
        if (!id || !tool) return
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
    expect(json.result.tools.map((t: any) => t.name)).toEqual(['bex_browsers', 'bex_screenshot', 'bex_click'])
    // Every BEX tool advertises the vault-owned `browser` routing arg.
    expect(json.result.tools.slice(1).every((t: any) => t.inputSchema.properties.browser)).toBe(true)
  })

  test('two browsers: an unnamed call is refused, a named one routes, `browser` is stripped', async () => {
    const seen: Array<{ who: string; args: any }> = []
    const bex = (who: string) => {
      const ws: any = {
        send(raw: string) {
          const { id, tool, args } = JSON.parse(raw)
          seen.push({ who, args })
          queueMicrotask(() => onBexMessage(ws, JSON.stringify({ id, result: { who, tool } })))
        },
        close() {},
      }
      return ws
    }
    const a = bex('A'), b = bex('B')
    onBexOpen(a)
    onBexOpen(b)
    try {
      const [ida, idb] = listBrowsers().map(x => x.browser)

      const amb = await call({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'bex_tabs' } })
      expect(amb.json.result.isError).toBe(true)
      expect(JSON.parse(amb.json.result.content[0].text).error).toBe('browser_ambiguous')
      expect(seen.length).toBe(0) // refused before anything was sent

      const r = await call({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'bex_tabs', arguments: { browser: idb, action: 'list' } } })
      expect(JSON.parse(r.json.result.content[0].text).who).toBe('B')
      expect(seen).toEqual([{ who: 'B', args: { action: 'list' } }])

      const bad = await call({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'bex_tabs', arguments: { browser: 'b999' } } })
      expect(JSON.parse(bad.json.result.content[0].text).error).toBe('unknown_browser')

      const list = await call({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'bex_browsers' } })
      const { browsers } = JSON.parse(list.json.result.content[0].text)
      expect(browsers.map((x: any) => [x.browser, x.status.who])).toEqual([[ida, 'A'], [idb, 'B']])
    } finally {
      onBexClose(a)
      onBexClose(b)
    }
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

  test("the BEX's unknown_tool becomes a -32602 protocol error, per the MCP tools spec", async () => {
    // isError is for a valid tool that failed while executing; an unknown tool
    // is a protocol error. The BEX still decides — we only translate.
    const ws = open = fakeBex({})
    onBexOpen(ws as any)
    const { json } = await call({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'nope' } })
    expect(json.result).toBeUndefined()
    expect(json.error.code).toBe(-32602)
  })

  test('an empty tool name fails fast rather than hanging on a BEX that never replies', async () => {
    // Regression: without the shape guard this forwards to a BEX that silently
    // drops it, and the call sits for the full CALL_TIMEOUT_MS (30s). If this
    // ever starts timing out instead of asserting, the guard is gone.
    const ws = open = fakeBex({ bex_status: { ok: true } })
    onBexOpen(ws as any)
    const { json } = await call({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: '' } })
    expect(json.error.code).toBe(-32602)
  }, 1000) // must resolve WAY inside the 30s bridge timeout
})

describe('BEX bridge call lifecycle', () => {
  const fakeWs = () => ({
    sent: [] as string[],
    closed: false,
    closeCode: 0,
    send(d: string) { this.sent.push(d) },
    close(code?: number) { this.closed = true; this.closeCode = code ?? 0 },
  })

  afterEach(() => setSystemTime()) // undo any clock travel

  test('callBex with no socket rejects fast, no pending leak', async () => {
    expect(bridgeConnected()).toBe(false)
    await expect(callBex('bex_status', {})).rejects.toMatchObject({ code: 'bridge_disconnected' })
  })

  test('a second extension instance is ACCEPTED alongside the first', async () => {
    // Regression: the vault used to hold one slot, so a second Chrome profile
    // with the extension was refused (4409) or evicted the first.
    const ws1 = fakeWs(), ws2 = fakeWs()
    onBexOpen(ws1 as any)
    onBexOpen(ws2 as any)
    expect(ws1.closed || ws2.closed).toBe(false)
    expect(listBrowsers().length).toBe(2)
    onBexClose(ws1 as any)
    onBexClose(ws2 as any)
    expect(bridgeConnected()).toBe(false)
  })

  test("closing one instance fails only ITS in-flight calls", async () => {
    const ws1 = fakeWs(), ws2 = fakeWs()
    onBexOpen(ws1 as any)
    onBexOpen(ws2 as any)
    const [b1, b2] = listBrowsers().map(x => x.browser)
    const on1 = callBex('bex_accounts', {}, b1)
    const on2 = callBex('bex_accounts', {}, b2)
    onBexClose(ws1 as any)
    await expect(on1).rejects.toMatchObject({ code: 'bridge_disconnected' })
    // ws2's call is still live — answer it.
    const { id } = JSON.parse(ws2.sent[0])
    onBexMessage(ws2 as any, JSON.stringify({ id, result: 'ok' }))
    await expect(on2).resolves.toBe('ok')
    onBexClose(ws2 as any)
  })

  test('an instance cannot answer a call sent to another', async () => {
    const ws1 = fakeWs(), ws2 = fakeWs()
    onBexOpen(ws1 as any)
    onBexOpen(ws2 as any)
    const [b1] = listBrowsers().map(x => x.browser)
    const inflight = callBex('bex_status', {}, b1)
    const { id } = JSON.parse(ws1.sent[0])
    onBexMessage(ws2 as any, JSON.stringify({ id, result: 'spoofed' })) // ignored
    onBexMessage(ws1 as any, JSON.stringify({ id, result: 'real' }))
    await expect(inflight).resolves.toBe('real')
    onBexClose(ws1 as any)
    onBexClose(ws2 as any)
  })

  test('a heartbeat keeps an instance fresh past the stale window', () => {
    const ws1 = fakeWs()
    onBexOpen(ws1 as any)
    setSystemTime(new Date(Date.now() + 40_000))
    onBexMessage(ws1 as any, JSON.stringify({ ping: 1 })) // no id — dropped, but proof of life
    setSystemTime(new Date(Date.now() + 40_000)) // 80s since open, 40s since ping
    expect(listBrowsers().length).toBe(1)
    expect(ws1.closed).toBe(false)
    onBexClose(ws1 as any)
  })

  test('a SILENT instance is dropped, so it never makes routing ambiguous, and its calls fail now', async () => {
    // The SW-restart case whose close frame never arrived.
    const ws1 = fakeWs()
    onBexOpen(ws1 as any)
    const inflight = callBex('bex_accounts', {})
    setSystemTime(new Date(Date.now() + 60_000)) // past STALE_MS, no frames from ws1

    const ws2 = fakeWs()
    onBexOpen(ws2 as any)
    expect(listBrowsers().length).toBe(1) // ghost pruned
    await expect(inflight).rejects.toMatchObject({ code: 'bridge_disconnected' })
    expect(ws1.closed).toBe(true)
    callBex('bex_status', {}).catch(() => {}) // unnamed call routes to the one live instance
    expect(ws2.sent.length).toBe(1)
    onBexClose(ws2 as any)
    expect(bridgeConnected()).toBe(false)
  })
})
