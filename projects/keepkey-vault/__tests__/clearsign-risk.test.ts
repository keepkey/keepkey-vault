/**
 * Risk bar levels, driven by REAL payloads from a live session
 * (soltoshidice.wtf, 2026-09-17, Vault api_log ids 108386/108402/108426).
 * Expected levels are anchored to what the transactions actually did on
 * mainnet, not to what this code produces:
 *   tx1 4CUN7Bii… — unknown program, System Program present; user paid
 *                   0.00264152 SOL into a new account.
 *   tx2 5ibnS5og… — unknown program (RegisterPokerTournament), no System or
 *                   Token program in the account list; fee only.
 * See docs/clearsign-case-studies/2026-09-17-solana-signmessage-login.md.
 */
import { describe, expect, test } from 'bun:test'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { buildSolanaMessageDecodedInfo } from '../src/bun/solana-message-preview'
import { parseSolanaTx, solanaMessageSlice } from '../src/bun/solana-tx'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import type { SigningRequestInfo } from '../src/shared/types'
import joinFixture from './fixtures/solana/soltoshidice-blackjack-join.json'

const LOGIN_MESSAGE_B64 = 'U29sdG9zaGlESUNFIHdhbGxldApOZXR3b3JrOiBtYWlubmV0LWJldGE6Q3VUTHA3cERtTkdrRmdpNGFvaDhFZjFZU2pjMkJ6RUNRUkx6WXFhb1ZXQlI6NG5DbXB3bmU3aENvV1RTcEFkNTR1RU5tQ2dISnJIVHluNERNUENFTXB1bXAKU2Vzc2lvbjogY2E1ZWQ3YTgtNWRmMS00MWJmLTkxY2EtYzNkZTRjMWM1NmY2Ck5vbmNlOiAzN2M0MDY2Ny01NzZkLTQwNTQtOTA2NC02MTg2MTRhYjg4YzE='
const TX1_B64 = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYJ7Dl5pNxrQBvQRRcaGJ8mhW+rnqt1VgIU+XKy7cFkMA+LZzzaLik+AiCrPgHStY7QVcnBsnYt1RVhKxDKzW40NrgTPK+soJctzdQsxyxkxmokWe10HSLNM0pp7sZO3eosAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg+JYP7kag/aX3JhxSBLr/9dbITv9zclr5W8RVNHvjowF02rdo/npIS0+fAcrrAThIR97VGw7P8fmeJwQ9+Dk5hH08KOLLv/nnxPfLbW1x5bwW1Qqm7U/+OurmoNbG6qQDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAALDgivSk/PrRPvj8/Z3HCXXrb8LgSnx2YRVApRzV257QTQBKpt9xx9nI6TgJCP4k4JahDgt0ODAlVydCDyS4WCcCBwAFAjBXBQAIBwAGBAECBQMDE2tr'
const TX2_B64 = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAMF7Dl5pNxrQBvQRRcaGJ8mhW+rnqt1VgIU+XKy7cFkMA+SBSuyLMLvVQz9EGEI1MlPMqG9kd7zy9ZhLt6hHKwPl6Y7uSvSGri0hA8PAemDek6VnFE/45RVFzBlG83Ut0blAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAD6i7mj/GndyNFb30gki6saw6J1Z/S55kobvO8xLhIbY4xiSIqbqZbckuOiNYzUip23axu1Rxj1/Xqq2y+NQrHuAgMABQLgkwQAAgMABAEIkVzQjkYeoSY='

// Hash Holdem session 2 (api_log 108760 / 108799 / 108805), on-chain outcomes:
//   ENTER   4fdHkmL7… EnterPokerTournament: −10,000 4nCm…pump via CPI TransferChecked
//   SESSION 3XwHPEnT… AuthorizeSession: 0.02 SOL → 6TD5…; 6TD5 then signed game moves alone
//   READY   5q6Aexqe… SetReady: fee only
const ENTER_B64 = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAYL7Dl5pNxrQBvQRRcaGJ8mhW+rnqt1VgIU+XKy7cFkMA8SheB/xXMu5ZIC8NnZz6PE5cL0+ZboF2OXndzp9GPOtJIFK7Iswu9VDP0QYQjUyU8yob2R3vPL1mEu3qEcrA+X6yS/JFhi7aS1IbKNRnwmCKpETc+wyjkUFJMCjqvQl2j8TaJY12piqmoMZB00zvwzyX8LlCTBZ44m7iW0xJt72jgngkHaA8cN0PyIX3rSEjutMrM6VAI0BzmviuXYTKzvRi7VYPgikW++mwY+JAw5bCiMBVvWRcLHmh4LrZ31YmSmO7kr0hq4tIQPDwHpg3pOlZxRP+OUVRcwZRvN1LdG5dYGiIfcl1ZePr3GpIuh3EgIlrbRUzOqy1dSV0dvC54T+ou5o/xp3cjRW99IJIurGsOidWf0ueZKG7zvMS4SG2MG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/GWIlmkQQYD34Y0ANKH4kE4xYcyCyUjyuaArBaJfEJHtAQcKAAkCCAEGAwQFCgmyTrrkDy0EBAA='
const SESSION_B64 = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAMG7Dl5pNxrQBvQRRcaGJ8mhW+rnqt1VgIU+XKy7cFkMA9RAS+mwyauUGfLcy++uAwgs1bYRKJcf0Ul/jg7aZzXI5+gozL5nAZjETjChwnAUfAQmnWnB1NncdEPZ4EYu/l3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACmO7kr0hq4tIQPDwHpg3pOlZxRP+OUVRcwZRvN1LdG5dYGiIfcl1ZePr3GpIuh3EgIlrbRUzOqy1dSV0dvC54Tm/IE1cN/Wie7R6ETBuu5G3aXCkSSpSQSChjc6ttOfFECAwIAAQwCAAAAAC0xAQAAAAAEBAAFAgMwu9r7oWMoIiJRAS+mwyauUGfLcy++uAwgs1bYRKJcf0Ul/jg7aZzXI3KcrGoAAAAA'
const READY_B64 = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAQG7Dl5pNxrQBvQRRcaGJ8mhW+rnqt1VgIU+XKy7cFkMA8SheB/xXMu5ZIC8NnZz6PE5cL0+ZboF2OXndzp9GPOtEYu1WD4IpFvvpsGPiQMOWwojAVb1kXCx5oeC62d9WJkpju5K9IauLSEDw8B6YN6TpWcUT/jlFUXMGUbzdS3RuXWBoiH3JdWXj69xqSLodxICJa20VMzqstXUldHbwueE/qLuaP8ad3I0VvfSCSLqxrDonVn9LnmShu87zEuEhtjKPzWlP+OgoVuVH+GwdxwvA5SdGHTJ55mQY2p9/07oeABAwUABAECBQlpTgeitae6KwE='

const noAlts = async () => { throw new Error('legacy tx must not fetch ALTs') }

async function txRequest(rawB64: string): Promise<SigningRequestInfo> {
  return {
    method: '/solana/sign-transaction',
    solanaDecoded: await buildSolanaDecodedInfo(rawB64, noAlts),
  } as SigningRequestInfo
}

function messageRequest(message: string): SigningRequestInfo {
  return {
    method: '/solana/sign-message',
    solanaMessageDecoded: buildSolanaMessageDecodedInfo(message, { encoding: 'base64' }),
  } as SigningRequestInfo
}

describe('assessSigningRisk — live session payloads', () => {
  test('text login message is LOW: provably not a transaction', () => {
    const r = assessSigningRisk(messageRequest(LOGIN_MESSAGE_B64))!
    expect(r.level).toBe('low')
  })

  test('tx1: unknown program + System Program present is HIGH', async () => {
    const r = assessSigningRisk(await txRequest(TX1_B64))!
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toContain('able to move your SOL or tokens')
  })

  test('tx2: unknown program, no asset program is MEDIUM', async () => {
    const r = assessSigningRisk(await txRequest(TX2_B64))!
    expect(r.level).toBe('medium')
  })

  test('EnterPokerTournament (took 10,000 tokens via CPI) is HIGH', async () => {
    const r = assessSigningRisk(await txRequest(ENTER_B64))!
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toContain('nobody can show you how much')
  })

  test('AuthorizeSession: names the amount AND the delegated key', async () => {
    const r = assessSigningRisk(await txRequest(SESSION_B64))!
    expect(r.level).toBe('high')
    const text = r.reasons.map((x) => x.text).join('\n')
    expect(text).toContain('Sends 0.02 SOL to 6TD5…T6kr.')
    expect(text).toContain('Gives 6TD5…T6kr permission to act for you')
  })

  test('SetReady (fee only) is MEDIUM and says so', async () => {
    const r = assessSigningRisk(await txRequest(READY_B64))!
    expect(r.level).toBe('medium')
    expect(r.reasons[0].text).toContain('You only pay the network fee')
  })

  test('tx message bytes submitted as a "message" are CRITICAL', () => {
    const full = Buffer.from(TX2_B64, 'base64')
    const msg = Buffer.from(solanaMessageSlice(full, parseSolanaTx(full))).toString('base64')
    expect(assessSigningRisk(messageRequest(msg))!.level).toBe('critical')
  })
})

describe('assessSigningRisk — certified Solana route', () => {
  test('says the device shows the call instead of claiming nobody can read it', async () => {
    const opaque = assessSigningRisk(await txRequest(joinFixture.rawTxBase64))!
    const certified = assessSigningRisk({ ...(await txRequest(joinFixture.rawTxBase64)), deviceClearSigns: true })!
    expect(opaque.reasons.map((r) => r.text).join('\n')).toContain('KeepKey cannot read (')
    const text = certified.reasons.map((r) => r.text).join('\n')
    expect(text).not.toContain('cannot read')
    expect(text).not.toContain('nobody can show you how much')
    expect(text).toContain('KeepKey-certified description')
    // The session-key warning and the level are unchanged.
    expect(text).toContain('permission to act for you')
    expect(certified.level).toBe(opaque.level)
  })
})

describe('assessSigningRisk — rules', () => {
  const base = { method: '/solana/sign-transaction' } as SigningRequestInfo

  test('decode failure is HIGH, never low', () => {
    expect(assessSigningRisk({ ...base, solanaDecodeError: 'SolanaTxParseError: x' })!.level).toBe('high')
  })

  test('token approve is CRITICAL even when fully decoded', () => {
    const r = assessSigningRisk({
      ...base,
      solanaDecoded: {
        version: 'legacy', staticAccountCount: 3, altPubkeys: [],
        assetPrograms: ['SPL Token'],
        instructions: [{
          status: 'known', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          programName: 'SPL Token', instructionName: 'approve', args: [], accounts: [],
        }],
      },
    })!
    expect(r.level).toBe('critical')
    expect(r.reasons[0].text).toContain('spend some of your tokens')
  })

  test('unlimited approve says ALL', () => {
    const r = assessSigningRisk({
      ...base,
      solanaDecoded: {
        version: 'legacy', staticAccountCount: 3, altPubkeys: [], assetPrograms: ['SPL Token'],
        instructions: [{
          status: 'known', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', programName: 'SPL Token',
          instructionName: 'approve', args: [{ name: 'amount', type: 'u64', value: '18446744073709551615' }],
          accounts: [{ label: 'delegate', pubkey: 'Hs2VtY9dYU1RsXPn7aJt49pF2MiVh4KAzQq8Eu82BmWa' }],
        }],
      },
    })!
    expect(r.reasons[0].text).toBe('Lets Hs2V…BmWa spend ALL of your tokens, now and later, without asking you again.')
  })

  test('unrecognized instruction on an asset program is HIGH', () => {
    const r = assessSigningRisk({
      ...base,
      solanaDecoded: {
        version: 'legacy', staticAccountCount: 2, altPubkeys: [],
        assetPrograms: ['System Program'],
        instructions: [{
          status: 'known-program-unknown-ix', programId: '11111111111111111111111111111111',
          programName: 'System Program', args: [], accounts: [],
        }],
      },
    })!
    expect(r.level).toBe('high')
  })

  test('unresolved lookup tables are HIGH (hidden accounts)', () => {
    const r = assessSigningRisk({
      ...base,
      solanaDecoded: {
        version: 'v0', staticAccountCount: 2, altPubkeys: ['x'], altResolutionIncomplete: true,
        assetPrograms: [], instructions: [],
      },
    })!
    expect(r.level).toBe('high')
  })

  test('chains without rules get no bar yet', () => {
    expect(assessSigningRisk({ method: '/cosmos/sign-amino' } as SigningRequestInfo)).toBeNull()
  })
})

describe('assessSigningRisk — EVM', () => {
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const SPENDER = '000000000000000000000000' + '1111111254eeb25477b68fb85ed929f73a960582'
  const word = (n: bigint) => n.toString(16).padStart(64, '0')
  const tx = (data: string, extra: Partial<SigningRequestInfo> = {}) =>
    assessSigningRisk({ method: '/eth/sign-transaction', to: USDC, chainId: 1, value: '0', data, ...extra } as SigningRequestInfo)!

  test('unlimited approve is CRITICAL and says ALL, full spender address', () => {
    const r = tx('0x095ea7b3' + SPENDER + word((1n << 256n) - 1n))
    expect(r.level).toBe('critical')
    expect(r.reasons[0].text).toBe('Lets 0x1111111254eeb25477b68fb85ed929f73a960582 spend ALL of your USDC, now and later, without asking you again.')
  })

  test('finite approve is still CRITICAL with the amount', () => {
    const r = tx('0x095ea7b3' + SPENDER + word(1_000_000_000n))
    expect(r.level).toBe('critical')
    expect(r.reasons[0].text).toContain('up to 1,000 USDC')
  })

  test('real Arbitrum Uniswap setup approval says USDT, Permit2, and not all wallet tokens', () => {
    const permit2 = '000000000000000000000000' + '000000000022d473030f116ddee9f6b43ac78ba3'
    const r = tx('0x095ea7b3' + permit2 + word((1n << 256n) - 1n), {
      chainId: 42161,
      to: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    })
    expect(r.level).toBe('medium')
    expect(r.reasons[0].text).toBe('Standard Uniswap setup: gives canonical Permit2 persistent access to your Arbitrum USDT. You can revoke this allowance later.')
    expect(r.reasons[0].text).not.toContain('ALL of your tokens')
  })

  test('revoke on a known token is LOW', () => {
    expect(tx('0x095ea7b3' + SPENDER + word(0n)).level).toBe('low')
  })

  test('approve with a dirty address word is HIGH blind, not a clean fallback', () => {
    const r = tx('0x095ea7b3' + 'ff' + SPENDER.slice(2) + word(1n), { deviceClearSigns: true })
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toContain('signing blind')
  })

  test('opaque contract call is HIGH blind', () => {
    const r = tx('0x12345678' + word(1n), { to: '0x000000000000000000000000000000000000dead' })
    expect(r.level).toBe('high')
  })

  test('malformed calldata is HIGH, never "calls no contract"', () => {
    expect(tx('0xnothex').level).toBe('high')
  })

  test('plain ETH send is LOW with the amount', () => {
    const r = tx('0x', { value: '500000000000000000' })
    expect(r.level).toBe('low')
    expect(r.reasons[0].text).toContain('0.5 ETH')
  })

  test('Permit2 signature remains CRITICAL while 7.15+ reports structured device review', () => {
    const r = assessSigningRisk({
      method: '/eth/sign-typed-data',
      typedDataDecoded: {
        operationName: 'Permit2', primaryType: 'PermitSingle', isKnownType: true,
        domain: { verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
        fields: [
          { label: 'Amount', value: 'max', format: 'amount', raw: ((1n << 160n) - 1n).toString() },
          { label: 'Spender', value: '0xabc', format: 'address', raw: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad' },
        ],
      },
      firmwareVersion: '7.16.0',
    } as SigningRequestInfo)!
    expect(r.level).toBe('critical')
    expect(r.reasons[0].text).toContain('spend ALL of your tokens')
    expect(r.reasons.some((x) => x.level === 'high' && x.text.includes('hash'))).toBe(false)
    expect(r.reasons.some((x) => x.text.includes('structured fields'))).toBe(true)
  })

  test('official Arbitrum Uniswap Permit2 names USDT, router, and expiration without generic wallet-wide alarm', () => {
    const r = assessSigningRisk({ method: '/eth/sign-typed-data', firmwareVersion: '7.16.0', typedDataDecoded: {
      operationName: 'Permit2 (Single)', primaryType: 'PermitSingle', isKnownType: true, protocolIdentityVerified: true,
      domain: { chainId: 42161, verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
      fields: [
        { label: 'Token', value: '0xfd08…fbb9', raw: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', format: 'address' },
        { label: 'Amount', value: 'max', raw: ((1n << 160n) - 1n).toString(), format: 'amount' },
        { label: 'Expiration', value: '2026-10-21 16:33:16 UTC', raw: '1792600396', format: 'datetime' },
        { label: 'Spender', value: '0x2d01…fe65', raw: '0x2d01411773c8c24805306e89a41f7855c3c4fe65', format: 'address' },
      ],
    } } as SigningRequestInfo)!
    expect(r.level).toBe('medium')
    expect(r.reasons[0].text).toContain('official Uniswap Universal Router')
    expect(r.reasons[0].text).toContain('Arbitrum USDT')
    expect(r.reasons[0].text).not.toContain('ALL of your tokens')
  })

  test('32-byte hash via personal_sign is HIGH', () => {
    const r = assessSigningRisk({ method: '/eth/sign', data: '0x' + 'ab'.repeat(32) } as SigningRequestInfo)!
    expect(r.level).toBe('high')
  })

  const reviewed = (riskLevel: string, raterPinned = false) => ({ clearSignReport: { rating: {
    riskLevel, riskReasons: ['a single key controls upgrades, deposits, minting (delay 10d)'], findings: [], raterPinned,
  } } } as unknown as Partial<SigningRequestInfo>)

  test('a verified contract rating raises the level (MDM CapitalManager.deposit: high)', () => {
    const deposit = '0x47e7ef24' + word(0n) + word(100n)
    const r = tx(deposit, { to: '0x6b6c05ee7f49d00e63e74a9426d74ef9614f6a0f', chainId: 8453, deviceClearSigns: true, ...reviewed('high') })
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toBe('An auditor rates this contract high risk: a single key controls upgrades, deposits, minting (delay 10d). The rater is not yet pinned in this Vault.')
  })

  test('a low-risk rating never lowers a critical payload', () => {
    const r = tx('0x095ea7b3' + SPENDER + word((1n << 256n) - 1n), reviewed('low', true))
    expect(r.level).toBe('critical')
  })
})

// Real Base Uniswap swap (fixtures/uniswap). The card said "Known Pattern"
// beside a red "You would be signing blind" for the same request.
describe('assessSigningRisk — reviewed Uniswap Universal Router swap', () => {
  const swap = require('./fixtures/uniswap/base-ur-usdc-to-eth-swap.json')
  const { applyEvmTxPreview } = require('../src/bun/evm-signing-preview')

  async function swapRequest(to = swap.to): Promise<SigningRequestInfo> {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const s = { id: 'u', method: '/eth/sign-transaction', appName: 't', from: swap.from, to, value: swap.value, data: swap.data, chainId: swap.chainId } as SigningRequestInfo
    try { await applyEvmTxPreview(s, to, swap.data, swap.chainId, '7.15.0') } finally { globalThis.fetch = original }
    return s
  }

  test('device verifies a signed swap description: MEDIUM, names the swap, not "blind"', async () => {
    const s = await swapRequest()
    s.calldataDecoded!.signedInsightBlob = 'AQID' // what attachCertifiedUniswapSwap sets on 7.16
    const r = assessSigningRisk(s)!
    expect(r.level).toBe('medium')
    const text = r.reasons.map((x) => x.text).join('\n')
    expect(text).toContain('Swaps 300 USDC for at least 0.108123518386717195 ETH through the Uniswap Universal Router')
    expect(text).toContain('Your KeepKey shows this swap on its screen')
    expect(text).not.toContain('blind')
  })

  test('no signed description (device blind-signs): stays HIGH, adds what this computer read', async () => {
    const r = assessSigningRisk(await swapRequest())!
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toContain('You would be signing blind')
    expect(r.reasons.map((x) => x.text).join('\n')).toContain('This computer reads it as: Swaps 300 USDC')
  })

  test('a signed blob on an unreviewed contract is not treated as a reviewed swap', async () => {
    const s = await swapRequest('0x1111111111111111111111111111111111111111')
    s.calldataDecoded!.signedInsightBlob = 'AQID'
    const r = assessSigningRisk(s)!
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toContain('You would be signing blind')
  })
})

describe('Solana plain-text rule (mirrors firmware solana_rawMessageIsPlainText)', () => {
  const { isPlainTextForSigner } = require('../src/bun/solana-message-preview')
  const SIGNER = 'Gu83nVMD8qh948D1vqe8UPoUHaFuSwcHrvNHetcM4Xux'
  const login = Buffer.from(LOGIN_MESSAGE_B64, 'base64')

  test('the real SoltoshiDICE login is plain text for its signer', () => {
    expect(isPlainTextForSigner(login, SIGNER)).toBe(true)
  })
  test('unknown signer, tab, or embedded key fails closed', () => {
    expect(isPlainTextForSigner(login, undefined)).toBe(false)
    expect(isPlainTextForSigner(Buffer.from('a\tb'), SIGNER)).toBe(false)
  })
  test('printable text containing the signer key keeps the gate', () => {
    const printableSigner = require('bs58').default.encode(Buffer.alloc(32, 'K'))
    expect(isPlainTextForSigner(Buffer.from('head ' + 'K'.repeat(32) + ' tail'), printableSigner)).toBe(false)
    expect(isPlainTextForSigner(Buffer.from('head ' + 'K'.repeat(31) + ' tail'), printableSigner)).toBe(true)
  })
})
