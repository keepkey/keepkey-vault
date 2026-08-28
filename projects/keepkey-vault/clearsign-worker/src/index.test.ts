import { describe, expect, it } from 'bun:test'
import bs58 from 'bs58'

import worker from './index'

const fetchWorker = (path: string, init?: RequestInit, env: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://clearsign.example${path}`, init), env)

function relayLegacyTx(options: { extraDataByte?: boolean; wrongProgram?: boolean } = {}): string {
  const program = options.wrongProgram
    ? Buffer.alloc(32, 0x77)
    : Buffer.from(bs58.decode('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'))
  const data = Buffer.concat([
    Buffer.from('0d9e0ddf5fd51c06', 'hex'),
    Buffer.alloc(8, 0x01),
    Buffer.alloc(32, 0x02),
    ...(options.extraDataByte ? [Buffer.from([0xff])] : []),
  ])
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]),
    Buffer.from([5]),
    Buffer.alloc(32, 0x10),
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x12),
    Buffer.alloc(32, 0x13),
    program,
    Buffer.alloc(32, 0x20),
    Buffer.from([1, 4, 4, 0, 1, 2, 3, data.length]),
    data,
  ])
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')
}

const post = (path: string, body: unknown, env: Record<string, string> = {}) => fetchWorker(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}, env)

describe('ClearSign Worker public surface', () => {
  it('reports online but fail-closed until at least one scope is provisioned', async () => {
    const health = await (await fetchWorker('/health')).json() as any
    expect(health.ok).toBe(true)
    expect(health.ready).toBe(false)

    const ready = await fetchWorker('/ready')
    expect(ready.status).toBe(503)
    const status = await (await fetchWorker('/v1/status')).json() as any
    expect(status.status).toBe('provisioning')
    expect(status.scopes).toEqual({ ethereum: 'provisioning', solana: 'provisioning' })
    expect(status.privacy.note).toContain('unsigned transaction')
  })

  it('publishes human-readable provenance for Ethereum and Solana flows', async () => {
    const response = await fetchWorker('/v1/catalog')
    const body = await response.json() as any
    expect(response.status).toBe(200)
    expect(body.entries).toHaveLength(4)
    expect(body.entries.map((entry: any) => entry.family)).toEqual(['evm', 'evm', 'solana', 'solana'])
    for (const entry of body.entries) {
      expect(['Relay', 'Portals']).toContain(entry.protocol)
      expect(entry.provenance.protocol).toMatch(/^https:\/\//)
    }
  })

  it('rejects unknown EVM shapes before checking signer readiness', async () => {
    const response = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0x0000000000000000000000000000000000000001',
      selector: '0x49290c1c',
      calldataLength: 68,
    })
    expect(response.status).toBe(422)
  })

  it('returns unavailable for an exact reviewed EVM shape without signing', async () => {
    const response = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
      selector: '0x49290c1c',
      calldataLength: 68,
    })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
  })

  it('recognizes the dynamic Portals shape but rejects non-word-aligned calldata', async () => {
    const exact = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0xbf5A7F3629fB325E2a8453D595AB103465F75E62',
      selector: '0xa2e42c65',
      calldataLength: 1476,
    })
    expect(exact.status).toBe(503)
    const malformed = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0xbf5A7F3629fB325E2a8453D595AB103465F75E62',
      selector: '0xa2e42c65',
      calldataLength: 1477,
    })
    expect(malformed.status).toBe(422)
  })

  it('parses and exact-matches a reviewed Solana instruction before provisioning', async () => {
    const response = await post('/v1/solana/certify', {
      rawTx: relayLegacyTx(),
      catalogKey: 'relayDepositNative',
    })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
  })

  it('refuses malformed, wrong-program, wrong-length, and unknown Solana requests', async () => {
    expect((await post('/v1/solana/certify', { rawTx: 'not base64', catalogKey: 'relayDepositNative' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: relayLegacyTx({ wrongProgram: true }), catalogKey: 'relayDepositNative' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: relayLegacyTx({ extraDataByte: true }), catalogKey: 'relayDepositNative' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: relayLegacyTx(), catalogKey: 'unknown' })).status).toBe(422)
  })

  it('exposes a plain-language service page without claiming Solana transaction privacy', async () => {
    const response = await fetchWorker('/')
    const html = await response.text()
    expect(html).toContain('unsigned transaction')
    expect(html).toContain('You still approve the final transaction on the device')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
})
