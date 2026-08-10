import { describe, it, expect, afterEach } from 'bun:test'
import { checkSolanaOutflow } from './solana-outflow'

// Stub the single RPC call the module makes. Verified against mainnet during
// development (a 0.01 SOL transfer from a 0.678353227 SOL account reported
// 0.668348227 SOL after, deterministically); these cases lock in the parsing
// and the fail-closed paths without needing the network.
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Stub the RPC. `byMethod` lets a test answer getTokenAccountsByOwner and
 *  simulateTransaction differently; a bare object answers everything. */
function stubRpc(result: any, byMethod?: Record<string, any>) {
  globalThis.fetch = (async (_url: any, init: any) => {
    const method = JSON.parse(init.body).method
    const payload = byMethod?.[method] ?? result
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
}

/** SPL token account: mint(32) | owner(32) | amount(u64 LE) | pad to 165 */
function tokenAccount(mintByte: number, amount: bigint): string {
  const buf = Buffer.alloc(165)
  buf.fill(mintByte, 0, 32)
  buf.writeBigUInt64LE(amount, 64)
  return buf.toString('base64')
}

describe('checkSolanaOutflow', () => {
  it('reports the post-transaction SOL balance', async () => {
    stubRpc({ value: { err: null, accounts: [{ lamports: 668348227, data: [''] }] } })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner')
    expect(r.unavailable).toBeUndefined()
    expect(r.solLamportsAfter).toBe(668348227n)
  })

  // The token side is the whole point for a token-source swap: watching only
  // SOL would report a barely-changed balance while the tokens drain.
  it('resolves the owner token account for a mint and reports its balance', async () => {
    stubRpc(null, {
      getTokenAccountsByOwner: { value: [{ pubkey: 'TokAcct111' }] },
      simulateTransaction: {
        value: {
          err: null,
          accounts: [
            { lamports: 1_000_000, data: [''] },
            { lamports: 2039280, data: [tokenAccount(7, 12345n)] },
          ],
        },
      },
    })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.unavailable).toBeUndefined()
    expect(r.tokensAfter).toHaveLength(1)
    expect(r.tokensAfter[0].amountAfter).toBe(12345n)
  })

  it('reports unknown — not "no tokens moved" — when the token account lookup fails', async () => {
    globalThis.fetch = (async (_u: any, init: any) => {
      if (JSON.parse(init.body).method === 'getTokenAccountsByOwner') throw new Error('rpc down')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { err: null, accounts: [] } } }))
    }) as any
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.unavailable).toContain('token account')
  })

  // Fail closed: none of these may look like "nothing leaves / all clear".
  it('reports unknown when the simulation fails', async () => {
    stubRpc({ value: { err: { InstructionError: [0, 'Custom'] }, accounts: null } })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner')
    expect(r.unavailable).toContain('simulation failed')
  })

  it('reports unknown when account states are missing', async () => {
    stubRpc({ value: { err: null, accounts: [] } })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner')
    expect(r.unavailable).toBe('simulation returned no account states')
  })

  it('reports unknown when the RPC is unreachable', async () => {
    globalThis.fetch = (async () => { throw new Error('fetch failed') }) as any
    const r = await checkSolanaOutflow('dGVzdA==', 'owner')
    expect(r.unavailable).toBe('fetch failed')
    expect(r.solLamportsAfter).toBe(0n)
  })
})
