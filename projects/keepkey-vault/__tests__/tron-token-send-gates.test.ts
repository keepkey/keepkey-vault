/** Regression gates for ticket_1789286420384_qwcavrm6u: a USDT send signed a
 * native TRX TransferContract because the token CAIP didn't match. Every case
 * here must either build the exact TRC-20 transfer or THROW — never go native. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import protobuf from 'protobufjs/light'
import bs58 from 'bs58'
import { assertTronPayload, buildTx, canonicalizeTronTokenCaip } from '../src/bun/txbuilder'
import { decodeTronTransfer } from '../src/bun/tron-preview'
import { CHAINS, isTokenCaip } from '../src/shared/chains'
import { fakeTronGrid } from './fixtures/fake-trongrid'

const tron = CHAINS.find(c => c.id === 'tron')!
const ethereum = CHAINS.find(c => c.id === 'ethereum')!
const from = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDC = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8' // real TRC-20, checksum-valid
const send = (extra: Record<string, unknown>) => buildTx({}, tron, { chainId: 'tron', to: from, amount: '300', fromAddress: from, ...extra } as any)
const noNetwork = (async () => { throw new Error('network must not be reached') }) as typeof fetch

let originalFetch: typeof fetch
beforeEach(() => { originalFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = originalFetch })

describe('G1 — token intent never falls through to a native transfer', () => {
  test('lowercase USDT CAIP (the ticket) signs a TRC-20 transfer, not 300 TRX', async () => {
    const grid = fakeTronGrid(); globalThis.fetch = grid.handler
    const { unsignedTx } = await send({ caip: `tron:0x2b6653dc/token:${USDT.toLowerCase()}`, tokenDecimals: 6 })
    const d = decodeTronTransfer(unsignedTx.rawTx)
    expect(d.kind).toBe('TRC-20 transfer')
    expect(d.tokenContract).toBe(USDT)
    expect(d.units).toBe(300_000_000n)
    expect(grid.requests.createtransaction).toBeUndefined()
  })

  test('erc20-namespace TRON CAIP is a token send', async () => {
    const grid = fakeTronGrid(); globalThis.fetch = grid.handler
    const { unsignedTx } = await send({ caip: `tron:27Lqcw/erc20:${USDT}` })
    expect(decodeTronTransfer(unsignedTx.rawTx).kind).toBe('TRC-20 transfer')
  })

  test('unrecognized TRON token namespace throws before any network call', async () => {
    globalThis.fetch = noNetwork
    await expect(send({ caip: `tron:27Lqcw/trc10:${USDT}` })).rejects.toThrow(/refusing to send as native TRX/)
  })

  test('unknown lowercase TRC-20 throws (no recovery, no native fallback)', async () => {
    globalThis.fetch = noNetwork
    await expect(send({ caip: `tron:27Lqcw/trc20:${USDC.toLowerCase()}` })).rejects.toThrow(/case-sensitive/)
  })

  test('missing CAIP is native intent; only slip44 CAIPs are native', () => {
    expect(isTokenCaip(undefined)).toBe(false)
    expect(isTokenCaip('tron:27Lqcw/slip44:195')).toBe(false)
    expect(isTokenCaip('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501')).toBe(false)
    expect(isTokenCaip(`tron:27Lqcw/foo:${USDT}`)).toBe(true)
  })

  test('same rule on EVM: an unparseable token CAIP throws instead of sending ETH', async () => {
    globalThis.fetch = noNetwork
    await expect(buildTx({}, ethereum, {
      chainId: 'ethereum', to: '0x' + '11'.repeat(20), amount: '1', fromAddress: '0x' + '22'.repeat(20),
      caip: 'eip155:1/token:0xdAC17F958D2ee523a2206206994597C13D831ec7',
    } as any)).rejects.toThrow(/refusing to send as native ETH/)
  })
})

describe('decimals come from the contract', () => {
  test('non-6-decimal TRC-20 encodes the amount with the contract decimals', async () => {
    const grid = fakeTronGrid({ decimals: 18 }); globalThis.fetch = grid.handler
    const { unsignedTx } = await send({ caip: `tron:27Lqcw/trc20:${USDC}`, amount: '1.5' })
    expect(decodeTronTransfer(unsignedTx.rawTx).units).toBe(1_500_000_000_000_000_000n)
  })

  test('asset-list decimals that disagree with the contract block the build', async () => {
    globalThis.fetch = fakeTronGrid({ decimals: 18 }).handler
    await expect(send({ caip: `tron:27Lqcw/trc20:${USDC}`, tokenDecimals: 6 })).rejects.toThrow(/decimals mismatch/)
  })
})

describe('G2 — decoded payload must match the reviewed send', () => {
  const tampered = (field: string, value: unknown) => fakeTronGrid({
    tamper: (req, path) => (path === 'triggersmartcontract' || path === 'createtransaction') ? { ...req, [field]: value } : req,
  }).handler

  test('TronGrid swapping the token contract is refused', async () => {
    globalThis.fetch = tampered('contract_address', USDC)
    await expect(send({ caip: `tron:27Lqcw/trc20:${USDT}` })).rejects.toThrow(/mismatch on token contract/)
  })

  test('TronGrid dropping fee_limit is refused', async () => {
    globalThis.fetch = tampered('fee_limit', undefined)
    await expect(send({ caip: `tron:27Lqcw/trc20:${USDT}` })).rejects.toThrow(/mismatch on fee_limit/)
  })

  test('TronGrid changing the native amount is refused', async () => {
    globalThis.fetch = tampered('amount', 1)
    await expect(send({})).rejects.toThrow(/mismatch on amount/)
  })

  test('a native TransferContract under token intent is refused', () => {
    const w = () => new protobuf.Writer()
    const a = (s: string) => Buffer.from(bs58.decode(s)).subarray(0, 21)
    const payload = w().uint32(10).bytes(a(from)).uint32(18).bytes(a(from)).uint32(24).uint64(300_000_000).finish()
    const any = w().uint32(10).string('type.googleapis.com/protocol.TransferContract').uint32(18).bytes(payload).finish()
    const raw = Buffer.from(w().uint32(90).bytes(w().uint32(8).uint32(1).uint32(18).bytes(any).finish()).finish()).toString('hex')
    expect(() => assertTronPayload(raw, { owner: from, to: from, units: 300_000_000n, tokenContract: USDT }))
      .toThrow(/mismatch on transfer type/)
  })
})

describe('G3/G4', () => {
  test('ingestion repairs a lowercased contract from the entry contract field, then the pinned map', () => {
    expect(canonicalizeTronTokenCaip(`tron:27Lqcw/trc20:${USDC.toLowerCase()}`, USDC)).toBe(`tron:27Lqcw/trc20:${USDC}`)
    expect(canonicalizeTronTokenCaip(`tron:27Lqcw/token:${USDT.toLowerCase()}`)).toBe(`tron:27Lqcw/token:${USDT}`)
    expect(canonicalizeTronTokenCaip(`tron:27Lqcw/trc20:${USDC}`)).toBe(`tron:27Lqcw/trc20:${USDC}`)
    expect(canonicalizeTronTokenCaip('eip155:1/erc20:0xabc')).toBe('eip155:1/erc20:0xabc')
  })

  test('neither a TRX nor a TRC-20 send reports a zero fee', async () => {
    globalThis.fetch = fakeTronGrid().handler
    expect(Number((await send({})).fee)).toBeGreaterThan(0)
    expect(Number((await send({ caip: `tron:27Lqcw/trc20:${USDT}` })).fee)).toBeGreaterThan(0)
  })
})
