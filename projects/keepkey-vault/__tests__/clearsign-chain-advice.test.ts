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

  test('a SunSwap router call is named but not called decoded', async () => {
    const { risk } = await tron('sunswap-smart-router-swap')
    expect(risk.tier).toBe('red')
    expect(risk.level).toBe('medium')
    expect(text(risk)).toContain('Calls the SunSwap Smart Router (TJ4NNy8xZEqsowCBhLvZ45LCqPdGjkET5j)')
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
