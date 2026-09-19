import { describe, test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'
import bs58 from 'bs58'

import {
  serializeSolanaSchema,
  solanaSchemaCoverage,
  signCertifiedSolanaSchema,
  CERTIFIED_SOLANA_CATALOG,
  ARG_LAMPORTS,
  ARG_U64,
  ARG_U8,
  ARG_PUBKEY,
  ARG_TOKEN_AMOUNT,
  ARG_DURATION,
  type SolanaSchemaSpec,
} from './solana-certified-schema'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdkFixture = require('../../../keepkey-sdk/tests/fixtures/solana-schema')

// Real Solana scope-501 certificate issued 2026-08-24 by the master root
// signer (docs/certs/solana-scope-501-certificate.json). Public data only.
const SOLANA_CERT_HEX = '0101000001f56c68c8804b6565704b6579205661756c74000000000000000000000000000000000000000342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cfa2753fac6068a45747a32a4a39f249af72b55370f3491913b7fb9a80207d619b3b4fca6750fc1fdc790da5562b42a351e12cde3c0f084056a24ca8d1bf2c36b5'

describe('serializeSolanaSchema', () => {
  test('is byte-for-byte identical to the SDK offline fixture (drift gate)', () => {
    const oursNative = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative)
    const theirsNative = sdkFixture.serializeSchema(sdkFixture.CATALOG.relayDepositNative)
    expect(Buffer.from(oursNative)).toEqual(Buffer.from(theirsNative))

    const oursToken = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositToken)
    const theirsToken = sdkFixture.serializeSchema(sdkFixture.CATALOG.relayDepositToken)
    expect(Buffer.from(oursToken)).toEqual(Buffer.from(theirsToken))
  })

  test('coverage exactly matches the real 48-byte Relay instruction data', () => {
    expect(solanaSchemaCoverage(CERTIFIED_SOLANA_CATALOG.relayDepositNative)).toBe(48)
    expect(CERTIFIED_SOLANA_CATALOG.relayDepositNative.args?.[0].type).toBe(ARG_LAMPORTS)
  })

  test('the SDK fixture round-trip-decodes what we serialize', () => {
    const payload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG.relayDepositNative)
    const decoded = sdkFixture.decodeSchema(payload)
    expect(decoded.instructionName).toBe('depositNative')
    expect(decoded.args.length).toBe(2)
  })
})

describe('signCertifiedSolanaSchema', () => {
  test('accepts the real Solana-scoped certificate but rejects a mismatched private key', () => {
    const wrongKey = randomBytes(32).toString('hex')
    expect(() => signCertifiedSolanaSchema(SOLANA_CERT_HEX, wrongKey, CERTIFIED_SOLANA_CATALOG.relayDepositNative))
      .toThrow(/does not match reviewed signer/)
  })
})

// Bytes each v1 catalog entry serialized to BEFORE schema v2 existed. A
// signature over these payloads is already in use; any drift would silently
// invalidate it, so v1 output must never change.
const V1_CATALOG_BYTES: Record<string, string> = {
  pumpAmmBuy: '4b4b534f4c534331010c14defc825ec67694250818bb654065f4298d3156d571b4d4f8090c18e9a8630866063d1201daebea0850756d7020414d4d0342757903010e4261736520756e697473206f7574010f4d61782071756f746520756e697473020c547261636b20766f6c756d6504030e42757920746f6b656e206d696e74040e50617920746f6b656e206d696e74050f52656365697665206163636f756e74060b506179206163636f756e74',
  relayDepositNative: '4b4b534f4c53433101792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf080d9e0ddf5fd51c060c52656c6179204272696467650d6465706f7369744e6174697665020506416d6f756e7404054f726465720103055661756c74',
  relayDepositToken: '4b4b534f4c53433101792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf080b9c60da27a3b4130c52656c6179204272696467650c6465706f736974546f6b656e020106416d6f756e7404054f726465720103055661756c74',
}

const byte = (value: number) => value.toString(16).padStart(2, '0')
const text = (value: string) => byte(value.length) + Buffer.from(value, 'ascii').toString('hex')
const PROGRAM = 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR'

describe('KKSOLSC schema version selection', () => {
  test('existing v1 catalog entries serialize byte-for-byte as before v2', () => {
    for (const [key, hex] of Object.entries(V1_CATALOG_BYTES)) {
      const payload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG[key])
      expect(payload.toString('hex')).toBe(hex)
      expect(payload[8]).toBe(1)
    }
  })

  test('a v2 schema matches a hand-assembled byte vector', () => {
    const spec: SolanaSchemaSpec = {
      programId: PROGRAM,
      discriminator: Buffer.from([0x51]),
      programName: 'P',
      instructionName: 'I',
      args: [
        { type: ARG_TOKEN_AMOUNT, label: 'Amt', mintAccount: 7 },
        { type: ARG_DURATION, label: 'Dur' },
      ],
      accounts: [{ index: 2, label: 'Acct' }],
    }
    // Assembled from the shared wire spec, not from the serializer: a
    // TOKEN_AMOUNT entry is type, label, then the mint account byte.
    const expected = Buffer.from('KKSOLSC1', 'ascii').toString('hex') + byte(2)
      + Buffer.from(bs58.decode(PROGRAM)).toString('hex')
      + byte(1) + byte(0x51) + text('P') + text('I')
      + byte(2)
      + byte(6) + text('Amt') + byte(7)
      + byte(7) + text('Dur')
      + byte(1) + byte(2) + text('Acct')
    expect(serializeSolanaSchema(spec).toString('hex')).toBe(expected)
    expect(solanaSchemaCoverage(spec)).toBe(1 + 8 + 8)
  })

  test('only a schema that needs v2 gets version 2', () => {
    const base = { programId: PROGRAM, discriminator: Buffer.from([1]), programName: 'P', instructionName: 'I' }
    const four = Array.from({ length: 4 }, (_, i) => ({ type: ARG_U8, label: `a${i}` }))
    const five = Array.from({ length: 5 }, (_, i) => ({ type: ARG_U8, label: `a${i}` }))
    const eight = Array.from({ length: 8 }, (_, i) => ({ type: ARG_U8, label: `a${i}` }))
    expect(serializeSolanaSchema({ ...base, args: four })[8]).toBe(1)
    expect(serializeSolanaSchema({ ...base, args: five })[8]).toBe(2)
    expect(serializeSolanaSchema({ ...base, args: eight })[8]).toBe(2)
    expect(serializeSolanaSchema({ ...base, args: [{ type: ARG_DURATION, label: 'd' }] })[8]).toBe(2)
    // v2 layout for plain args is identical to v1 apart from the version byte.
    const v1 = serializeSolanaSchema({ ...base, args: four })
    const v2 = serializeSolanaSchema({ ...base, args: five })
    expect(v2.toString('hex', 9, 9 + 32 + 2 + 2 + 2)).toBe(v1.toString('hex', 9, 9 + 32 + 2 + 2 + 2))
  })

  test('rejects schemas the firmware parser would refuse', () => {
    const base = { programId: PROGRAM, discriminator: Buffer.from([1]), programName: 'P', instructionName: 'I' }
    const nine = Array.from({ length: 9 }, (_, i) => ({ type: ARG_U8, label: `a${i}` }))
    expect(() => serializeSolanaSchema({ ...base, args: nine })).toThrow(/at most 8 args/)
    expect(() => serializeSolanaSchema({ ...base, args: [{ type: 8, label: 'x' }] })).toThrow(/unknown arg type/)
    expect(() => serializeSolanaSchema({ ...base, args: [{ type: ARG_TOKEN_AMOUNT, label: 'x' }] }))
      .toThrow(/mintAccount must be a byte/)
    expect(() => serializeSolanaSchema({ ...base, args: [{ type: ARG_TOKEN_AMOUNT, label: 'x', mintAccount: 256 }] }))
      .toThrow(/mintAccount must be a byte/)
    expect(() => serializeSolanaSchema({ ...base, args: [{ type: ARG_U64, label: 'x', mintAccount: 1 }] }))
      .toThrow(/only to TOKEN_AMOUNT/)
  })
})

describe('SoltoshiDICE Blackjack join catalog entry', () => {
  const spec = CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin
  const fullTx = Uint8Array.from(Buffer.from(joinFixture.rawTxBase64, 'base64'))
  const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
  const join = message.instructions[joinFixture.expected.instructionIndex]

  test('is a v2 payload within the 256-byte proto cap', () => {
    const payload = serializeSolanaSchema(spec)
    expect(payload[8]).toBe(2)
    expect(payload.length).toBe(154)
    expect(payload.length).toBeLessThanOrEqual(256)
  })

  test('covers the real 82-byte instruction exactly', () => {
    expect(solanaSchemaCoverage(spec)).toBe(82)
    expect(join.data.length).toBe(82)
    expect(bs58.encode(message.staticAccounts[join.programIdIndex])).toBe(spec.programId)
    expect(Buffer.from(join.data).toString('hex', 0, spec.discriminator.length)).toBe(spec.discriminator.toString('hex'))
  })

  test('every TOKEN_AMOUNT names the SDICE mint account of the real join', () => {
    const tokenArgs = (spec.args || []).filter((arg) => arg.type === ARG_TOKEN_AMOUNT)
    expect(tokenArgs.map((arg) => arg.label)).toEqual(['Buy-in', 'Allowance', 'Max wager'])
    for (const arg of tokenArgs) {
      expect(arg.mintAccount!).toBeLessThan(join.accountIndices.length)
      expect(bs58.encode(message.staticAccounts[join.accountIndices[arg.mintAccount!]])).toBe(joinFixture.expected.mint)
    }
  })

  test('decodes the real values in schema order', () => {
    const data = Buffer.from(join.data)
    let offset = spec.discriminator.length
    const values: Record<string, string | number> = {}
    for (const arg of spec.args || []) {
      if (arg.type === ARG_U8) values[arg.label] = data[offset++]
      else if (arg.type === ARG_PUBKEY) { values[arg.label] = bs58.encode(join.data.subarray(offset, offset + 32)); offset += 32 }
      else { values[arg.label] = data.readBigUInt64LE(offset).toString(); offset += 8 }
    }
    const v = joinFixture.expected.values
    expect(values).toEqual({
      Round: v.round, Revision: v.revision, Seat: v.seat, 'Buy-in': v.buyIn,
      'Session key': v.sessionKey, 'Expires in': v.seconds, Allowance: v.allowance, 'Max wager': v.maxWager,
    })
  })
})
