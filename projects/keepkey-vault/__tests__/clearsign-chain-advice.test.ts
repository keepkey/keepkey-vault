/**
 * Desktop advice for chains the 7.16 firmware shows only as raw data:
 * Solana v0 swaps through Jupiter and Token-2022 transfers, TRON calls other
 * than a plain transfer, and Cosmos Hub amino requests.
 *
 * Every fixture is a real mainnet request with its _source (fetched from a
 * public RPC/LCD on 2026-10-29); see __tests__/fixtures/clearsign-chains/.
 * Lookup tables and token accounts are served from the captured account data,
 * never from the network.
 */
import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { JUPITER_V6, decodeJupiterSwap } from '../src/bun/solana-jupiter'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from '../src/bun/solana-tx'
import { tronCallPreview, tronPreview } from '../src/bun/tron-preview'
import { WalletConnectManager } from '../src/bun/walletconnect'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import type { SigningRequestInfo, SolanaTxDecodedInfo } from '../src/shared/types'

const FIXTURES = `${import.meta.dir}/fixtures/clearsign-chains/`
const load = (name: string) => Bun.file(FIXTURES + name).json()
const text = (r: ReturnType<typeof assessSigningRisk>) => r!.reasons.map((x) => `${x.level}: ${x.text}`).join('\n')

// ── Solana ────────────────────────────────────────────────────────────

interface SolanaFixture {
  rawTx: string
  accountKeys: string[]
  accounts: Record<string, { owner: string; data: string } | null>
  preTokenBalances: { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string } }[]
  postTokenBalances: SolanaFixture['preTokenBalances']
}

async function solana(name: string) {
  const fx = await load(name) as SolanaFixture
  const fetcher = async (keys: string[]) => keys.map((k) => {
    const a = fx.accounts[k]
    return a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data, 'base64')) } : null
  })
  const decoded = await buildSolanaDecodedInfo(fx.rawTx, fetcher)
  return { fx, decoded }
}

/** As REST builds it on 7.16: the firmware prediction said AdvancedMode. */
const solanaRequest = (decoded: SolanaTxDecodedInfo, from: string): SigningRequestInfo => ({
  id: 't', method: '/solana/sign-transaction', appName: 'test', firmwareVersion: '7.16.0',
  requiresAdvancedMode: true, from, solanaDecoded: decoded,
} as SigningRequestInfo)

/** The Jupiter instruction's own data bytes, straight from the message. */
function jupiterData(rawTx: string): Buffer {
  const full = Uint8Array.from(Buffer.from(rawTx, 'base64'))
  const msg = parseSolanaMessage(solanaMessageSlice(full, parseSolanaTx(full)))
  const ix = msg.instructions.find((i) => bs58.encode(msg.staticAccounts[i.programIdIndex]) === JUPITER_V6)!
  return Buffer.from(ix.data)
}

describe('Jupiter swaps (v0, lookup tables) read on this computer', () => {
  test('routeV2: SOL in, a minimum out, calm when the output comes back to the signer', async () => {
    const { fx, decoded } = await solana('jupiter-route-v2.json')
    expect(decoded.altPubkeys.length).toBe(2)
    expect(decoded.altResolutionIncomplete).toBeUndefined()
    const jup = decoded.instructions.find((i) => i.programId === JUPITER_V6)!
    expect(jup.status).toBe('known')
    expect(jup.instructionName).toBe('routeV2')
    expect(jup.note).toBeUndefined()

    const user = fx.accountKeys[0]
    const r = assessSigningRisk(solanaRequest(decoded, user))!
    expect(r.tier).toBe('yellow')
    expect(r.level).toBe('medium')
    const t = text(r)
    // 244180129563 quoted at 15.29% slippage: floor(q * 8471 / 10000).
    expect(t).toContain('Swaps 0.4 SOL for at least 206,844,987,752 base units of token 6rg9GdCro19d2sz79mhix5pLJjSwn8RTCjZvG4Wecnj through Jupiter')
    expect(t).toContain('cannot show Jupiter swaps on the device yet')
    expect(t).toContain('low: Moves 0.4 SOL into your own wrapped-SOL account AerX…82ga.')
    expect(t).not.toContain('NOT the account signing this')
    expect(t).not.toContain('could not check which account receives')

    // The chain agrees: what the user actually received is at least that minimum.
    const bal = (list: SolanaFixture['preTokenBalances']) => BigInt(list.find((b) => b.owner === user && b.mint === '6rg9GdCro19d2sz79mhix5pLJjSwn8RTCjZvG4Wecnj')?.uiTokenAmount.amount ?? '0')
    expect(bal(fx.postTokenBalances) - bal(fx.preTokenBalances)).toBeGreaterThanOrEqual(206_844_987_752n)
  })

  test('route (v1): the route plan is walked to the exact end before the amounts are trusted', async () => {
    const { fx, decoded } = await solana('jupiter-route.json')
    const jup = decoded.instructions.find((i) => i.programId === JUPITER_V6)!
    expect(jup.instructionName).toBe('route')
    expect(jup.note).toBeUndefined()
    expect(Object.fromEntries(jup.args.map((a) => [a.name, a.value]))).toMatchObject({
      inAmount: '106207', quotedOutAmount: '153923311', slippageBps: '100', platformFeeBps: '0', route: 'GoonFiV3, Whirlpool',
    })
    const t = text(assessSigningRisk(solanaRequest(decoded, fx.accountKeys[0])))
    expect(t).toContain('for at least 0.152384077 SOL through Jupiter (quoted 0.153923311 SOL, 1% slippage')

    // A byte past the amounts is one the program may never read: not decoded in full.
    const data = jupiterData(fx.rawTx)
    expect(decodeJupiterSwap(data)!.note).toBeUndefined()
    expect(decodeJupiterSwap(Buffer.concat([data, Buffer.from([0])]))!.note).toBe('1 trailing bytes not decoded')
    // A route step newer than this computer's layout: no amounts at all.
    const newer = Buffer.from(data)
    newer[12] = 250 // first RoutePlanStep's Swap tag (after disc + u32 length)
    const d = decodeJupiterSwap(newer)!
    expect(d.args).toEqual([])
    expect(d.note).toContain('newer than')
  })

  test('sharedAccountsRoute: a token with no checked name is shown by base units and full mint', async () => {
    const { fx, decoded } = await solana('jupiter-shared-accounts-route.json')
    const r = assessSigningRisk(solanaRequest(decoded, fx.accountKeys[0]))!
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Swaps 117,443,538,929 base units of token 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr for at least 0.046470894 SOL through Jupiter')
  })

  test('swap output paid to someone else is called out', async () => {
    const { fx, decoded } = await solana('jupiter-shared-accounts-route.json')
    const jup = decoded.instructions.find((i) => i.programId === JUPITER_V6)!
    const out = jup.accounts.find((a) => a.label === 'destinationTokenAccount')!.pubkey
    const other = '8gBF34G1d61hNQpHk2ogXkyxKKv27xDiNKXANqT7Jn67'
    const moved = { ...decoded, tokenAccounts: { ...decoded.tokenAccounts, [out]: { ...decoded.tokenAccounts![out], owner: other } } }
    const r = assessSigningRisk(solanaRequest(moved, fx.accountKeys[0]))!
    expect(r.tier).toBe('red')
    expect(text(r)).toContain(`high: The swap output goes to ${other}, which is NOT the account signing this`)
  })

  test('SOL out: the closeAccount that unwraps the output names where the SOL goes', async () => {
    const { fx, decoded } = await solana('jupiter-shared-accounts-route.json')
    const user = fx.accountKeys[0]
    // The real transaction: the wrapped-SOL output account closes back to the user.
    const calm = assessSigningRisk(solanaRequest(decoded, user))!
    expect(calm.tier).toBe('yellow')
    expect(text(calm)).toContain(`low: Unwraps the swap output and sends it to ${user} (your own account).`)

    // One account swapped: the same swap now pays its whole SOL output to a stranger.
    const other = '8gBF34G1d61hNQpHk2ogXkyxKKv27xDiNKXANqT7Jn67'
    const instructions = decoded.instructions.map((i) => i.instructionName !== 'closeAccount' ? i
      : { ...i, accounts: i.accounts.map((a) => a.label === 'destination' ? { ...a, pubkey: other } : a) })
    const r = assessSigningRisk(solanaRequest({ ...decoded, instructions }, user))!
    expect(r.tier).toBe('red')
    expect(r.level).toBe('high')
    expect(text(r)).toContain(`high: The swap output goes to ${other}, which is NOT the account signing this (${user})`)
    // decode-transaction sets no `from`; the swap's own transfer authority stands in.
    const noFrom = assessSigningRisk({ ...solanaRequest({ ...decoded, instructions }, user), from: undefined })!
    expect(noFrom.tier).toBe('red')
    expect(text(noFrom)).toContain(`The swap output goes to ${other}`)
  })

  test('without `from` (decode-transaction) the output holder is checked against the swap authority', async () => {
    const { fx, decoded } = await solana('jupiter-shared-accounts-route.json')
    const user = fx.accountKeys[0]
    const asDecode = (d: SolanaTxDecodedInfo) => assessSigningRisk({ ...solanaRequest(d, user), from: undefined })!
    const calm = asDecode(decoded)
    expect(calm.tier).toBe('yellow')
    expect(text(calm)).not.toContain('could not check which account receives')

    const jup = decoded.instructions.find((i) => i.programId === JUPITER_V6)!
    const out = jup.accounts.find((a) => a.label === 'destinationTokenAccount')!.pubkey
    const other = '8gBF34G1d61hNQpHk2ogXkyxKKv27xDiNKXANqT7Jn67'
    const moved = asDecode({ ...decoded, tokenAccounts: { ...decoded.tokenAccounts, [out]: { ...decoded.tokenAccounts![out], owner: other } } })
    expect(moved.tier).toBe('red')
    expect(text(moved)).toContain(`high: The swap output goes to ${other}, which is NOT the account signing this (${user}).`)

    // Neither known: said, never skipped.
    const instructions = decoded.instructions.map((i) => i !== jup ? i
      : { ...i, accounts: i.accounts.map((a) => a.label === 'userTransferAuthority' ? { ...a, label: undefined } : a) })
    expect(text(asDecode({ ...decoded, instructions }))).toContain('medium: This computer could not check which account receives the swap output.')
  })

  test('the tokens are named from the accounts that hold them, and an unchecked input is said', async () => {
    const { fx, decoded } = await solana('jupiter-route.json')
    const user = fx.accountKeys[0]
    // The source account was closed on chain after this swap, so it does not resolve.
    expect(text(assessSigningRisk(solanaRequest(decoded, user))))
      .toContain('Swaps 106,207 base units of a token this computer could not check for at least 0.152384077 SOL through Jupiter')

    // The instruction's own label says USDC; the account that receives holds wrapped SOL.
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const instructions = decoded.instructions.map((i) => i.programId !== JUPITER_V6 ? i
      : { ...i, accounts: i.accounts.map((a) => a.label === 'destinationMint' ? { ...a, pubkey: USDC } : a) })
    const t = text(assessSigningRisk(solanaRequest({ ...decoded, instructions }, user)))
    expect(t).toContain(`high: This swap says it pays out token ${USDC}, but the account that receives it holds token So11111111111111111111111111111111111111112.`)
    expect(t).toContain('for at least 0.152384077 SOL')
  })
})

// The Jupiter route above starts with System AdvanceNonceAccount (a durable
// nonce, emulator leg S4 2026-10-30). Its authority is the signing account,
// so it is a normal request: it read red "a System Program action KeepKey
// does not recognize" before this instruction was decoded.
describe('durable nonce (System AdvanceNonceAccount)', () => {
  const NONCE = 'BRuqUm4Ed5HpaAqfmBWD26x9J1FgKLVD6QCn1iexmEiM'
  const withAuthority = (decoded: SolanaTxDecodedInfo, authority: string): SolanaTxDecodedInfo => ({
    ...decoded,
    instructions: decoded.instructions.map((i, n) => n !== 0 ? i
      : { ...i, accounts: i.accounts.map((a) => a.label === 'nonceAuthority' ? { ...a, pubkey: authority } : a) }),
  })

  test('controlled by the signing account: decoded and calm, the swap sets the tone', async () => {
    const { fx, decoded } = await solana('jupiter-route.json')
    const user = fx.accountKeys[0]
    const ix = decoded.instructions[0]
    expect([ix.status, ix.programName, ix.instructionName]).toEqual(['known', 'System Program', 'advanceNonceAccount'])
    expect(ix.accounts.map((a) => [a.label, a.pubkey])).toEqual([
      ['nonceAccount', NONCE], ['recentBlockhashesSysvar', 'SysvarRecentB1ockHashes11111111111111111111'], ['nonceAuthority', user],
    ])
    const r = assessSigningRisk(solanaRequest(decoded, user))!
    const t = text(r)
    expect(t).toContain(`low: Uses durable nonce account ${NONCE.slice(0, 4)}…${NONCE.slice(-4)}, which your own account controls: this transaction does not expire until it is sent or you advance that nonce.`)
    expect(t).not.toContain('does not recognize')
    expect(r.tier).toBe('yellow')
    expect(r.level).toBe('medium')
  })

  test('CONTROL: controlled by another account, or unchecked, keeps the warning', async () => {
    const { fx, decoded } = await solana('jupiter-route.json')
    const user = fx.accountKeys[0]
    const other = fx.accountKeys[1]
    const r = assessSigningRisk(solanaRequest(withAuthority(decoded, other), user))!
    expect(r.tier).toBe('red')
    expect(text(r)).toContain(`high: Uses durable nonce account ${NONCE}, controlled by ${other}, which is NOT the account signing this (${user}).`)
    // No signing account to compare with (no from, no swap naming one).
    const nonceOnly = { ...decoded, instructions: decoded.instructions.slice(0, 1) }
    const unknown = assessSigningRisk({ ...solanaRequest(nonceOnly, user), from: undefined } as SigningRequestInfo)!
    expect(text(unknown)).toContain('this computer could not check who can cancel it')
    expect(unknown.tier).toBe('red')
  })

  // The browser extension's preview (/solana/decode-transaction) passes no
  // `from`. The swap's userTransferAuthority comes from the same bytes as the
  // nonce authority, so it cannot vouch that the user controls the nonce.
  test('CONTROL: no signing account, and the swap names the nonce authority as its user', async () => {
    const { fx, decoded } = await solana('jupiter-route.json')
    const other = fx.accountKeys[1]
    const forged = withAuthority(decoded, other)
    forged.instructions = forged.instructions.map((i) => i.programId !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' ? i
      : { ...i, accounts: i.accounts.map((a) => a.label === 'userTransferAuthority' ? { ...a, pubkey: other } : a) })
    expect(forged.instructions.some((i) => i.accounts.some((a) => a.label === 'userTransferAuthority' && a.pubkey === other))).toBe(true)
    const r = assessSigningRisk({ ...solanaRequest(forged, other), from: undefined } as SigningRequestInfo)!
    expect(text(r)).not.toContain('which your own account controls')
    expect(text(r)).toContain(`high: Uses durable nonce account ${NONCE}. This transaction does not expire, and this computer could not check who can cancel it.`)
  })
})

describe('WalletConnect reads the same accounts as REST', () => {
  test('a Jupiter v0 swap over WalletConnect resolves its lookup tables and reads yellow', async () => {
    const fx = await load('jupiter-route-v2.json') as SolanaFixture & { rawTx: string; slot: number }
    // A local JSON-RPC server answering getMultipleAccounts from the captured
    // account data; anything else (the simulation) gets an RPC error.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { id: number; method: string; params: [string[]] }
        if (body.method !== 'getMultipleAccounts') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not served here' } })
        const value = body.params[0].map((k) => fx.accounts[k] ? { owner: fx.accounts[k]!.owner, data: [fx.accounts[k]!.data, 'base64'] } : null)
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: fx.slot }, value } })
      },
    })
    try {
      let seen: SigningRequestInfo | undefined
      const wc = new WalletConnectManager({
        getSolanaAccountInfo: async () => ({ address: fx.accountKeys[0], addressNList: [] }),
        getFirmwareVersion: () => '7.16.0',
        getSolanaRpcEndpoint: () => server.url.href,
        recordClearSignObservation: () => undefined,
        dismissSigning: () => {},
        requestSigningApproval: async (info: SigningRequestInfo) => { seen = info; return false },
      } as any)
      await expect((wc as any).handleSolanaRequest('solana_signTransaction', { transaction: fx.rawTx }, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'Jupiter'))
        .rejects.toThrow('User rejected signing')
      expect(seen!.solanaDecoded!.altResolutionIncomplete).toBeUndefined()
      const r = assessSigningRisk({ ...seen!, firmwareVersion: '7.16.0' })!
      expect(r.tier).toBe('yellow')
      expect(text(r)).toContain('Swaps 0.4 SOL for at least 206,844,987,752 base units')
    } finally {
      server.stop(true)
    }
  })
})

describe('Token-2022 transfer (PYUSD) read on this computer', () => {
  test('names the token, the amount and the wallet that receives it', async () => {
    const { fx, decoded } = await solana('pyusd-token2022-transfer.json')
    const r = assessSigningRisk(solanaRequest(decoded, fx.accountKeys[0]))!
    expect(r.tier).toBe('yellow')
    expect(r.level).toBe('low')
    const t = text(r)
    // 9ijU…95ew is the recipient's PYUSD account; its ATA create names the owner.
    expect(t).toContain('low: Sends 55 PYUSD to 8gBF34G1d61hNQpHk2ogXkyxKKv27xDiNKXANqT7Jn67.')
    expect(t).toContain('Your KeepKey shows it as raw data')
    expect(t).not.toContain('Token-2022 token. Its issuer')
    // The chain agrees: that wallet's PYUSD balance is the 55 PYUSD sent.
    const got = fx.postTokenBalances.find((b) => b.owner === '8gBF34G1d61hNQpHk2ogXkyxKKv27xDiNKXANqT7Jn67')!
    expect(got.uiTokenAmount.amount).toBe('55000000')
  })

  test('an unnamed Token-2022 mint says its fee and hook settings were not checked', async () => {
    const { fx, decoded } = await solana('pyusd-token2022-transfer.json')
    const fake = 'Fake1111111111111111111111111111111111111111'
    const instructions = decoded.instructions.map((i) => i.instructionName !== 'transferChecked' ? i
      : { ...i, accounts: i.accounts.map((a) => a.label === 'mint' ? { ...a, pubkey: fake } : a) })
    const t = text(assessSigningRisk(solanaRequest({ ...decoded, instructions }, fx.accountKeys[0])))
    expect(t).toContain(`Sends 55 of token ${fake}`)
    expect(t).toContain('medium: This is a Token-2022 token.')
  })
})

// ── TRON ──────────────────────────────────────────────────────────────

describe('TRON calls the firmware shows only as raw data', () => {
  const tron = async (name: string) => {
    const fx = await load('tron-real-transactions.json')
    const hex = fx.transactions[name].raw_data_hex as string
    const req = {
      id: 't', method: '/tron/sign-transaction', appName: 'test', firmwareVersion: '7.16.0',
      tronDecoded: tronPreview(hex) ?? undefined, tronCall: tronCallPreview(hex) ?? undefined,
    } as SigningRequestInfo
    return { hex, req, risk: assessSigningRisk(req)! }
  }

  test('USDT approve, unlimited, to an unknown spender: the approval scam, critical', async () => {
    const { hex, req, risk } = await tron('approve-usdt-unlimited-unknown-spender')
    // The firmware boundary holds: an approve is never summarised as a transfer.
    expect(tronPreview(hex)).toBeNull()
    expect(req.tronCall).toMatchObject({ kind: 'TRC-20 approve', tokenSymbol: 'USDT', spender: 'TTRr81XJt6zESpJw2zHgJNAsxcsyT5MVYv', unlimited: true })
    expect(risk.level).toBe('critical')
    expect(risk.tier).toBe('red')
    expect(text(risk)).toContain('critical: Lets TTRr81XJt6zESpJw2zHgJNAsxcsyT5MVYv spend ALL of your USDT')
    expect(text(risk)).toContain('Sites that steal USDT ask for exactly this approval')
    expect(text(risk)).not.toContain('Sends')
  })

  test('USDT approve, unlimited, to SunSwap Permit2: normal setup, not danger', async () => {
    const { risk } = await tron('approve-usdt-unlimited-sunswap-permit2')
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('yellow')
    expect(text(risk)).toContain('Standard SunSwap setup: gives SunSwap Permit2 (TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9)')
  })

  test('USDT approve, bounded, to an unknown spender: high, with the amount', async () => {
    // Real tooling put the 0x41 prefix inside the ABI address word.
    const { risk } = await tron('approve-usdt-bounded-unknown-spender')
    expect(risk.level).toBe('high')
    expect(text(risk)).toContain('Lets TJ4KeiGTvTX4wRUgLARiwr8rGLaurmVkdZ spend up to 13050 USDT')
  })

  test('staking, votes and resource delegation are described calmly', async () => {
    const expectations: Record<string, string> = {
      'freeze-balance-v2': 'Stakes 6.841298 TRX for energy.',
      'unfreeze-balance-v2': 'Unstakes 10 TRX of energy stake.',
      'withdraw-expire-unfreeze': 'Moves TRX whose unstaking waiting period has ended back to your balance.',
      'vote-witness': 'Votes for TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M (563687 votes).',
      'delegate-resource': 'Lends the energy of 7600 TRX of your stake to TDXgZksAAuxBkNVJSVCU78x3oDse9DjBmN.',
    }
    for (const [name, sentence] of Object.entries(expectations)) {
      const { risk } = await tron(name)
      expect(risk.tier).toBe('yellow')
      expect(risk.level).toBe('medium')
      expect(text(risk)).toContain(`low: ${sentence}`)
    }
  })

  test('a SunSwap Smart Router swap back to the signer is read and not danger', async () => {
    const { req, risk } = await tron('sunswap-smart-router-swap')
    expect(req.tronCall).toMatchObject({ kind: 'SunSwap swap', to: 'TZD9mQABhN985fXwYGCf9zVF4kUhvEwALE', owner: 'TZD9mQABhN985fXwYGCf9zVF4kUhvEwALE' })
    expect(risk.tier).toBe('yellow')
    expect(risk.level).toBe('medium')
    // On chain (gettransactioninfobyid) the signer sent exactly this amount and
    // received 20493.553264 USDT, above this minimum.
    expect(text(risk)).toContain('medium: Swaps 11746351679000000127345623040 base units of token TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6 for at least 20391.085493 USDT through the SunSwap Smart Router (TJ4NNy8xZEqsowCBhLvZ45LCqPdGjkET5j).')
    expect(text(risk)).toContain('cannot show SunSwap swaps on the device yet')
    expect(text(risk)).not.toContain('NOT the account signing this')
  })

  test('a SunSwap swap paying out to someone else is red; a router call it cannot read stays red', async () => {
    const fx = await load('tron-real-transactions.json')
    const hex = fx.transactions['sunswap-smart-router-swap'].raw_data_hex as string
    const assess = (h: string) => assessSigningRisk({
      id: 't', method: '/tron/sign-transaction', appName: 'test', firmwareVersion: '7.16.0', tronCall: tronCallPreview(h) ?? undefined,
    } as SigningRequestInfo)!
    // The `to` word of SwapData (the owner's 20 bytes, ABI-padded) set to another address.
    const toWord = '000000000000000000000000feee0400969ba3be9522e1870496a2b5aa351ff9'
    expect(hex.split(toWord).length).toBe(2)
    const paid = assess(hex.replace(toWord, '000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c'))
    expect(paid.tier).toBe('red')
    expect(text(paid)).toContain('high: The swap output goes to TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t, which is NOT the account signing this (TZD9mQABhN985fXwYGCf9zVF4kUhvEwALE).')

    const other = assess(hex.replace('cef95229', 'cef95228'))
    expect(other.tier).toBe('red')
    expect(text(other)).toContain('Calls the SunSwap Smart Router (TJ4NNy8xZEqsowCBhLvZ45LCqPdGjkET5j)')
  })
})

// ── Cosmos Hub amino ──────────────────────────────────────────────────

describe('Cosmos Hub amino requests (REST and WalletConnect)', () => {
  const cosmos = async (name: string, edit?: (doc: any) => void) => {
    const fx = await load('cosmos-amino-real.json')
    const { signerAddress, signDoc } = structuredClone(fx.requests[name])
    edit?.(signDoc)
    return assessSigningRisk({
      id: 't', method: '/cosmos/sign-amino', appName: 'test', chain: 'cosmos', from: signerAddress,
      rawRequestBody: { signerAddress, signDoc },
    } as SigningRequestInfo)!
  }

  test('MsgSend, MsgDelegate and IBC MsgTransfer are described and green', async () => {
    const send = await cosmos('msg-send')
    expect(send.tier).toBe('green')
    expect(text(send)).toContain('Sends 200 ATOM to cosmos1wey473vwghyaxpqnvn24kfvfn5zxjc8gpwczwk.')
    const del = await cosmos('msg-delegate')
    expect(del.tier).toBe('green')
    expect(text(del)).toContain('Stakes 9.677551 ATOM with validator cosmosvaloper1gf3dm2mvqhymts6ksrstlyuu2m8pw6dhfp9md2.')
    const ibc = await cosmos('ibc-transfer')
    expect(ibc.tier).toBe('green')
    expect(text(ibc)).toContain('Sends 242.811669 ATOM over IBC (transfer/channel-141) to osmo1rgf4z0qljnsaq2tt5dzr058snqahfkhak7d7z8 on another chain.')
  })

  test('a message acting for another account is high', async () => {
    const r = await cosmos('msg-send', (doc) => { doc.msgs[0].value.from_address = 'cosmos1wey473vwghyaxpqnvn24kfvfn5zxjc8gpwczwk' })
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('NOT the account signing this')
  })

  test('an authz grant is critical, an unknown type is high and not green', async () => {
    const grant = await cosmos('msg-send', (doc) => { doc.msgs[0].type = 'cosmos-sdk/MsgGrant' })
    expect(grant.level).toBe('critical')
    const other = await cosmos('msg-send', (doc) => { doc.msgs[0].type = 'cosmos-sdk/MsgVote' })
    expect(other.level).toBe('high')
    expect(other.tier).toBe('red')
  })
})
