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
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'
import type { SimulatedHoldings, SolanaTxDecodedInfo } from '../shared/types'

/** SPL token account layout: mint(32) | owner(32) | amount(u64 LE) | ... */
const SPL_ACCOUNT_LEN = 165
const SPL_AMOUNT_OFFSET = 64

/** Programs whose accounts hold token balances for an owner. */
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
]

export interface SolanaOutflow {
  /** Lamports the fee-payer's native account holds AFTER this transaction.
   *  Absent when the simulation returned no readable state for that account:
   *  "not established" is not 0, and `note` then says so. */
  solLamportsAfter?: bigint
  /** Post-transaction balances of the watched token accounts. */
  tokensAfter: Array<{ mint: string; amountAfter: bigint }>
  /** Set when the check could not be completed. Callers must treat this as
   *  "unknown" — never as "safe". */
  unavailable?: string
  /** An honest limit on the numbers above: set when a watched account yielded
   *  no readable post-state, so `solLamportsAfter` is absent or `tokensAfter`
   *  is short of what was watched. Callers MUST render it beside the figures —
   *  a balance that dropped out silently reads as "that asset is not moving". */
  note?: string
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

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`

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
 * The token accounts of `owner` that this transaction names.
 *
 * Solana requires every account a transaction touches — including through a
 * CPI from inside an opaque program — to be listed in that transaction, so an
 * account absent from `txAccounts` cannot change, and one present is exactly
 * what needs watching. This is how a wager that moves by CPI, with no transfer
 * instruction to read, still gets an answer.
 *
 * Throws when the lookup fails: a caller that cannot list the accounts must say
 * so, not report SOL alone as if the tokens had been checked.
 */
export async function ownedTokenAccountsInTransaction(
  owner: string,
  txAccounts: Iterable<string>,
  endpoint = DEFAULT_SOLANA_RPC_ENDPOINT,
): Promise<string[]> {
  const named = new Set(txAccounts)
  const found: string[] = []
  for (const programId of TOKEN_PROGRAMS) {
    const res = await rpc(endpoint, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'base64' }])
    for (const account of res?.value ?? []) {
      if (typeof account?.pubkey === 'string' && named.has(account.pubkey)) found.push(account.pubkey)
    }
  }
  return found
}

/** Token accounts to report on beside native SOL. */
export interface SolanaOutflowWatch {
  /** Mints to resolve to `owner`'s token accounts (one RPC call each). */
  mints?: string[]
  /** Token accounts of `owner` that are already known — see
   *  {@link ownedTokenAccountsInTransaction}. */
  tokenAccounts?: string[]
}

/**
 * Simulate `rawTxBase64` and report what `owner` is left holding afterwards.
 *
 * Pass the token side whenever one exists — without it the report covers only
 * native SOL, which for a token swap or a token wager is the wrong asset
 * entirely: it would read "your wallet holds 0.0099 SOL" (reassuring) while the
 * tokens actually leaving go unmentioned. A bare mint string is the
 * single-asset case; `SolanaOutflowWatch` carries several.
 */
export async function checkSolanaOutflow(
  rawTxBase64: string,
  owner: string,
  watch?: string | SolanaOutflowWatch,
  endpoint = DEFAULT_SOLANA_RPC_ENDPOINT,
): Promise<SolanaOutflow> {
  const mints = typeof watch === 'string' ? [watch] : watch?.mints ?? []
  const tokenAccounts = new Set(typeof watch === 'string' ? [] : watch?.tokenAccounts ?? [])
  for (const mint of mints) {
    try {
      for (const account of await tokenAccountsFor(owner, mint, endpoint)) tokenAccounts.add(account)
    } catch {
      // Fail the whole check: reporting SOL while one watched mint silently
      // dropped out would read as "that token is not moving".
      return {
        tokensAfter: [],
        unavailable: `could not locate your ${short(mint)} token account`,
      }
    }
  }
  const watched = [owner, ...tokenAccounts]
  // No figure at all: `unavailable` means every balance field is absent, and a
  // 0 sitting beside it is a number waiting to be read as an answer.
  const empty = { tokensAfter: [] }
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
      return {
        ...empty,
        unavailable: `simulation returned ${post.length} account state(s) for ${watched.length} watched account(s)`,
      }
    }

    // A watched account with no readable post-state is NOT "unchanged" and NOT
    // "empty". simulateTransaction returns null for an address that does not
    // exist at the post-state — exactly what a program that closes the player's
    // token account produces — and for entries the RPC did not load. Either way
    // the balance was not established, and saying nothing would render as a
    // figure of 0 or as SOL alone with the token silently gone.
    //
    // The fee payer's own entry gets the same treatment as the token accounts:
    // `BigInt(post[0]?.lamports ?? 0)` turned an unreadable answer into "you
    // would hold 0 SOL", which is a statement this check never made.
    const tokensAfter: Array<{ mint: string; amountAfter: bigint }> = []
    const unread: string[] = []
    for (let i = 1; i < watched.length; i++) {
      const tok = splAmount(post[i]?.data?.[0])
      if (tok) tokensAfter.push({ mint: tok.mint, amountAfter: tok.amount })
      else unread.push(short(watched[i]))
    }
    const solLamportsAfter = typeof post[0]?.lamports === 'number' ? BigInt(post[0].lamports) : undefined
    const notes = [
      solLamportsAfter === undefined
        ? `SOL is missing from this answer: the simulation returned no readable state for your own account ${short(owner)}, so what it holds afterwards was not established.`
        : undefined,
      unread.length
        ? `Token balances are incomplete: the simulation returned no readable state for ${unread.join(', ')}, so what ${unread.length > 1 ? 'those accounts hold' : 'that account holds'} afterwards was not established.`
        : undefined,
    ].filter(Boolean)

    return {
      ...(solLamportsAfter !== undefined ? { solLamportsAfter } : {}),
      tokensAfter,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    }
  } catch (e: any) {
    return { ...empty, unavailable: e?.message || String(e) }
  }
}

/**
 * The "what will I be left holding" answer for a whole transaction, in the one
 * shape the approval overlay and the REST callers both get.
 *
 * Watches native SOL plus every token account of the fee payer that this
 * transaction names, so a program moving tokens by CPI — with no transfer
 * instruction anywhere in the bytes — is covered like any other.
 *
 * Never throws and never reports a half-answer as a whole one: a failure sets
 * `unavailable`, a token side that could not be established sets `note`. It
 * returns facts only; it decides no signing gate.
 */
export async function simulateSolanaHoldings(
  rawTxBase64: string,
  decoded: SolanaTxDecodedInfo | undefined,
  options: {
    endpoint?: string
    /** Token identities that have ALREADY been checked against the reviewed
     *  catalog entry's own pin — see `certifiedTokenIdentities`. Never the
     *  delegate's raw attestation: nothing on this computer verifies its
     *  signature, so an unchecked symbol or decimal point here would put a
     *  ticker on the holdings line that the device itself will not show.
     *  Display only — a mint with no identity is rendered in raw base units
     *  with its full address. */
    verifiedTokens?: Array<{ mint: string; symbol: string; decimals: number }>
    /** Whole-check budget. This runs while the user waits for the approval
     *  window, and it takes up to three RPC round trips, so it answers late or
     *  not at all rather than holding the window shut. */
    timeoutMs?: number
    /** Airplane mode. This check is new outbound traffic, so it asks nothing
     *  when the user has switched that off. (The decode and certified lookups
     *  on the same route predate this and are not covered by it.) */
    offline?: boolean
  } = {},
): Promise<SimulatedHoldings> {
  const label = 'checked on this computer' as const
  if (options.offline) {
    return { label, unavailable: 'offline mode is on, so this computer made no network call' }
  }
  const budget = options.timeoutMs ?? 10_000
  let expire: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<SimulatedHoldings>((resolve) => {
    expire = setTimeout(() => resolve({ label, unavailable: `no answer within ${Math.round(budget / 1000)}s` }), budget)
  })
  try {
    return await Promise.race([holdingsAfter(rawTxBase64, decoded, options), deadline])
  } finally {
    clearTimeout(expire)
  }
}

async function holdingsAfter(
  rawTxBase64: string,
  decoded: SolanaTxDecodedInfo | undefined,
  options: { endpoint?: string; verifiedTokens?: Array<{ mint: string; symbol: string; decimals: number }> },
): Promise<SimulatedHoldings> {
  const endpoint = options.endpoint ?? DEFAULT_SOLANA_RPC_ENDPOINT
  const label = 'checked on this computer' as const

  let owner: string
  try {
    const fullTx = Uint8Array.from(Buffer.from(rawTxBase64, 'base64'))
    const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
    owner = bs58.encode(message.staticAccounts[0])
  } catch (e: any) {
    return { label, unavailable: `could not read this transaction: ${e?.message || String(e)}` }
  }

  let tokenAccounts: string[] = []
  let note: string | undefined
  if (!decoded) {
    note = 'Token balances were not checked: this computer could not read the transaction.'
  } else {
    try {
      tokenAccounts = await ownedTokenAccountsInTransaction(
        owner,
        decoded.instructions.flatMap((ix) => ix.accounts.map((a) => a.pubkey)),
        endpoint,
      )
      if (decoded.altResolutionIncomplete) {
        note = 'Token balances may be incomplete: part of this transaction could not be looked up.'
      }
    } catch (e: any) {
      note = `Token balances were not checked: ${e?.message || String(e)}.`
    }
  }

  const outflow = await checkSolanaOutflow(rawTxBase64, owner, { tokenAccounts }, endpoint)
  // Both, never one: `unavailable` says the simulation gave no answer, `note`
  // says the token side was never attempted or came back short. Dropping the
  // note when a simulation also failed loses the second fact entirely.
  const notes = [note, outflow.note].filter(Boolean).join(' ')
  if (outflow.unavailable) {
    return { label, owner, unavailable: outflow.unavailable, ...(notes ? { note: notes } : {}) }
  }

  return {
    label,
    owner,
    ...(outflow.solLamportsAfter !== undefined ? { solLamportsAfter: outflow.solLamportsAfter.toString() } : {}),
    tokensAfter: outflow.tokensAfter.map((token) => {
      const identity = options.verifiedTokens?.find((t) => t.mint === token.mint)
      return {
        mint: token.mint,
        amountAfter: token.amountAfter.toString(),
        ...(identity ? { symbol: identity.symbol, decimals: identity.decimals } : {}),
      }
    }),
    ...(notes ? { note: notes } : {}),
  }
}
