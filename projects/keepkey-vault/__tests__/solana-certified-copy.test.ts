/**
 * The words a user reads for a certified Solana call — and the line those words
 * must not cross.
 *
 * A KeepKey-certified schema binds three things: the program's address, the
 * name of the instruction, and the layout the values are read at. It binds
 * nothing about where the money goes, nothing about the site that asked, and
 * nothing about whether the program is honest. Copy that lets a user read it as
 * "KeepKey says this is safe" is a worse failure than showing nothing, because
 * it is the certified path that skips the blind-signing consent.
 *
 * Driven by the real pair captured from production: the live SoltoshiDICE
 * "Blackjack join" transaction and the production ClearSign Worker's own
 * response to it (tokenInfo included), so the rendered values are checked
 * against what the chain and the delegate actually said.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { describeCertifiedSolanaTransaction } from '../src/bun/solana-certified-describe'
import { findCertifiedSolanaProof, type CertifiedSolanaProof } from '../src/bun/solana-certified-registry'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { assessSigningRisk, formatCertifiedArg } from '../src/shared/clearsign-risk'
import type { SigningRequestInfo } from '../src/shared/types'
import joinFixture from './fixtures/solana/soltoshidice-blackjack-join.json'
import envelopeFixture from './fixtures/solana/soltoshidice-join-certified-envelope.json'
import ceeloFixture from './fixtures/solana/soltoshidice-ceelo-bet.json'

const originalFetch = globalThis.fetch
const originalServiceUrl = process.env.CLEARSIGN_SERVICE_URL
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalServiceUrl === undefined) delete process.env.CLEARSIGN_SERVICE_URL
  else process.env.CLEARSIGN_SERVICE_URL = originalServiceUrl
})

const noAlts = async (): Promise<never> => { throw new Error('legacy fixture must not fetch ALTs') }

/** The mint the soltoshidiceBlackjackJoin catalog entry pins locally. */
const SDICE_MINT = '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump'

/** The envelope exactly as the production Worker returned it, through the same
 *  parser the signing gate uses — not a hand-built object. */
async function workerProof(edit: (body: any) => void = () => {}): Promise<CertifiedSolanaProof> {
  const body = JSON.parse(JSON.stringify(envelopeFixture.response))
  edit(body)
  process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  const proof = await findCertifiedSolanaProof(joinFixture.rawTxBase64, 'soltoshidiceBlackjackJoin')
  if (!proof) throw new Error('fixture envelope did not parse')
  return proof
}

describe('describeCertifiedSolanaTransaction — read back what was signed', () => {
  test('every value comes out in the label and unit the schema fixes', async () => {
    const d = describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, await workerProof())!
    expect(d.programId).toBe(joinFixture.expected.programId)
    expect(d.programName).toBe('SoltoshiDICE')
    expect(d.instructionName).toBe('Blackjack join')

    const v = joinFixture.expected.values
    expect(d.args.map((a) => [a.label, a.raw])).toEqual([
      ['Round', v.round],
      ['Revision', v.revision],
      ['Seat', String(v.seat)],
      ['Buy-in', v.buyIn],
      ['Session key', v.sessionKey],
      ['Expires in', v.seconds],
      ['Allowance', v.allowance],
      ['Max wager', v.maxWager],
    ])
    // The amount's mint is the account the schema points at, not a guess.
    expect(d.args.find((a) => a.label === 'Buy-in')?.mint).toBe(joinFixture.expected.mint)
    expect(d.args.map((a) => `${a.label} ${formatCertifiedArg(a)}`)).toContain('Buy-in 1,000 SDICE')
    expect(d.args.map((a) => `${a.label} ${formatCertifiedArg(a)}`)).toContain('Expires in 1 h')
  })

  test('a token is named only when the delegate attested that exact mint', async () => {
    const unattested = await workerProof((body) => { delete body.tokenInfo })
    const d = describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, unattested)!
    const buyIn = d.args.find((a) => a.label === 'Buy-in')!
    expect(buyIn.symbol).toBeUndefined()
    // Raw base units and the mint — a ticker nobody signed for is exactly how a
    // fake token passes for a real one.
    expect(formatCertifiedArg(buyIn)).toBe('1,000,000,000 base units of token 4nCm…pump')
    expect(formatCertifiedArg(buyIn)).not.toContain('SDICE')
  })

  // Nothing in this process verifies the attestation's signature — only the
  // device does. So the host renders a ticker only where the attestation and
  // the catalog entry's locally pinned token agree; otherwise the ticker would
  // be a name the user has no way to check, and one the device may not show.
  describe('a ticker needs the attestation and the local pin to agree', () => {
    test('they agree on the real envelope, so the ticker renders', async () => {
      const d = describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, await workerProof())!
      const buyIn = d.args.find((a) => a.label === 'Buy-in')!
      expect(buyIn.mint).toBe(SDICE_MINT)
      expect(buyIn.symbol).toBe('SDICE')
      expect(buyIn.decimals).toBe(6)
      expect(formatCertifiedArg(buyIn)).toBe('1,000 SDICE')
    })

    test('a symbol the pin does not carry falls back to raw base units', async () => {
      const wrongSymbol = await workerProof((body) => { body.tokenInfo[0].symbol = 'USDC' })
      const buyIn = describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, wrongSymbol)!
        .args.find((a) => a.label === 'Buy-in')!
      expect(buyIn.symbol).toBeUndefined()
      expect(buyIn.decimals).toBeUndefined()
      expect(formatCertifiedArg(buyIn)).toBe('1,000,000,000 base units of token 4nCm…pump')
      expect(formatCertifiedArg(buyIn)).not.toContain('USDC')
    })

    test('decimals the pin does not carry fall back too — a shifted point is a 1000x lie', async () => {
      const wrongDecimals = await workerProof((body) => { body.tokenInfo[0].decimals = 9 })
      const buyIn = describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, wrongDecimals)!
        .args.find((a) => a.label === 'Buy-in')!
      expect(buyIn.decimals).toBeUndefined()
      expect(formatCertifiedArg(buyIn)).toBe('1,000,000,000 base units of token 4nCm…pump')
      expect(formatCertifiedArg(buyIn)).not.toContain('1 SDICE')
    })

    test('an attestation for a different mint is not applied to this one', async () => {
      const otherMint = await workerProof((body) => {
        body.tokenInfo[0].mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
        body.tokenInfo[0].symbol = 'USDC'
      })
      const buyIn = describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, otherMint)!
        .args.find((a) => a.label === 'Buy-in')!
      expect(buyIn.mint).toBe(SDICE_MINT)
      expect(buyIn.symbol).toBeUndefined()
      expect(formatCertifiedArg(buyIn)).toBe('1,000,000,000 base units of token 4nCm…pump')
    })
  })

  test('a schema payload that is not the reviewed entry describes nothing', async () => {
    const tampered = await workerProof()
    tampered.schema.payload = `ff${tampered.schema.payload.slice(2)}`
    expect(describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, tampered)).toBeUndefined()
  })

  test('a transaction the envelope was not issued for describes nothing', async () => {
    // The live Cee-lo bet: same program, different instruction, no catalog
    // entry — so there is nothing certified to show for it.
    expect(describeCertifiedSolanaTransaction(ceeloFixture.rawTxBase64, await workerProof())).toBeUndefined()
  })
})

describe('risk copy for a certified call', () => {
  async function certifiedRequest(): Promise<SigningRequestInfo> {
    return {
      method: '/solana/sign-transaction',
      solanaDecoded: await buildSolanaDecodedInfo(joinFixture.rawTxBase64, noAlts),
      deviceClearSigns: true,
      solanaCertified: describeCertifiedSolanaTransaction(joinFixture.rawTxBase64, await workerProof()),
    } as SigningRequestInfo
  }

  test('names the call and its amounts in plain words', async () => {
    const risk = assessSigningRisk(await certifiedRequest())!
    const text = risk.reasons.map((r) => r.text).join('\n')
    expect(text).toContain('"SoltoshiDICE — Blackjack join"')
    expect(text).toContain('Buy-in 1,000 SDICE')
    expect(text).toContain('Network fee: up to 0.000005 SOL')
  })

  test('the certified name does not soften the verdict', async () => {
    const request = await certifiedRequest()
    const named = assessSigningRisk(request)!
    const unnamed = assessSigningRisk({ ...request, solanaCertified: undefined })!
    expect(named.level).toBe(unnamed.level)
    // Still says the code can move funds, and still warns about the session key.
    expect(named.reasons.map((r) => r.text).join('\n')).toContain('able to move your SOL or tokens')
    expect(named.reasons.map((r) => r.text).join('\n')).toContain('permission to act for you')
  })

  test('no sentence promises safety, honesty or a destination', async () => {
    const text = assessSigningRisk(await certifiedRequest())!.reasons.map((r) => r.text).join('\n').toLowerCase()
    for (const forbidden of ['is safe', 'trusted program', 'guarantee', 'audited', 'approved by keepkey', 'funds are safe']) {
      expect(text).not.toContain(forbidden)
    }
    // The claim it DOES make about the program's freedom must survive.
    expect(text).toContain('able to move your sol or tokens')
  })

  // This sentence must NOT read as a total. The Cee-lo dapp's own code asks for
  // deposit + account rent + fee, and warns "a refundable 0.01 SOL deposit plus
  // network and account fees" — so a line that added only the deposit and the
  // fee and called it "SOL this call puts up" understated the real ask by ~2x.
  // Account rent is not in the instruction's bytes, so the copy names what it
  // has and says the rent is extra. The exact strings are pinned: this is the
  // number a user decides on.
  test('a SOL amount the schema names is given as the deposit and the fee, never as a total', () => {
    // The Cee-lo shape: a lamports deposit inside the certified instruction.
    // (The catalog entry for it lands separately; the copy is checked here.)
    const risk = assessSigningRisk({
      method: '/solana/sign-transaction',
      deviceClearSigns: true,
      solanaDecoded: {
        version: 'legacy', staticAccountCount: 4, altPubkeys: [], assetPrograms: ['SPL Token'],
        maxNetworkFeeLamports: '5000',
        instructions: [{
          status: 'unknown-program', programId: 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR',
          programName: 'CuTLp7…VWBR', args: [], accounts: [],
        }],
      },
      solanaCertified: {
        programId: 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR',
        programName: 'SoltoshiDICE',
        instructionName: 'Cee-lo place bet',
        args: [
          { label: 'Wager', kind: 'token', raw: '1000000000', mint: '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump', symbol: 'SDICE', decimals: 6 },
          { label: 'Deposit', kind: 'sol', raw: '10000000' },
        ],
      },
    } as SigningRequestInfo)!
    const text = risk.reasons.map((r) => r.text).join('\n')
    expect(text).toContain('Wager 1,000 SDICE')
    expect(text).toContain(
      'SOL named in this call: 0.01 SOL (Deposit), plus up to 0.000005 SOL of network fee. '
      + 'Account rent is extra and is not in these bytes, so this is not the total SOL leaving '
      + 'your wallet, and it is not a limit on what the program can move.')
    // The old wording added deposit + fee and presented the sum as the ask.
    expect(text).not.toContain('0.010005')
    expect(text).not.toContain('puts up')
  })
})

describe('the vouch in the approval overlay', () => {
  const overlay = readFileSync(new URL('../src/mainview/components/device/SigningApproval.tsx', import.meta.url), 'utf8')
  const vouch = overlay.slice(overlay.indexOf('function CertifiedVouch'), overlay.indexOf('// ── Solana decoded section'))

  test('says what the signature covers, and shows who asked', () => {
    expect(vouch).toContain('KeepKey ClearSign recognises this program')
    expect(vouch).toContain("That signature covers the program's address, the name of this instruction")
    expect(vouch).toContain('Asked for by {appName}')
  })

  test('says in as many words that it is not a check of the site or the destination', () => {
    expect(vouch).toContain('It is not a check of this site, of where the money goes')
  })

  test('never calls the program safe, verified or trusted', () => {
    for (const forbidden of [/\bsafe\b/i, /\bverified\b/i, /\btrusted\b/i, /guarantee/i]) {
      expect(vouch).not.toMatch(forbidden)
    }
  })

  test('is rendered only from the vault\'s own certified description', () => {
    // Not from anything the caller sent: the field is set in the signing gate
    // after the envelope is checked, never from the request body.
    expect(overlay).toContain('{request.solanaCertified && (')
  })
})
