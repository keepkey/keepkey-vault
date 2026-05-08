/**
 * Tests for assessAvailability — the static client-side support matrix that
 * drives the asset-picker dialog's per-row availability badge.
 *
 * The matrix is intentionally narrow: known-positive cases hardcoded,
 * everything else falls into `unknown` (try a quote) or `unsupported_chain`.
 * These tests pin both kinds of boundary so that future matrix edits can't
 * silently regress availability hints.
 *
 * Run: bun test __tests__/swap-support-matrix.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { assessAvailability } from '../src/shared/swap-support-matrix'

const BTC      = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const ETH      = 'eip155:1/slip44:60'
const AVAX     = 'eip155:43114/slip44:60'
const POLYGON  = 'eip155:137/slip44:60'
const USDT_ETH = 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'
const USDC_ETH = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_BASE = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

const PEPE_ETH = 'eip155:1/erc20:0x6982508145454ce325ddbe47a25d4ec3d2311933' // long-tail ERC-20
const COSMOS   = 'cosmos:cosmoshub-4/slip44:118'
const RUNE     = 'cosmos:thorchain-mainnet-v1/slip44:931'
const MONAD    = 'eip155:99999/slip44:60'  // truly-unknown EVM (Monad mainnet eip155:143 is now supported)
const TRON     = 'tron:27Lqcw/slip44:195'
const TON      = 'ton:-239/slip44:607'

describe('assessAvailability — natives', () => {
  test('BTC native is swappable on THORChain + Mayachain + ChainFlip', () => {
    const a = assessAvailability(BTC)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
    expect(a.providers).toContain('mayachain')
    expect(a.providers).toContain('chainflip')
  })

  test('ETH native is swappable on every provider in our matrix', () => {
    const a = assessAvailability(ETH)
    expect(a.status).toBe('swappable')
    expect(a.providers.length).toBeGreaterThanOrEqual(4)
  })

  test('AVAX native is swappable on THORChain + Relay + 0x', () => {
    const a = assessAvailability(AVAX)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
    expect(a.providers).toContain('relay')
    expect(a.providers).toContain('zeroex')
  })

  test('POLYGON native: aggregators only (no THORChain native pool)', () => {
    const a = assessAvailability(POLYGON)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('relay')
    expect(a.providers).toContain('zeroex')
    expect(a.providers).not.toContain('thorchain')
  })

  test('Cosmos hub native is swappable via THORChain', () => {
    const a = assessAvailability(COSMOS)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
  })

  test('RUNE swappable via THORChain + Mayachain', () => {
    const a = assessAvailability(RUNE)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
    expect(a.providers).toContain('mayachain')
  })

  test('Unknown EVM chain (truly unmapped chainId) → unsupported_chain', () => {
    const a = assessAvailability(MONAD)
    expect(a.status).toBe('unsupported_chain')
    expect(a.providers).toEqual([])
    expect(a.reason).toMatch(/not currently supported/i)
  })

  test('Monad mainnet (eip155:143) → swappable via Relay + ShapeShift', () => {
    // Verified live 2026-05 by probing pioneer-server's /quote endpoint.
    const a = assessAvailability('eip155:143/slip44:60')
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('relay')
    expect(a.providers).toContain('shapeshift')
  })

  test('Long-tail EVMs (Berachain, Sonic, Mode, Manta) → swappable via Relay', () => {
    for (const caip of [
      'eip155:80094/slip44:60', // Berachain
      'eip155:146/slip44:60',   // Sonic
      'eip155:34443/slip44:60', // Mode
      'eip155:169/slip44:60',   // Manta
    ]) {
      const a = assessAvailability(caip)
      expect(a.status).toBe('swappable')
      expect(a.providers).toContain('relay')
    }
  })

  test('TRON native → swappable via THORChain (verified live in pioneer-server)', () => {
    // pioneer-server's ENABLED_ASSETS_V1 lists tron:0x2b6653dc/slip44:195
    // (TRX) so TRON IS routable. Earlier matrix omitted it; regression bug.
    const a = assessAvailability(TRON)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
  })

  test('TRON native (alternate base58 encoding) → swappable', () => {
    // pioneer-discovery emits tron:27Lqcw (base58 of the genesis hash) while
    // pioneer-server uses tron:0x2b6653dc (hex). normalizeChainCaip2 maps
    // both to canonical so TRON entries don't fragment.
    const tronAlt = 'tron:27Lqcw/slip44:195'
    const a = assessAvailability(tronAlt)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
  })

  test('TON native → unsupported_chain', () => {
    const a = assessAvailability(TON)
    expect(a.status).toBe('unsupported_chain')
  })
})

describe('assessAvailability — well-known stablecoins', () => {
  test('USDT-on-Ethereum is swappable (Relay + 0x + THORChain)', () => {
    const a = assessAvailability(USDT_ETH)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('relay')
    expect(a.providers).toContain('zeroex')
    expect(a.providers).toContain('thorchain')
  })

  test('USDC-on-Ethereum is swappable', () => {
    const a = assessAvailability(USDC_ETH)
    expect(a.status).toBe('swappable')
    expect(a.providers.length).toBeGreaterThanOrEqual(2)
  })

  test('USDC-on-Base is swappable via aggregators (no THORChain pool)', () => {
    const a = assessAvailability(USDC_BASE)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('relay')
    expect(a.providers).toContain('zeroex')
    expect(a.providers).not.toContain('thorchain')
  })

  test('TRON USDT (canonical hex encoding) → swappable via THORChain', () => {
    const usdtTron = 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    const a = assessAvailability(usdtTron)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
  })

  test('TRON USDT (alternate base58 encoding) → swappable (encoding normalized)', () => {
    const usdtTronAlt = 'tron:27Lqcw/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    const a = assessAvailability(usdtTronAlt)
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
  })

  test('BSC USDT — both /erc20: and /bep20: forms resolve to swappable', () => {
    // pioneer-server's quote endpoint only routes BSC tokens under /erc20:
    // (verified live: /bep20: returns "No quotes available"). pioneer-discovery
    // emits BSC tokens as /bep20:. STABLECOIN_TOKENS is keyed on /erc20: per
    // pioneer-server convention; assessAvailability folds /bep20: into /erc20:
    // so picker rows from discovery aren't stuck in `unknown`.
    const usdtErc = 'eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955'
    const usdtBep = 'eip155:56/bep20:0x55d398326f99059ff775485246999027b3197955'
    expect(assessAvailability(usdtErc).status).toBe('swappable')
    expect(assessAvailability(usdtBep).status).toBe('swappable')
    expect(assessAvailability(usdtBep).providers).toContain('thorchain')
  })

  test('BSC USDC — /bep20: form resolves to swappable (regression)', () => {
    const usdcBep = 'eip155:56/bep20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
    expect(assessAvailability(usdcBep).status).toBe('swappable')
  })

  test('Random BSC bep20 token still falls through to unknown (try-quote)', () => {
    // Bug check: namespace fold must NOT make every BSC bep20 row swappable
    // — only the ones explicitly in the stablecoin set.
    const random = 'eip155:56/bep20:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    expect(assessAvailability(random).status).toBe('unknown')
  })
})

describe('assessAvailability — long-tail tokens', () => {
  test('Random ERC-20 on Ethereum → unknown (try a quote)', () => {
    // PEPE isn't in our hardcoded stablecoin set, but Ethereum is covered by
    // Relay/0x — most ERC-20s actually work, so we say "unknown" instead of
    // falsely flagging it as unsupported.
    const a = assessAvailability(PEPE_ETH)
    expect(a.status).toBe('unknown')
    expect(a.providers).toEqual([])
    expect(a.reason).toMatch(/try a quote/i)
  })

  test('Token on an unsupported chain → unsupported_chain', () => {
    const tokenOnMonad = 'eip155:10143/erc20:0x1234567890abcdef1234567890abcdef12345678'
    const a = assessAvailability(tokenOnMonad)
    expect(a.status).toBe('unsupported_chain')
  })
})

describe('assessAvailability — defensive', () => {
  test('empty caip → unsupported_chain (graceful)', () => {
    const a = assessAvailability('')
    expect(a.status).toBe('unsupported_chain')
    expect(a.providers).toEqual([])
  })

  test('chain-only caip (no slash) is treated as native and assessed', () => {
    // bip122:00000... without /slip44:0 — defensive: matrix lookup still
    // proceeds and either matches or falls into unsupported_chain.
    const a = assessAvailability('bip122:000000000019d6689c085ae165831e93')
    expect(a.status).toBe('swappable')
    expect(a.providers).toContain('thorchain')
  })
})
