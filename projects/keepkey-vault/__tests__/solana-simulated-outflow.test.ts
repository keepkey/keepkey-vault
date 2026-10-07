/**
 * "What would I be left holding?" for a transaction nobody can read.
 *
 * The live Cee-lo bet moves its wager by CPI from inside the game program:
 * there is no SPL or System transfer instruction in the bytes, so no decoder —
 * ours or the device's — can name the amount. A simulation can, because it
 * reports the account states afterwards.
 *
 * Two rules this file exists to hold down:
 *   1. It is an ESTIMATE made on this computer. It may add an answer; it may
 *      never relax requiresBlindSigningConsent, requiresAdvancedMode,
 *      needsBlindSigning or deviceClearSigns, and a failed simulation must read
 *      as "could not check", never as "nothing moves".
 *   2. It watches the right accounts: native SOL plus the fee payer's token
 *      accounts that this transaction names. Solana requires every account a
 *      transaction touches, CPI included, to be listed in it — so an account
 *      the transaction never names cannot change, and is not worth watching.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { simulateSolanaHoldings } from '../src/bun/solana-outflow'
import { assessSigningRisk, formatSimulatedHoldings } from '../src/shared/clearsign-risk'
import type { SigningRequestInfo } from '../src/shared/types'
import fixture from './fixtures/solana/soltoshidice-ceelo-bet.json'
import altFixture from './fixtures/solana/relay-deposit-native-alt.json'

const SDICE = '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump'
/** The short form the copy uses for an address. */
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const noAlts = async (): Promise<never> => { throw new Error('legacy fixture must not fetch ALTs') }

/** SPL token account: mint(32) | owner(32) | amount(u64 LE) | pad to 165 */
function tokenAccountData(mint: string, amount: bigint): string {
  const buf = Buffer.alloc(165)
  require('bs58').default.decode(mint).forEach((b: number, i: number) => { buf[i] = b })
  buf.writeBigUInt64LE(amount, 64)
  return buf.toString('base64')
}

/** Answer each RPC method, and record what was asked. */
function stubRpc(answers: Record<string, any>) {
  const calls: Array<{ method: string; params: any[] }> = []
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body)
    calls.push({ method: body.method, params: body.params })
    const result = answers[body.method]
    if (result === undefined) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `no stub for ${body.method}` } }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'Content-Type': 'application/json' } })
  }) as any
  return calls
}

describe('simulateSolanaHoldings on the live Cee-lo bet', () => {
  test('watches SOL plus the fee payer token accounts this transaction names', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    const named = decoded.instructions[1].accounts.map((a) => a.pubkey)
    const ownedInTx = named[1]

    const calls = stubRpc({
      // The owner holds two token accounts; only one appears in this bet.
      getTokenAccountsByOwner: { value: [{ pubkey: ownedInTx }, { pubkey: 'SomeOtherTokenAccount1111111111111111111111' }] },
      simulateTransaction: {
        value: {
          err: null,
          accounts: [
            { lamports: 23_456_789, data: [''] },
            { lamports: 2_039_280, data: [tokenAccountData(SDICE, 11_000_000_000n)] },
          ],
        },
      },
    })

    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, {
      endpoint: 'http://127.0.0.1:1', verifiedTokens: [{ mint: SDICE, symbol: 'SDICE', decimals: 6 }],
    })

    // The fee payer is read from the transaction, not supplied by a caller.
    expect(holdings.owner).toBe(fixture.feePayer)
    expect(holdings.label).toBe('checked on this computer')
    expect(holdings.unavailable).toBeUndefined()
    expect(holdings.solLamportsAfter).toBe('23456789')
    expect(holdings.tokensAfter).toEqual([{ mint: SDICE, amountAfter: '11000000000', symbol: 'SDICE', decimals: 6 }])

    // Both token programs are asked (Token-2022 holds SDICE), and the account
    // this transaction never names is not watched.
    expect(calls.filter((c) => c.method === 'getTokenAccountsByOwner')).toHaveLength(2)
    const watched = calls.find((c) => c.method === 'simulateTransaction')!.params[1].accounts.addresses
    expect(watched).toEqual([fixture.feePayer, ownedInTx])
  })

  test('a token nobody attested keeps its raw units and full mint', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    stubRpc({
      getTokenAccountsByOwner: { value: [{ pubkey: decoded.instructions[1].accounts[1].pubkey }] },
      simulateTransaction: {
        value: { err: null, accounts: [{ lamports: 1, data: [''] }, { lamports: 2, data: [tokenAccountData(SDICE, 5n)] }] },
      },
    })
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, { endpoint: 'http://127.0.0.1:1' })
    expect(holdings.tokensAfter).toEqual([{ mint: SDICE, amountAfter: '5' }])
  })

  // The exact reproduction from the adversarial review. simulateTransaction
  // returns null for an address that does not exist at the post-state — which
  // is precisely what happens when the program closes the player's token
  // account. The wager must not simply vanish from the sentence.
  test('a wager account the simulation cannot read is named, never dropped in silence', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    const wagerAccount = decoded.instructions[1].accounts[1].pubkey
    stubRpc({
      getTokenAccountsByOwner: { value: [{ pubkey: wagerAccount }] },
      simulateTransaction: { value: { err: null, accounts: [{ lamports: 12_345_678 }, null] } },
    })

    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, {
      endpoint: 'http://127.0.0.1:1', verifiedTokens: [{ mint: SDICE, symbol: 'SDICE', decimals: 6 }],
    })

    // SOL is still answered, but the token side is stated as not established.
    expect(holdings.solLamportsAfter).toBe('12345678')
    expect(holdings.tokensAfter).toEqual([])
    expect(holdings.note).toContain('Token balances are incomplete')
    expect(holdings.note).toContain(`${wagerAccount.slice(0, 4)}…${wagerAccount.slice(-4)}`)
    expect(holdings.note).toContain('was not established')

    // And the copy the user reads carries it — silence here was the bug.
    const sentence = assessSigningRisk({
      method: '/solana/sign-transaction', solanaDecoded: decoded, simulatedOutflow: holdings,
    } as SigningRequestInfo)!.reasons.map((r) => r.text).join('\n')
    expect(sentence).toContain('would hold 0.012345678 SOL')
    expect(sentence).toContain('Token balances are incomplete')
  })

  // The same silent substitution, one account earlier. `post[0]?.lamports ?? 0`
  // read a null fee-payer state as "you would hold 0 SOL" — the most alarming
  // number on the screen, stated by a check that established nothing.
  test('a fee payer the simulation cannot read is named, never reported as 0 SOL', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    stubRpc({
      getTokenAccountsByOwner: { value: [{ pubkey: decoded.instructions[1].accounts[1].pubkey }] },
      simulateTransaction: {
        value: {
          err: null,
          accounts: [null, { lamports: 2_039_280, data: [tokenAccountData(SDICE, 11_000_000_000n)] }],
        },
      },
    })

    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, {
      endpoint: 'http://127.0.0.1:1', verifiedTokens: [{ mint: SDICE, symbol: 'SDICE', decimals: 6 }],
    })

    // The token balance was established, so it is still answered.
    expect(holdings.solLamportsAfter).toBeUndefined()
    expect(holdings.tokensAfter).toEqual([{ mint: SDICE, amountAfter: '11000000000', symbol: 'SDICE', decimals: 6 }])

    const sentence = assessSigningRisk({
      method: '/solana/sign-transaction', solanaDecoded: decoded, simulatedOutflow: holdings,
    } as SigningRequestInfo)!.reasons.map((r) => r.text).join('\n')
    expect(sentence).toContain(
      `Checked on this computer: if this goes through, your account ${short(fixture.feePayer)} would hold 11,000 SDICE. `
      + `SOL is missing from this answer: the simulation returned no readable state for your own account ${short(fixture.feePayer)}, `
      + 'so what it holds afterwards was not established.')
    expect(sentence).not.toContain('would hold 0 SOL')
  })

  test('with neither side readable it says there is no answer, and keeps both notes', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    stubRpc({
      getTokenAccountsByOwner: { value: [{ pubkey: decoded.instructions[1].accounts[1].pubkey }] },
      simulateTransaction: { value: { err: null, accounts: [null, null] } },
    })
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, {
      endpoint: 'http://127.0.0.1:1', verifiedTokens: [{ mint: SDICE, symbol: 'SDICE', decimals: 6 }],
    })
    const sentence = formatSimulatedHoldings(holdings)
    expect(sentence).toStartWith('This computer could not simulate this transaction')
    expect(sentence).toContain('That is not the same as "nothing moves".')
    expect(sentence).toContain('SOL is missing from this answer')
    expect(sentence).toContain('Token balances are incomplete')
    expect(sentence).not.toContain('would hold')
  })

  // Two independent facts, and the second used to erase the first.
  test('a token lookup failure survives a later simulation failure', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body)
      if (body.method === 'getTokenAccountsByOwner') throw new Error('token account lookup is down')
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { value: { err: { InstructionError: [1, { Custom: 6001 }] } } },
      }))
    }) as any

    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, { endpoint: 'http://127.0.0.1:1' })
    expect(holdings.unavailable).toContain('simulation failed')
    expect(holdings.note).toContain('Token balances were not checked')

    const sentence = assessSigningRisk({
      method: '/solana/sign-transaction', solanaDecoded: decoded, simulatedOutflow: holdings,
    } as SigningRequestInfo)!.reasons.map((r) => r.text).join('\n')
    expect(sentence).toContain('could not simulate')
    expect(sentence).toContain('Token balances were not checked')
  })

  test('a failed simulation says so, and never says nothing moves', async () => {
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    stubRpc({
      getTokenAccountsByOwner: { value: [] },
      simulateTransaction: { value: { err: { InstructionError: [1, { Custom: 6001 }] } } },
    })
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, decoded, { endpoint: 'http://127.0.0.1:1' })
    expect(holdings.unavailable).toContain('simulation failed')
    expect(holdings.solLamportsAfter).toBeUndefined()

    const sentence = assessSigningRisk({
      method: '/solana/sign-transaction', solanaDecoded: decoded, simulatedOutflow: holdings,
    } as SigningRequestInfo)!.reasons.map((r) => r.text).join('\n')
    expect(sentence).toContain('could not simulate')
    expect(sentence).toContain('That is not the same as "nothing moves"')
  })

  test('an unreachable RPC is reported, not swallowed', async () => {
    globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED') }) as any
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, undefined, { endpoint: 'http://127.0.0.1:1' })
    expect(holdings.unavailable).toBeTruthy()
    expect(holdings.owner).toBe(fixture.feePayer)
  })

  test('with no decode there is no account list, and it says the tokens went unchecked', async () => {
    stubRpc({ simulateTransaction: { value: { err: null, accounts: [{ lamports: 7, data: [''] }] } } })
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, undefined, { endpoint: 'http://127.0.0.1:1' })
    expect(holdings.solLamportsAfter).toBe('7')
    expect(holdings.note).toContain('Token balances were not checked')
  })
})

describe('a simulation cannot change a signing gate', () => {
  const holdings = {
    label: 'checked on this computer',
    owner: fixture.feePayer,
    solLamportsAfter: '999000000000',
    tokensAfter: [],
  } as const

  test('the risk level is identical with and without it', async () => {
    const base = {
      method: '/solana/sign-transaction',
      solanaDecoded: await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts),
    } as SigningRequestInfo
    const without = assessSigningRisk(base)!
    const with_ = assessSigningRisk({ ...base, simulatedOutflow: holdings })!
    // A healthy-looking balance afterwards must not make an unreadable
    // transaction look better than it is.
    expect(with_.level).toBe(without.level)
    expect(with_.headline).toBe(without.headline)
    expect(with_.reasons.filter((r) => r.level !== 'low')).toEqual(without.reasons.filter((r) => r.level !== 'low'))
  })

  test('assessing the risk leaves the gates on the request untouched', async () => {
    const request = {
      method: '/solana/sign-transaction',
      solanaDecoded: await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts),
      requiresBlindSigningConsent: true,
      requiresAdvancedMode: true,
      needsBlindSigning: true,
      deviceClearSigns: false,
      simulatedOutflow: holdings,
    } as SigningRequestInfo
    const before = JSON.stringify(request)
    assessSigningRisk(request)
    expect(JSON.stringify(request)).toBe(before)
  })

  // The wiring is what actually has to hold: nothing in the REST layer may
  // derive a gate from the simulation, and the gates must be decided before it
  // is even asked for.
  const rest = readFileSync(new URL('../src/bun/rest-api.ts', import.meta.url), 'utf8')

  /** The value given to a gate: up to the comma or bracket that ends it, so a
   *  sibling property on the same line is not mistaken for the value. */
  function valueOf(tail: string): string {
    let depth = 0
    for (let i = 0; i < tail.length; i++) {
      const c = tail[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) { if (depth === 0) return tail.slice(0, i); depth-- }
      else if (c === ',' && depth === 0) return tail.slice(0, i)
    }
    return tail
  }

  test('no gate is ever assigned from the simulation', () => {
    const assignments = [...rest.matchAll(
      /(needsBlindSigning|requiresAdvancedMode|requiresBlindSigningConsent|deviceClearSigns)\s*[=:]\s*([^\n]*)/g)]
    expect(assignments.length).toBeGreaterThan(4)
    for (const [, gate, tail] of assignments) {
      expect(`${gate} = ${valueOf(tail)}`).not.toMatch(/simulat|outflow/i)
    }
  })

  // The identity seam. A ticker on the holdings line may only come from the
  // certified description's own args, because that is where the delegate's
  // attestation is compared with the reviewed catalog entry's pin. Handing the
  // raw attestation to the simulation instead put an unchecked symbol — and an
  // unchecked decimal point — in the sentence about what the user is left with.
  test('the simulation is never handed the delegate raw attestation', () => {
    expect(rest).toContain('verifiedTokens: certifiedTokenIdentities(')
    expect(rest).not.toMatch(/(verifiedTokens|tokens)\s*:\s*[^\n]*tokenInfo/)
  })

  test('the decode endpoint decides consent before it simulates', () => {
    const handler = rest.slice(rest.indexOf("path === '/solana/decode-transaction'"))
    expect(handler.indexOf('requiresSolanaBlindSigningConsent(')).toBeLessThan(handler.indexOf('simulateSolanaHoldings('))
  })

  test('the signing preview runs every gate before it simulates', () => {
    const preview = rest.slice(rest.indexOf("} else if (path === '/solana/sign-transaction') {"))
    expect(preview.indexOf('applyRestSolanaSigningGates(')).toBeLessThan(preview.indexOf('simulateSolanaHoldings('))
    expect(preview.indexOf('signingInfo.deviceClearSigns = true')).toBeLessThan(preview.indexOf('simulateSolanaHoldings('))
  })
})

describe('the check has a budget', () => {
  test('an RPC that never answers gives up instead of holding the window shut', async () => {
    globalThis.fetch = (async () => new Promise(() => {})) as any // never settles
    const started = Date.now()
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, undefined, {
      endpoint: 'http://127.0.0.1:1', timeoutMs: 50,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(holdings.unavailable).toContain('no answer within')
    expect(holdings.solLamportsAfter).toBeUndefined()
  })
})

describe('the network fee is read from the signed bytes', () => {
  test('base fee per signature, plus the priority fee the tx asks for', async () => {
    // This bet sets a compute-unit LIMIT but no price, so there is no priority
    // fee: one signature at 5,000 lamports is the whole of it.
    const decoded = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlts)
    expect(decoded.maxNetworkFeeLamports).toBe('5000')
    const text = assessSigningRisk({
      method: '/solana/sign-transaction', solanaDecoded: decoded,
    } as SigningRequestInfo)!.reasons.map((r) => r.text).join('\n')
    expect(text).toContain('Network fee: up to 0.000005 SOL')
  })

  test('an unresolved lookup table withholds the figure instead of understating it', async () => {
    // A real v0 transaction whose lookup table cannot be read: an instruction
    // in it may set a priority fee this computer cannot see.
    const unresolved = await buildSolanaDecodedInfo(
      altFixture.rawTxBase64,
      async () => { throw new Error('lookup table unavailable') },
    )
    expect(unresolved.altResolutionIncomplete).toBe(true)
    expect(unresolved.maxNetworkFeeLamports).toBeUndefined()
    const text = assessSigningRisk({
      method: '/solana/sign-transaction', solanaDecoded: unresolved,
    } as SigningRequestInfo)!.reasons.map((r) => r.text).join('\n')
    expect(text).not.toContain('Network fee')
    expect(text).toContain('Part of this transaction is hidden')
  })
})

describe('airplane mode', () => {
  test('asks nothing of the network, and says that is why there is no answer', async () => {
    globalThis.fetch = (async () => { throw new Error('a request was made in offline mode') }) as any
    const holdings = await simulateSolanaHoldings(fixture.rawTxBase64, undefined, { offline: true })
    expect(holdings.unavailable).toBe('offline mode is on, so this computer made no network call')
    expect(holdings.solLamportsAfter).toBeUndefined()
  })
})
