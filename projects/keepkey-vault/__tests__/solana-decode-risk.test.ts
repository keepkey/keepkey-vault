/**
 * POST /solana/decode-transaction returns the vault's OWN risk sentences.
 *
 * Why this test exists: the browser extension asks the user to approve a dApp
 * transaction before the vault ever sees it, so the decode endpoint is the
 * first (and for an unknown program, only) place a human-readable warning can
 * come from. If the endpoint returns just the decoded rows, the caller invents
 * its own wording — two vocabularies for one transaction, and the softer one is
 * the one the user reads.
 *
 * The payload is a real mainnet bet captured from the extension: a SoltoshiDICE
 * Cee-lo wager whose SDICE moves by CPI from inside the game program, so no
 * transfer instruction appears in the bytes. That is precisely the case where
 * the honest answer is "KeepKey cannot read this", and the case a static
 * decoder must not dress up as safe.
 */
import { describe, test, expect } from 'bun:test'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import fixture from './fixtures/solana/soltoshidice-ceelo-bet.json'

const GAME_PROGRAM = 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR'

// No lookup tables in this transaction, so the decode needs no RPC. A fetcher
// that throws proves it: if anything reached for the network this test fails.
const noAlt = async () => {
  throw new Error('ALT fetch attempted — this fixture has no lookup tables')
}

describe('decode-transaction risk (live Cee-lo bet)', () => {
  test('the bet decodes to ComputeBudget + an unreadable game program', async () => {
    const d = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlt as any)
    expect(d.instructions.length).toBe(2)
    expect(d.instructions[0].status).toBe('known')
    const game = d.instructions[1]
    expect(game.status).toBe('unknown-program')
    expect(game.programId).toBe(GAME_PROGRAM)
  })

  test('risk is returned, is not low, and names the program that cannot be read', async () => {
    const d = await buildSolanaDecodedInfo(fixture.rawTxBase64, noAlt as any)
    const risk = assessSigningRisk({
      id: 'decode',
      method: 'solana_decodeTransaction',
      appName: 'decode',
      chain: 'solana',
      solanaDecoded: d,
      requiresBlindSigningConsent: true,
    } as any)

    expect(risk).not.toBeNull()
    expect(risk!.level === 'high' || risk!.level === 'critical').toBe(true)
    const text = [risk!.headline, ...risk!.reasons.map((r) => r.text)].join(' ')
    // The sentence must name the program and say it can move funds — a generic
    // "unknown transaction" would let the caller downgrade it to a shrug.
    expect(text).toContain(GAME_PROGRAM.slice(0, 6))
    expect(text.toLowerCase()).toContain('cannot read')
  })

  test('a decode failure still yields a risk assessment, never silence', () => {
    const risk = assessSigningRisk({
      id: 'decode',
      method: 'solana_decodeTransaction',
      appName: 'decode',
      chain: 'solana',
      solanaDecodeError: 'SolanaTxParseError: Malformed Solana transaction',
      requiresBlindSigningConsent: true,
    } as any)
    expect(risk).not.toBeNull()
    expect(risk!.level === 'high' || risk!.level === 'critical').toBe(true)
  })
})
