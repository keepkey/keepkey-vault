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
import swap from './fixtures/uniswap/base-ur-usdc-to-eth-swap.json'
import { applyEvmTxPreview, recognizedTypedDataSpender } from '../src/bun/evm-signing-preview'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { ethMessagePreview } from '../src/bun/eth-message-preview'
import { WalletConnectManager } from '../src/bun/walletconnect'

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
    // Certified, but it hands a session key power to send without the KeepKey:
    // not what a normal app does, so the three-level verdict stays red.
    expect(certified.tier).toBe('red')
    expect(opaque.tier).toBe('red')
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

  // Owner rule 2026-10-11: Danger only for what a normal dapp does not ask for.
  test('spend permission level: Danger only for an unlimited grant to an unreviewed spender', () => {
    const MAX = (1n << 256n) - 1n
    const bounded = tx('0x095ea7b3' + SPENDER + word(1_000_000_000n))
    expect(bounded.level).toBe('high')
    expect(bounded.reasons[0].text).toContain('up to 1,000 USDC')
    expect(tx('0x095ea7b3' + SPENDER + word(MAX)).level).toBe('critical')

    const reviewed = { recognizedSpender: 'Uniswap Universal Router' }
    const normal = tx('0x095ea7b3' + SPENDER + word(1_000_000_000n), reviewed)
    expect(normal.level).toBe('medium')
    expect(normal.reasons[0].text).toContain('Lets Uniswap Universal Router (0x')
    expect(normal.reasons[0].text).toContain('up to 1,000 USDC')
    expect(tx('0x095ea7b3' + SPENDER + word(MAX), reviewed).level).toBe('high')
  })

  test('"bounded" means a real bound: near-max amounts and unknown tokens are the worst case', () => {
    const level = (amount: bigint, extra: Partial<SigningRequestInfo> = {}) => tx('0x095ea7b3' + SPENDER + word(amount), extra).level
    expect(level((1n << 160n) - 2n)).toBe('critical')            // one below Permit2's max
    expect(level((1n << 96n) - 1n)).toBe('critical')             // UNI/COMP "infinite"
    expect(level(10n ** 30n)).toBe('critical')
    expect(level((1n << 96n) - 1n, { recognizedSpender: 'Uniswap Universal Router' })).toBe('high')
    // approve(to, tokenId) on an NFT has the same selector; an unknown contract is not assumed to be a token.
    expect(level(1_000_000n, { to: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' })).toBe('critical')
  })

  test('an unlimited approve to canonical Permit2 is the standard setup on any chain and token', () => {
    const permit2 = '000000000000000000000000' + '000000000022d473030f116ddee9f6b43ac78ba3'
    const r = tx('0x095ea7b3' + permit2 + word((1n << 256n) - 1n), { recognizedSpender: 'Uniswap Permit2' })
    expect(r.level).toBe('medium')
    expect(r.reasons[0].text).toBe('Standard Permit2 setup: gives canonical Permit2 persistent access to your USDC. You can revoke this allowance later.')
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

  test('three-level verdict: what the KeepKey shows is green, an unknown call is red', () => {
    const transfer = '0xa9059cbb' + word(0x1234n) + word(1_000_000n)
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    expect(tx(transfer, { to: usdc, chainId: 1, deviceClearSigns: true }).tier).toBe('green')
    expect(tx('0xdeadbeef' + word(1n), { to: '0x1111111111111111111111111111111111111111', chainId: 1 }).tier).toBe('red')
  })

  test('a low-risk rating never lowers a critical payload', () => {
    const r = tx('0x095ea7b3' + SPENDER + word((1n << 256n) - 1n), reviewed('low', true))
    expect(r.level).toBe('critical')
  })
})

// Real Base Uniswap swap (fixtures/uniswap). The card said "Known Pattern"
// beside a red "You would be signing blind" for the same request.
describe('assessSigningRisk — reviewed Uniswap Universal Router swap', () => {

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

  test('no signed description: known protocol, yellow, not shown on this firmware yet', async () => {
    const r = assessSigningRisk(await swapRequest())!
    expect(r.level).toBe('medium')
    expect(r.reasons[0].text).toContain('Swaps 300 USDC')
    expect(r.reasons[0].text).toContain('cannot show this swap on the device yet')
    expect(r.reasons.map((x) => x.text).join('\n')).not.toContain('signing blind')
    expect(r.tier).toBe('yellow')
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

describe('three-level verdict on Solana: device shows it, computer decodes it, or neither', () => {
  const SYSTEM = '11111111111111111111111111111111'
  const ix = (programId: string, status: 'known' | 'known-program-unknown-ix' | 'unknown-program', programName: string, instructionName?: string) =>
    ({ status, programId, programName, instructionName, args: [], accounts: [] })
  const sol = (...instructions: ReturnType<typeof ix>[]) => ({
    method: '/solana/sign-transaction', firmwareVersion: '7.16.0',
    solanaDecoded: { version: 'legacy', staticAccountCount: 4, instructions },
  } as unknown as SigningRequestInfo)

  test('a plain SOL transfer is green: the firmware decodes System', () => {
    const r = assessSigningRisk(sol(ix(SYSTEM, 'known', 'System Program', 'transfer')))!
    expect(r.tier).toBe('green')
  })

  test('a fully decoded app call with no certified description is yellow, never green', () => {
    // Relay depositNative on firmware without the certified schema: this
    // computer decodes it, the device shows raw data.
    const r = assessSigningRisk(sol(ix('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', 'known', 'Relay', 'depositNative')))!
    expect(r.tier).toBe('yellow')
    expect(r.reasons.map((x) => x.text).join('\n')).toContain('Your KeepKey shows it as raw data')
    expect(r.reasons.map((x) => x.text).join('\n')).not.toContain('KeepKey can read every step')
  })

  test('a program known only by name is red and says it cannot decode the action', () => {
    const r = assessSigningRisk(sol(ix('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'known-program-unknown-ix', 'Jupiter Aggregator v6')))!
    expect(r.tier).toBe('red')
    expect(r.reasons.map((x) => x.text).join('\n')).toContain('cannot decode this action')
  })

  test('a memo does not make a decoded transfer unknown', () => {
    const r = assessSigningRisk(sol(
      ix(SYSTEM, 'known', 'System Program', 'transfer'),
      ix('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'known-program-unknown-ix', 'Memo Program'),
    ))!
    expect(r.tier).toBe('yellow')
  })

  test('a certified description the device verifies is green', () => {
    const r = assessSigningRisk({ ...sol(ix('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', 'known', 'Relay', 'depositNative')), deviceClearSigns: true })!
    expect(r.tier).toBe('green')
  })
})

// EVM requests through the real REST preview (prepareEvmTxSigningInfo), offline.
describe('EVM verdict regressions', () => {
  const { utils } = require('ethers')
  const abi = utils.defaultAbiCoder
  const SIGNER = '0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e'
  const STRANGER = '0x1111111111111111111111111111111111111111'
  const BASE_UR = '0x6ff5693b99212da76ad316178a184ab56d299b43'
  const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const BASE_WETH = '0x4200000000000000000000000000000000000006'
  const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
  const RELAY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'

  async function preview(chainId: number, to: string, data: string, fw: string, value = '0x0') {
    const { prepareEvmTxSigningInfo } = await import('../src/bun/evm-presign-report')
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    try {
      const s = { id: 'v', method: '/eth/sign-transaction', appName: 'app', from: SIGNER, to, value, chainId, data, firmwareVersion: fw } as SigningRequestInfo
      await prepareEvmTxSigningInfo(s, { chainId, from: SIGNER, to, value, data }, fw)
      return s
    } finally { globalThis.fetch = original }
  }
  const texts = (s: SigningRequestInfo) => assessSigningRisk(s)!.reasons.map((x) => x.text).join('\n')

  // wiring:2
  test('a certified description Desktop attached for a call with no host decoder is green, not "signing blind"', () => {
    const contract = '0x1234567890123456789012345678901234567890'
    const data = '0xb6b55f25' + (10n ** 18n).toString(16).padStart(64, '0')
    const body = Buffer.concat([Buffer.from([0x02, 0, 0, 0, 1]), Buffer.from(contract.slice(2), 'hex'), Buffer.from('b6b55f25', 'hex'), Buffer.alloc(40, 0x33)])
    const blob = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(139, 0x11), body, Buffer.alloc(65, 0x22)]).toString('base64')
    const req = (over: Partial<SigningRequestInfo> = {}) => ({
      id: 'c', method: '/eth/sign-transaction', appName: 'app', from: SIGNER, to: contract, value: '0x0', chainId: 1, data,
      firmwareVersion: '7.16.0', deviceClearSigns: false, needsBlindSigning: false,
      calldataDecoded: { dappName: 'Unknown', contractName: contract, method: 'deposit', selector: '0xb6b55f25', fields: [], source: 'none', signedInsightBlob: blob, insightKeyId: 0x80 },
      ...over,
    } as SigningRequestInfo)
    const r = assessSigningRisk(req())!
    expect(r.tier).toBe('green')
    expect(r.reasons[0].text).toContain('from a KeepKey-certified description')
    expect(r.reasons.map((x) => x.text).join('\n')).not.toContain('signing blind')
    // The device cannot show it on older firmware, or for another contract.
    expect(assessSigningRisk(req({ firmwareVersion: '7.15.0' }))!.tier).toBe('red')
    expect(assessSigningRisk(req({ to: STRANGER }))!.tier).toBe('red')
  })

  const path = utils.solidityPack(['address', 'uint24', 'address'], [BASE_USDC, 500, BASE_WETH])
  const v3In = (recipient: string, minOut: bigint) => abi.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'], [recipient, 1000_000000n, minOut, path, true])
  const execute = (commands: string, inputs: string[]) => '0x3593564c' + abi.encode(['bytes', 'bytes[]', 'uint256'], [commands, inputs, 4102444800n]).slice(2)

  // evm-yellow:1
  test('a Universal Router swap that pays its output to someone else is red', async () => {
    for (const fw of ['7.15.0', '7.16.0']) {
      const s = await preview(8453, BASE_UR, execute('0x00', [v3In(STRANGER, 3n * 10n ** 17n)]), fw)
      expect(assessSigningRisk(s)!.tier).toBe('red')
      expect(texts(s)).toContain(`The swap output goes to ${STRANGER}, which is NOT the account signing this (${SIGNER}).`)
      // To the signer itself (MSG_SENDER) it stays a known swap.
      const own = await preview(8453, BASE_UR, execute('0x00', [v3In('0x0000000000000000000000000000000000000001', 3n * 10n ** 17n)]), fw)
      expect(assessSigningRisk(own)!.tier).toBe('yellow')
    }
  })

  // evm-yellow:2
  test('a Universal Router fee that takes 99% of the output is red; a normal fee is named, not red', async () => {
    const swap = (bips: bigint, sweepMin: bigint) => execute('0x000604', [
      v3In('0x0000000000000000000000000000000000000002', 3n * 10n ** 17n),
      abi.encode(['address', 'address', 'uint256'], [BASE_WETH, STRANGER, bips]),
      abi.encode(['address', 'address', 'uint256'], [BASE_WETH, '0x0000000000000000000000000000000000000001', sweepMin]),
    ])
    const greedy = await preview(8453, BASE_UR, swap(9900n, 3n * 10n ** 15n), '7.15.0')
    expect(assessSigningRisk(greedy)!.tier).toBe('red')
    expect(texts(greedy)).toContain(`99.00% of the swap output goes to ${STRANGER}, not to you.`)
    const normal = await preview(8453, BASE_UR, swap(25n, 299n * 10n ** 15n), '7.15.0')
    expect(assessSigningRisk(normal)!.tier).toBe('yellow')
    expect(texts(normal)).toContain(`Fee: 0.25% of the swap output goes to ${STRANGER}.`)
  })

  // evm-yellow:5
  test('a THORChain swap that pays out to another EVM address is red', async () => {
    const ROUTER = '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146'
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const deposit = (memo: string) => '0x44bc937b' + abi.encode(['address', 'address', 'uint256', 'string', 'uint256'],
      ['0x4444444444444444444444444444444444444444', ETH_USDC, 1000_000000n, memo, expiry]).slice(2)
    for (const fw of ['7.14.2', '7.16.0']) {
      const other = await preview(1, ROUTER, deposit(`=:ETH.ETH:${STRANGER}:30000000`), fw)
      expect(assessSigningRisk(other)!.tier).toBe('red')
      expect(texts(other)).toContain(`The swap pays out to ${STRANGER}, which is NOT the account signing this (${SIGNER}).`)
      expect(assessSigningRisk(await preview(1, ROUTER, deposit(`=:ETH.ETH:${SIGNER}:30000000`), fw))!.tier).toBe('green')
    }
  })

  // evm-yellow:6
  test('a token transfer straight into a contract that does not credit it is red', async () => {
    const transfer = (to: string) => '0xa9059cbb' + abi.encode(['address', 'uint256'], [to, 100_000000n]).slice(2)
    for (const [chainId, token, sink] of [[1, ETH_USDC, ETH_USDC], [1, ETH_USDC, PERMIT2], [8453, BASE_USDC, RELAY], [8453, BASE_USDC, BASE_UR]] as const) {
      const s = await preview(chainId, token, transfer(sink), '7.16.0')
      expect(assessSigningRisk(s)!.tier).toBe('red')
      expect(texts(s)).toContain(`(${sink}), which does not credit a plain transfer`)
    }
    // A transfer to a person is unchanged.
    expect(assessSigningRisk(await preview(1, ETH_USDC, transfer(STRANGER), '7.16.0'))!.tier).toBe('green')
  })

  // evm-yellow:7
  test('a bounded approve the device shows natively (mainnet DAI) to a reviewed spender is green', async () => {
    const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
    const UR = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
    const approve = (spender: string, v: bigint) => '0x095ea7b3' + abi.encode(['address', 'uint256'], [spender, v]).slice(2)
    const s = await preview(1, DAI, approve(UR, 100n * 10n ** 18n), '7.16.0')
    expect(s.deviceClearSigns).toBe(true)
    const r = assessSigningRisk(s)!
    expect(r.tier).toBe('green')
    expect(r.level).toBe('medium')
    // An unlimited grant or an unreviewed spender still is not.
    expect(assessSigningRisk(await preview(1, DAI, approve(UR, (1n << 256n) - 1n), '7.16.0'))!.tier).toBe('red')
    expect(assessSigningRisk(await preview(1, DAI, approve(STRANGER, 100n * 10n ** 18n), '7.16.0'))!.tier).toBe('red')
  })
})

// Verdicts on messages (personal_sign and EIP-712), each request built the
// way rest-api.ts and walletconnect.ts build it.
describe('message verdicts', () => {
  const USER = '0x1111111111111111111111111111111111111111'
  const EVIL = '0x9999999999999999999999999999999999999999'
  const PERMIT2_ADDR = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const hex = (s: string) => '0x' + Buffer.from(s, 'utf8').toString('hex')
  const text = (r: { reasons: { text: string }[] }) => r.reasons.map((x) => x.text).join('\n')
  const typed = (typedData: any, firmwareVersion = '7.16.0') => {
    const chainId = Number(typedData.domain?.chainId) || undefined
    const typedDataDecoded = decodeEIP712(typedData)
    return assessSigningRisk({
      id: 't', method: '/eth/sign-typed-data', appName: 'dapp', chain: 'eth', from: USER, chainId, firmwareVersion,
      typedDataDecoded, recognizedSpender: recognizedTypedDataSpender(typedDataDecoded, chainId),
    })!
  }
  const personal = (message: string) => assessSigningRisk({
    id: 't', method: '/eth/sign', appName: 'dapp', chain: 'eth', from: USER, firmwareVersion: '7.16.0',
    ethMessageDecoded: ethMessagePreview(USER, message),
  })!

  // messages:0
  test('a SafeTx carrying a call is red: the device shows the call only as hex', () => {
    const safeTx = (msg: any) => ({
      primaryType: 'SafeTx',
      domain: { chainId: 1, verifyingContract: '0x1234567890123456789012345678901234567890' },
      types: {
        EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        SafeTx: [
          { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      message: { value: '0', safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: '0x' + '0'.repeat(40), refundReceiver: '0x' + '0'.repeat(40), nonce: 3, ...msg },
    })
    const transfer = '0xa9059cbb' + EVIL.slice(2).padStart(64, '0') + (10n ** 12n).toString(16).padStart(64, '0')
    const call = typed(safeTx({ to: USDC, data: transfer, operation: 0 }))
    expect(call.tier).toBe('red')
    expect(text(call)).toContain('Your KeepKey shows that data only as raw hex')
    const delegatecall = typed(safeTx({ to: EVIL, data: '0x12345678', operation: 1 }))
    expect(delegatecall.tier).toBe('red')
    expect(text(delegatecall)).toContain('(delegatecall)')
    // A plain ETH send from the Safe carries no data: the device shows every field.
    expect(typed(safeTx({ to: EVIL, value: '1000000000000000000', data: '0x', operation: 0 })).tier).toBe('green')
  })

  // messages:1
  test('typed data that hands over signing power is red', () => {
    const DT = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
    const agent = typed({
      primaryType: 'HyperliquidTransaction:ApproveAgent',
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { EIP712Domain: DT, 'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }] },
      message: { hyperliquidChain: 'Mainnet', agentAddress: EVIL, agentName: '', nonce: 1760000000001 },
    })
    expect(agent.tier).toBe('red')
    expect(agent.level).toBe('high')
    expect(agent.reasons[0].text).toBe(`Gives ${EVIL} the power to act for your account. It can then sign without your KeepKey.`)
    const delegation = typed({
      primaryType: 'Delegation',
      domain: { name: 'DelegationManager', version: '1', chainId: 1, verifyingContract: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3' },
      types: { EIP712Domain: DT, Delegation: [
        { name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' }, { name: 'authority', type: 'bytes32' },
        { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' }], Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }] },
      message: { delegate: EVIL, delegator: USER, authority: '0x' + 'ff'.repeat(32), caveats: [], salt: '7' },
    })
    expect(delegation.tier).toBe('red')
    expect(delegation.level).toBe('critical')
    // Vote delegation (delegateBySig) names a delegatee for votes, not a signer: unchanged.
    const votes = typed({
      primaryType: 'Delegation',
      domain: { name: 'Uniswap', chainId: 1, verifyingContract: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984' },
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Delegation: [{ name: 'delegatee', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }] },
      message: { delegatee: EVIL, nonce: 0, expiry: 1792000000 },
    })
    expect(votes.tier).toBe('green')
  })

  // messages:5
  test('non-ASCII text is yellow: the device shows those bytes as codes, not letters', () => {
    for (const msg of ['请签名以登录 OpenSea 🦊', 'Sign in to OpenSea 🦊']) {
      for (const raw of [hex(msg), msg]) {
        const r = personal(raw)
        expect(r.tier).toBe('yellow')
        expect(text(r)).not.toContain('read it on your KeepKey screen')
      }
    }
    // A text-direction override is a spoof, not a localized login.
    const rlo = personal(hex(`Approve transfer to ${String.fromCharCode(0x202e)}elif.exe`))
    expect(rlo.tier).toBe('red')
    expect(text(rlo)).toContain('hidden characters')
    // Plain ASCII, newlines included, stays green.
    expect(personal(hex('Welcome to OpenSea!\n\nClick to sign in.')).tier).toBe('green')
  })

  // messages:6
  test('a WalletConnect personal_sign SIWE login gets the same green verdict as REST', async () => {
    const siwe = `app.uniswap.org wants you to sign in with your Ethereum account:\n${USER}\n\nSign in to Uniswap\n\nURI: https://app.uniswap.org\nVersion: 1\nChain ID: 1\nNonce: abcdef12345\nIssued At: 2026-10-16T00:00:00.000Z`
    let seen: SigningRequestInfo | undefined
    const wc = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: USER }),
      requestSigningApproval: async (info: SigningRequestInfo) => { seen = info; return false },
    } as any)
    await expect((wc as any).signMessage(hex(siwe), [], 'Uniswap', 1)).rejects.toThrow('User rejected signing')
    // index.ts attachSigningPolicySnapshot adds the firmware version before the overlay assesses it.
    const r = assessSigningRisk({ ...seen!, firmwareVersion: '7.16.0' })!
    expect(r.tier).toBe('green')
    expect(personal(hex(siwe)).tier).toBe('green')
  })

  // messages:7
  test('fully decoded Permit2 swaps are not forced red', () => {
    const permitSingle = {
      primaryType: 'PermitSingle',
      domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDR },
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
        PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
      },
      message: { details: { token: USDC, amount: '100000000', expiration: '1792000000', nonce: '3' }, spender: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', sigDeadline: '1792000000' },
    }
    // Case A: 7.14.2 cannot show it, but this computer decodes it and knows the router.
    const a = typed(permitSingle, '7.14.2')
    expect(a.tier).toBe('yellow')
    expect(text(a)).toContain('KeepKey firmware 7.14.2 cannot show')
    expect(typed({ ...permitSingle, message: { ...permitSingle.message, spender: EVIL } }, '7.14.2').tier).toBe('red')

    const REACTOR = '0x00000011f84b9aa48e5f8aa8b9897600006289be'
    const dutch = (recipient: string, reactor = REACTOR) => ({
      primaryType: 'PermitWitnessTransferFrom',
      domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDR },
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'V2DutchOrder' }],
        TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
        OrderInfo: [{ name: 'reactor', type: 'address' }, { name: 'swapper', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'additionalValidationContract', type: 'address' }, { name: 'additionalValidationData', type: 'bytes' }],
        V2DutchOrder: [{ name: 'info', type: 'OrderInfo' }, { name: 'cosigner', type: 'address' }, { name: 'baseInputToken', type: 'address' }, { name: 'baseInputStartAmount', type: 'uint256' }, { name: 'baseInputEndAmount', type: 'uint256' }, { name: 'baseOutputs', type: 'DutchOutput[]' }],
        DutchOutput: [{ name: 'token', type: 'address' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
      },
      message: {
        permitted: { token: USDC, amount: '100000000' }, spender: reactor, nonce: '7', deadline: '1792000000',
        witness: {
          info: { reactor, swapper: USER, nonce: '7', deadline: '1792000000', additionalValidationContract: '0x0000000000000000000000000000000000000000', additionalValidationData: '0x' },
          cosigner: '0x4449cd34d1eb1fedcf02a1be3834ffde8e6a6180', baseInputToken: USDC, baseInputStartAmount: '100000000', baseInputEndAmount: '100000000',
          baseOutputs: [{ token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', startAmount: '40000000000000000', endAmount: '39000000000000000', recipient }],
        },
      },
    })
    // Case B: a UniswapX order to the verified reactor, paying this account, on 7.16.
    const b = typed(dutch(USER))
    expect(b.tier).toBe('green')
    expect(text(b)).toContain(', once.')
    expect(text(b)).not.toContain('now and later')
    // The same order paying someone else, or to a reactor that is not the real one, stays red.
    expect(typed(dutch(EVIL)).tier).toBe('red')
    expect(typed(dutch(USER, EVIL)).tier).toBe('red')
  })
})
