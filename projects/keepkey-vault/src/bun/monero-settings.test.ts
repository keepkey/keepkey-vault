import { describe, expect, test } from 'bun:test'
import { checkMoneroNode, RESTORE_HEIGHT_MARGIN, storedRestoreHeight, suggestRestoreHeight, validateMoneroNode } from './monero-settings'
describe('Monero daemon settings', () => {
  test('remote connection checks the selected mainnet node before it can be saved', async () => {
    let request: {url:string;init:RequestInit} | undefined
    const result = await checkMoneroNode('https://node.example', async (url, init) => {
      request={url,init};return Response.json({result:{status:'OK',nettype:'mainnet',height:3801465,synchronized:true,busy_syncing:false}})
    })
    expect(result).toEqual({height:3801465})
    expect(request!.url).toBe('https://node.example/json_rpc')
    expect(request!.init.redirect).toBe('error')
    expect(JSON.parse(String(request!.init.body)).method).toBe('get_info')
  })
  test('unreachable, malformed, oversized and wrong-network nodes are rejected', async () => {
    for(const fetcher of [async()=>{throw Error('private diagnostic')},async()=>new Response('not json'),
      async()=>new Response('x'.repeat(65537)),async()=>Response.json({result:{status:'OK',nettype:'stagenet',height:42,synchronized:true}})]) {
      await expect(checkMoneroNode('https://node.example',fetcher)).rejects.toThrow('Could not reach a Monero mainnet node')
    }
  })
  test('a node still syncing is rejected without describing it as ready', async () => {
    await expect(checkMoneroNode('https://node.example',async()=>Response.json({result:{status:'OK',nettype:'mainnet',height:42,synchronized:false}}))).rejects.toThrow('still syncing')
  })
  test('remote HTTPS and explicit loopback HTTP have a consistent origin', () => {
    expect(validateMoneroNode({ daemonUrl: 'https://xmr.example/', restoreHeight: 42 })).toEqual({ daemonUrl: 'https://xmr.example', restoreHeight: 42 })
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) expect(validateMoneroNode({ daemonUrl: `http://${host}:18081`, restoreHeight: 0 }).restoreHeight).toBe(0)
  })
  test('remote cleartext, credentials, paths and URL decorations are refused', () => {
    for (const daemonUrl of ['http://remote.example', 'https://user:password@example.org', 'https://xmr.example/wallet', 'https://xmr.example?q=secret', 'https://xmr.example/#secret', 'file:///wallet']) {
      expect(() => validateMoneroNode({ daemonUrl, restoreHeight: 0 })).toThrow()
    }
  })
  test('restore height cannot silently round, become negative or select the wrong scan range', () => {
    for (const restoreHeight of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateMoneroNode({ daemonUrl: 'https://xmr.example', restoreHeight })).toThrow()
  })
})

describe('C4: the scan start for a new wallet', () => {
  test('defaults to the node tip minus about a week, read from the node itself', async () => {
    let path = ''
    const node = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => { path = new URL(req.url).pathname; return Response.json({ height: 3_300_000, status: 'OK', untrusted: false }) } })
    try {
      expect(await suggestRestoreHeight(`http://127.0.0.1:${node.port}`)).toEqual({ tipHeight: 3_300_000, restoreHeight: 3_300_000 - RESTORE_HEIGHT_MARGIN, marginBlocks: 5040 })
      expect(path).toBe('/get_height')
    } finally { node.stop(true) }
  })
  test('a young chain clamps to 0; a bad or unreachable node is an error, never a guessed height', async () => {
    const young = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ height: 100, status: 'OK' }) })
    const busy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'BUSY' }) })
    try {
      expect((await suggestRestoreHeight(`http://127.0.0.1:${young.port}`)).restoreHeight).toBe(0)
      await expect(suggestRestoreHeight(`http://127.0.0.1:${busy.port}`)).rejects.toThrow('did not report its current height')
    } finally { young.stop(true); busy.stop(true) }
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = gone.port; gone.stop(true)
    await expect(suggestRestoreHeight(`http://127.0.0.1:${port}`)).rejects.toThrow('could not be reached')
    await expect(suggestRestoreHeight('http://remote.example')).rejects.toThrow('HTTPS')
  })
  test('an unset, legacy-empty or unreadable restore height is 0 (scan everything), never a guess', () => {
    expect(storedRestoreHeight(null)).toBe(0)
    expect(storedRestoreHeight('')).toBe(0)
    expect(storedRestoreHeight('-1')).toBe(0)
    expect(storedRestoreHeight('0')).toBe(0)
    expect(storedRestoreHeight('3200000')).toBe(3_200_000)
  })
})
