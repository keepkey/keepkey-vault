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

  // Says which counts did not match, not "no account states": the branch also
  // fires when the simulation returned some states, just not one per watched
  // account, and a message that named the wrong condition sent a reader
  // looking for an outage that had not happened.
  it('reports unknown when account states are missing, naming the counts', async () => {
    stubRpc({ value: { err: null, accounts: [] } })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner')
    expect(r.unavailable).toBe('simulation returned 0 account state(s) for 1 watched account(s)')
  })

  it('names the counts when the simulation answered for only some watched accounts', async () => {
    stubRpc(null, {
      getTokenAccountsByOwner: { value: [{ pubkey: 'TokAcct111' }] },
      simulateTransaction: { value: { err: null, accounts: [{ lamports: 1_000_000, data: [''] }] } },
    })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.unavailable).toBe('simulation returned 1 account state(s) for 2 watched account(s)')
  })

  // The honesty rule at its sharpest: a watched token account whose post-state
  // comes back null (the program closed it, or the RPC did not load it) used to
  // be dropped from tokensAfter with nothing said, leaving SOL alone on screen
  // — which reads as "that token is not moving".
  it('says so when a watched token account has no readable post-state', async () => {
    stubRpc(null, {
      getTokenAccountsByOwner: { value: [{ pubkey: 'TokAcct111' }] },
      simulateTransaction: {
        value: { err: null, accounts: [{ lamports: 1_000_000, data: [''] }, null] },
      },
    })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.unavailable).toBeUndefined()
    expect(r.tokensAfter).toEqual([])
    expect(r.note).toBe(
      'Token balances are incomplete: the simulation returned no readable state for TokA…t111, so what that account holds afterwards was not established.')
  })

  // The same rule on the fee payer's own entry, which the first pass missed:
  // `BigInt(post[0]?.lamports ?? 0)` turned a null or unloaded state into "you
  // would hold 0 SOL" — a figure this check never established. The token
  // balance that WAS read stays; only the SOL figure goes.
  it('says so when the fee payer has no readable post-state, instead of reporting 0', async () => {
    stubRpc(null, {
      getTokenAccountsByOwner: { value: [{ pubkey: 'TokAcct111' }] },
      simulateTransaction: {
        value: { err: null, accounts: [null, { lamports: 2039280, data: [tokenAccount(7, 12345n)] }] },
      },
    })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.unavailable).toBeUndefined()
    expect(r.solLamportsAfter).toBeUndefined()
    expect(r.tokensAfter).toHaveLength(1)
    expect(r.tokensAfter[0].amountAfter).toBe(12345n)
    expect(r.note).toBe(
      'SOL is missing from this answer: the simulation returned no readable state for your own account owne…wner, '
      + 'so what it holds afterwards was not established.')
  })

  it('names both sides when neither the fee payer nor the token account could be read', async () => {
    stubRpc(null, {
      getTokenAccountsByOwner: { value: [{ pubkey: 'TokAcct111' }] },
      simulateTransaction: { value: { err: null, accounts: [null, null] } },
    })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.solLamportsAfter).toBeUndefined()
    expect(r.tokensAfter).toEqual([])
    expect(r.note).toContain('SOL is missing from this answer')
    expect(r.note).toContain('Token balances are incomplete')
  })

  it('sets no note when every watched token account was read', async () => {
    stubRpc(null, {
      getTokenAccountsByOwner: { value: [{ pubkey: 'TokAcct111' }] },
      simulateTransaction: {
        value: {
          err: null,
          accounts: [{ lamports: 1, data: [''] }, { lamports: 2, data: [tokenAccount(7, 5n)] }],
        },
      },
    })
    const r = await checkSolanaOutflow('dGVzdA==', 'owner', 'MintAddr111')
    expect(r.note).toBeUndefined()
  })

  it('reports unknown when the RPC is unreachable', async () => {
    globalThis.fetch = (async () => { throw new Error('fetch failed') }) as any
    const r = await checkSolanaOutflow('dGVzdA==', 'owner')
    expect(r.unavailable).toBe('fetch failed')
    // No answer means no figure: a 0 beside `unavailable` is a number a caller
    // can render as "your wallet would be empty".
    expect(r.solLamportsAfter).toBeUndefined()
  })
})
