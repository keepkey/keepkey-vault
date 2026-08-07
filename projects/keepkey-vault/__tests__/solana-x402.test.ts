import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import { signSolanaWireTransaction } from '../src/bun/solana-signing'
import {
  deriveAssociatedTokenAddress,
  prepareSolanaX402DeviceMetadata,
  SOLANA_MAINNET_CAIP2,
} from '../src/bun/solana-x402'
import { parseSolanaMessage } from '../src/bun/solana-tx'
import { SolanaSignRequest } from '../src/bun/schemas'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { requiresSolanaBlindSigningConsent } from '../src/bun/solana-consent'

const PATH = [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]
const SPONSOR = Buffer.alloc(32, 0x10)
const SIGNER = Buffer.alloc(32, 0x20)
const SOURCE = Buffer.alloc(32, 0x30)
const PAY_TO = Buffer.from([
  0xea, 0x4a, 0x6c, 0x63, 0xe2, 0x9c, 0x52, 0x0a,
  0xbe, 0xf5, 0x50, 0x7b, 0x13, 0x2e, 0xc5, 0xf9,
  0x95, 0x47, 0x76, 0xae, 0xbe, 0xbe, 0x7b, 0x92,
  0x42, 0x1e, 0xea, 0x69, 0x14, 0x46, 0xd2, 0x2c,
])
const USDC_MINT = bs58.decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const TOKEN_PROGRAM = bs58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const COMPUTE_PROGRAM = bs58.decode('ComputeBudget111111111111111111111111111111')
const MEMO_PROGRAM = bs58.decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const DESTINATION_ATA = Buffer.from([
  0x67, 0x30, 0x2e, 0x49, 0x18, 0x94, 0xd7, 0x49,
  0x2e, 0xa6, 0xbe, 0x4f, 0x91, 0x4e, 0xa4, 0xf4,
  0x5f, 0xa1, 0x42, 0xe6, 0x45, 0x86, 0x7c, 0x91,
  0x64, 0xa2, 0x76, 0xd5, 0xdd, 0x76, 0xf0, 0x76,
])

const RANDOM_MEMO = '00112233445566778899aabbccddeeff'

function x402Message(decimals = 6, lookupCount = 0, memo = RANDOM_MEMO): Buffer {
  const memoBytes = Buffer.from(memo, 'utf8')
  return Buffer.concat([
    Buffer.from([0x80, 2, 0, 3, 8]),
    SPONSOR,
    SIGNER,
    SOURCE,
    DESTINATION_ATA,
    USDC_MINT,
    COMPUTE_PROGRAM,
    TOKEN_PROGRAM,
    MEMO_PROGRAM,
    Buffer.alloc(32, 0xbb),
    Buffer.from([
      4,
      // setComputeUnitLimit(120000)
      5, 0, 5, 2, 0xc0, 0xd4, 0x01, 0,
      // setComputeUnitPrice(1000 micro-lamports)
      5, 0, 9, 3, 0xe8, 0x03, 0, 0, 0, 0, 0, 0,
      // TransferChecked(source, mint, destination ATA, signer), 2000 @ decimals
      6, 4, 2, 4, 3, 1, 10, 12, 0xd0, 0x07, 0, 0, 0, 0, 0, 0, decimals,
      // Memo instruction header, signed by the token authority
      7, 1, 1, memoBytes.length,
    ]),
    memoBytes,
    Buffer.from([lookupCount]),
  ])
}

function requirements(amount = '2000') {
  return {
    scheme: 'exact' as const,
    network: SOLANA_MAINNET_CAIP2,
    asset: bs58.encode(USDC_MINT),
    amount,
    payTo: bs58.encode(PAY_TO),
    maxTimeoutSeconds: 60,
    extra: { feePayer: bs58.encode(SPONSOR) },
  }
}

describe('x402 Solana hardware-verification boundary', () => {
  test('REST schema accepts an official exact PaymentRequirements object', () => {
    const parsed = SolanaSignRequest.parse({
      raw_tx: 'AA==',
      x402: requirements(),
    })
    expect(parsed.x402).toEqual(requirements())
  })

  test('ATA implementation matches the independent Solana vector', () => {
    expect(Buffer.from(deriveAssociatedTokenAddress(PAY_TO, USDC_MINT))).toEqual(DESTINATION_ATA)
  })

  test('validates the signed v0 transfer and produces device metadata', () => {
    const metadata = prepareSolanaX402DeviceMetadata(
      parseSolanaMessage(x402Message()),
      requirements(),
      SIGNER,
    )
    expect(metadata.tokenInfo).toEqual([{
      mint: USDC_MINT,
      symbol: 'USDC',
      decimals: 6,
    }])
    expect(Buffer.from(metadata.tokenRecipientOwners[0])).toEqual(PAY_TO)
  })

  test('official zero-LUT x402 shape is clear-signable in the Vault policy', async () => {
    const wire = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), x402Message()])
    const decoded = await buildSolanaDecodedInfo(
      wire.toString('base64'),
      async (pubkeys) => pubkeys.map(() => null),
    )
    expect(decoded.version).toBe('v0')
    expect(decoded.instructions).toHaveLength(4)
    expect(requiresSolanaBlindSigningConsent(decoded, false)).toBe(false)
  })

  test('rejects underpayment and the USDC decimal-confusion attack', () => {
    expect(() => prepareSolanaX402DeviceMetadata(
      parseSolanaMessage(x402Message()),
      requirements('2001'),
      SIGNER,
    )).toThrow('below required')
    expect(() => prepareSolanaX402DeviceMetadata(
      parseSolanaMessage(x402Message(2)),
      requirements(),
      SIGNER,
    )).toThrow('USDC decimals mismatch')
  })

  test('binds a seller-provided memo and rejects a mismatched quote', () => {
    const quoted = {
      ...requirements(),
      extra: { ...requirements().extra, memo: 'invoice-402' },
    }
    expect(() => prepareSolanaX402DeviceMetadata(
      parseSolanaMessage(x402Message(6, 0, 'invoice-402')),
      quoted,
      SIGNER,
    )).not.toThrow()
    expect(() => prepareSolanaX402DeviceMetadata(
      parseSolanaMessage(x402Message(6, 0, 'different-invoice')),
      quoted,
      SIGNER,
    )).toThrow('memo does not match')
  })

  test('routes verified x402 metadata through SolanaSignTx and signs the user slot', async () => {
    const message = x402Message()
    const wire = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), message])
    let deviceRequest: any
    const result = await signSolanaWireTransaction({
      addressNList: PATH,
      rawTx: wire.toString('base64'),
      x402: requirements(),
    }, async (request) => {
      deviceRequest = request
      return { signature: Buffer.alloc(64, 0x5a) }
    }, async () => bs58.encode(SIGNER))

    expect(deviceRequest.tokenInfo[0].symbol).toBe('USDC')
    expect(Buffer.from(deviceRequest.tokenRecipientOwners[0])).toEqual(PAY_TO)
    const signed = Buffer.from(result.serializedTx, 'base64')
    expect(signed.subarray(1, 65)).toEqual(Buffer.alloc(64))
    expect(signed.subarray(65, 129)).toEqual(Buffer.alloc(64, 0x5a))
  })
})
