/**
 * "What will I be left with?" — host-side safety check for Solana
 * transactions the device cannot clear-sign.
 *
 * WHY POST-STATE AND NOT A DELTA: the obvious design is pre-balance minus
 * simulated post-balance. It does not work. Pre-state and simulation are two
 * RPC calls, public endpoints are load-balanced, and the two can land on nodes
 * at different slots — so unrelated traffic gets attributed to this
 * transaction. Measured against a live mainnet account, a 1.5 SOL transfer
 * reported 6.5 SOL and then 101 SOL of "outflow", and the error was
 * *reproducible*, so neither slot-matching nor repeat-and-compare fixes it.
 *
 * `simulateTransaction` returns post-execution balances from a single call, so
 * the post-state needs no second read and cannot race. "After this transaction
 * your wallet holds X" is therefore exact, and it answers the question that
 * actually matters — a drain leaves you with nothing.
 *
 * WHAT THIS IS NOT: this runs on the host against an RPC the host chose. It
 * defends against a quote server that built a transaction differing from the
 * quote you approved. It does NOT defend against a compromised vault — only
 * the device screen can, and for an opaque transaction it cannot. Present as
 * "checked on this computer", never "verified".
 */

import bs58 from 'bs58'
import { DEFAULT_SOLANA_RPC_ENDPOINT } from './solana-alt'

/** SPL token account layout: mint(32) | owner(32) | amount(u64 LE) | ... */
const SPL_ACCOUNT_LEN = 165
const SPL_AMOUNT_OFFSET = 64

export interface SolanaOutflow {
  /** Lamports the fee-payer's native account holds AFTER this transaction. */
  solLamportsAfter: bigint
  /** Post-transaction balances of the watched token accounts. */
  tokensAfter: Array<{ mint: string; amountAfter: bigint }>
  /** Set when the check could not be completed. Callers must treat this as
   *  "unknown" — never as "safe". */
  unavailable?: string
}

async function rpc(endpoint: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`)
  const json: any = await res.json()
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message || 'error'}`)
  return json.result
}

function splAmount(dataB64: string | undefined): { mint: string; amount: bigint } | null {
  if (!dataB64) return null
  const buf = Buffer.from(dataB64, 'base64')
  if (buf.length < SPL_ACCOUNT_LEN) return null
  return {
    mint: bs58.encode(buf.subarray(0, 32)),
    amount: buf.readBigUInt64LE(SPL_AMOUNT_OFFSET),
  }
}

/** The owner's token accounts for `mint`. Uses the RPC rather than deriving
 *  the associated-token PDA so non-ATA accounts are covered too. */
async function tokenAccountsFor(owner: string, mint: string, endpoint: string): Promise<string[]> {
  const res = await rpc(endpoint, 'getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'base64' },
  ])
  return (res?.value ?? []).map((a: any) => a.pubkey).filter(Boolean)
}

/**
 * Simulate `rawTxBase64` and report what `owner` is left holding afterwards.
 *
 * Pass `sourceMint` whenever the asset being spent is an SPL token — without
 * it the report covers only native SOL, which for a token swap is the wrong
 * asset entirely: it would read "your wallet holds 0.0099 SOL" (reassuring)
 * while the tokens actually leaving go unmentioned.
 */
export async function checkSolanaOutflow(
  rawTxBase64: string,
  owner: string,
  sourceMint?: string,
  endpoint = DEFAULT_SOLANA_RPC_ENDPOINT,
): Promise<SolanaOutflow> {
  let tokenAccounts: string[] = []
  if (sourceMint) {
    try {
      tokenAccounts = await tokenAccountsFor(owner, sourceMint, endpoint)
    } catch {
      // Fall through: report SOL and flag that the token side is unknown
      // rather than silently implying the token isn't moving.
      return {
        solLamportsAfter: 0n,
        tokensAfter: [],
        unavailable: `could not locate your ${sourceMint.slice(0, 4)}…${sourceMint.slice(-4)} token account`,
      }
    }
  }
  const watched = [owner, ...tokenAccounts]
  const empty = { solLamportsAfter: 0n, tokensAfter: [] }
  try {
    const sim = await rpc(endpoint, 'simulateTransaction', [
      rawTxBase64,
      {
        encoding: 'base64',
        sigVerify: false,             // unsigned at this point
        replaceRecentBlockhash: true, // the quote's blockhash may be stale
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: watched },
      },
    ])

    if (sim?.value?.err) {
      // A transaction failing simulation will fail on-chain too. Report it as
      // unknown — a failed simulation must not read as a safety result.
      return { ...empty, unavailable: `simulation failed: ${JSON.stringify(sim.value.err).slice(0, 120)}` }
    }

    const post: any[] = sim?.value?.accounts ?? []
    if (post.length !== watched.length) {
      return { ...empty, unavailable: 'simulation returned no account states' }
    }

    const tokensAfter: Array<{ mint: string; amountAfter: bigint }> = []
    for (let i = 1; i < watched.length; i++) {
      const tok = splAmount(post[i]?.data?.[0])
      if (tok) tokensAfter.push({ mint: tok.mint, amountAfter: tok.amount })
    }

    return { solLamportsAfter: BigInt(post[0]?.lamports ?? 0), tokensAfter }
  } catch (e: any) {
    return { ...empty, unavailable: e?.message || String(e) }
  }
}
