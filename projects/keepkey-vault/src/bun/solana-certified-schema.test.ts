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
  ROLE_SPEND_MAX,
  ROLE_SPEND_EXACT,
  ROLE_CAP,
  type SolanaSchemaSpec,
} from './solana-certified-schema'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'
import ceeloFixture from '../../__tests__/fixtures/solana/soltoshidice-ceelo-bet.json'
import pokerRegistrationFixture from '../../__tests__/fixtures/solana/soltoshidice-register-poker-tournament.json'
import livePokerFixture from '../../__tests__/fixtures/solana/soltoshidice-live-poker-session.json'

// Real Solana scope-501 certificate issued 2026-08-24 by the master root
// signer (docs/certs/solana-scope-501-certificate.json). Public data only.
const SOLANA_CERT_HEX = '0101000001f56c68c8804b6565704b6579205661756c74000000000000000000000000000000000000000342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cfa2753fac6068a45747a32a4a39f249af72b55370f3491913b7fb9a80207d619b3b4fca6750fc1fdc790da5562b42a351e12cde3c0f084056a24ca8d1bf2c36b5'

describe('serializeSolanaSchema', () => {
  test('coverage exactly matches the real 48-byte Relay instruction data', () => {
    expect(solanaSchemaCoverage(CERTIFIED_SOLANA_CATALOG.relayDepositNative)).toBe(48)
    expect(CERTIFIED_SOLANA_CATALOG.relayDepositNative.args?.[0].type).toBe(ARG_LAMPORTS)
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
// invalidate it, so v1 output must never change. The relayDeposit* entries
// are exactly what keepkey-sdk tests/fixtures/solana-schema.js serializeSchema
// emits, so they also pin this serializer to the SDK offline fixture without
// loading it (its @noble deps are not installed in Vault CI).
const V1_CATALOG_BYTES: Record<string, string> = {
  relayDepositToken: '4b4b534f4c53433101792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf080b9c60da27a3b4130c52656c6179204272696467650c6465706f736974546f6b656e020106416d6f756e7404054f726465720103055661756c74',
}

// v3 (SRS-7.16 §3.7) payloads, pinned on purpose: roles and the intent are
// signed with the schema, so any drift changes what the device shows.
const V3_CATALOG_BYTES: Record<string, string> = {
  pumpAmmBuy: '4b4b534f4c534331030c14defc825ec67694250818bb654065f4298d3156d571b4d4f8090c18e9a8630866063d1201daebea0850756d702e66756e0a42757920746f6b656e73030607596f75206765740304060b506179206174206d6f73740401020c547261636b20766f6c756d65000017427579207b307d20666f72206174206d6f7374207b317d',
  pumpAmmSell: '4b4b534f4c534331030c14defc825ec67694250818bb654065f4298d3156d571b4d4f8090c18e9a8630833e685a4017f83ad0850756d702e66756e0b53656c6c20746f6b656e73020608596f752073656c6c0303061052656365697665206174206c656173740402001953656c6c207b307d20666f72206174206c65617374207b317d',
  relayDepositNative: '4b4b534f4c53433103792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf080d9e0ddf5fd51c060552656c61790e427269646765206465706f736974020506416d6f756e740304054f72646572000103055661756c74414465706f736974207b307d20696e746f2052656c6179207661756c74207b61307d20746f206272696467653b2064656c69766572792069732062792052656c6179',
  soltoshidiceCeeloBet: '4b4b534f4c53433103b0e08af4a4fcfad13ef8fcfd9dc70975eb6fc2e04a7c76611540a51cd5db9ed001360c536f6c746f73686944494345104365652d6c6f20706c61636520626574040105526f756e6400060557616765720503020850726f746f636f6c00050b534f4c206465706f73697403003a426574207b317d206f6e204365652d6c6f20726f756e64207b307d2c20706c7573206120726566756e6461626c65207b337d206465706f736974',
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

  test('v3 catalog entries serialize to their pinned bytes', () => {
    for (const [key, hex] of Object.entries(V3_CATALOG_BYTES)) {
      const payload = serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG[key])
      expect(payload.toString('hex')).toBe(hex)
      expect(payload[8]).toBe(3)
    }
  })

  test('a v3 schema matches a hand-assembled byte vector', () => {
    const spec: SolanaSchemaSpec = {
      programId: PROGRAM,
      discriminator: Buffer.from([0x51]),
      programName: 'P',
      instructionName: 'I',
      args: [
        { type: ARG_TOKEN_AMOUNT, label: 'Amt', mintAccount: 7, role: ROLE_SPEND_MAX },
        { type: ARG_U8, label: 'Seat' },
      ],
      accounts: [{ index: 2, label: 'Pool' }],
      intent: 'Pay {0} at {1} in {a0}',
    }
    const want = '4b4b534f4c534331' + '03' + Buffer.from(bs58.decode(PROGRAM)).toString('hex')
      + '0151' + text('P') + text('I') + '02'
      + byte(ARG_TOKEN_AMOUNT) + text('Amt') + '07' + byte(ROLE_SPEND_MAX)
      + byte(ARG_U8) + text('Seat') + '00'
      + '01' + '02' + text('Pool') + text('Pay {0} at {1} in {a0}')
    expect(serializeSolanaSchema(spec).toString('hex')).toBe(want)
  })

  test('v3 refuses what the firmware refuses', () => {
    const base: SolanaSchemaSpec = { programId: PROGRAM, discriminator: Buffer.from([1]), programName: 'P', instructionName: 'I',
      args: [{ type: ARG_LAMPORTS, label: 'Amt', role: ROLE_SPEND_EXACT }, { type: ARG_U8, label: 'n' }] }
    expect(() => serializeSolanaSchema({ ...base, intent: 'Pay {0}' })).not.toThrow()
    expect(() => serializeSolanaSchema({ ...base, intent: 'Pay' })).toThrow(/omits amount/)
    expect(() => serializeSolanaSchema({ ...base, intent: 'Pay {0}, about 100 SOL' })).toThrow(/number of its own/)
    expect(() => serializeSolanaSchema({ ...base, intent: '{0}'.repeat(9) })).toThrow(/firmware limit/)
    expect(() => serializeSolanaSchema({ ...base, intent: 'Pay {0} {2}' })).toThrow(/out of range/)
    expect(() => serializeSolanaSchema({ ...base, intent: 'Pay {0} }' })).toThrow(/stray brace/)
    expect(() => serializeSolanaSchema({ ...base, intent: 'Pay {0} {a0}' })).toThrow(/out of range/)
    expect(() => serializeSolanaSchema({ ...base, args: [{ type: ARG_LAMPORTS, label: 'Amt' }], intent: 'Pay {0}' })).toThrow(/needs a role/)
    expect(() => serializeSolanaSchema({ ...base, args: [{ type: ARG_U8, label: 'n', role: ROLE_CAP }], intent: 'n {0}' })).toThrow(/only amounts/)
    expect(() => serializeSolanaSchema({ ...base, intent: '{0}' + 'x'.repeat(94) })).toThrow(/exceeds 96/)
    expect(() => serializeSolanaSchema({ programId: PROGRAM, discriminator: Buffer.from([1]), programName: 'P', instructionName: 'I',
      args: [{ type: ARG_LAMPORTS, label: 'Amt', role: ROLE_SPEND_EXACT }] })).toThrow(/roles require an intent/)
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

  test('is a v3 payload within the 256-byte proto cap', () => {
    const payload = serializeSolanaSchema(spec)
    expect(payload[8]).toBe(3)
    expect(payload.length).toBe(240)
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

describe('SoltoshiDICE poker tournament registration catalog entry', () => {
  const spec = CERTIFIED_SOLANA_CATALOG.soltoshidiceRegisterPokerTournament
  const fullTx = Uint8Array.from(Buffer.from(pokerRegistrationFixture.rawTxBase64, 'base64'))
  const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
  const registration = message.instructions[pokerRegistrationFixture.expected.instructionIndex]

  test('covers the captured instruction exactly', () => {
    expect(solanaSchemaCoverage(spec)).toBe(8)
    expect(registration.data.length).toBe(8)
    expect(bs58.encode(message.staticAccounts[registration.programIdIndex]))
      .toBe(pokerRegistrationFixture.expected.program)
    expect(Buffer.from(registration.data).toString('hex'))
      .toBe(pokerRegistrationFixture.expected.discriminatorHex)
  })

  test('labels every instruction account in first-party IDL order', () => {
    expect(spec.accounts?.map((account) => account.label))
      .toEqual(['Player', 'Arena', 'Tournament'])
    expect(registration.accountIndices.map((index) => bs58.encode(message.staticAccounts[index])))
      .toEqual(pokerRegistrationFixture.expected.accounts)
  })

  test('serializes as a v3 schema within the firmware payload cap', () => {
    const payload = serializeSolanaSchema(spec)
    expect(payload[8]).toBe(3)
    expect(payload.length).toBeLessThanOrEqual(256)
  })
})

describe('SoltoshiDICE live poker session catalog entries', () => {
  for (const [name, fixture] of Object.entries(livePokerFixture)) {
    test(`${name} covers every captured instruction byte`, () => {
      const spec = CERTIFIED_SOLANA_CATALOG[fixture.catalogKey]
      const fullTx = Uint8Array.from(Buffer.from(fixture.rawTxBase64, 'base64'))
      const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
      const instruction = message.instructions[fixture.instructionIndex]
      expect(spec).toBeDefined()
      expect(Buffer.from(instruction.data).toString('hex')).toBe(fixture.dataHex)
      expect(solanaSchemaCoverage(spec)).toBe(instruction.data.length)
      expect(serializeSolanaSchema(spec).length).toBeLessThanOrEqual(256)
    })
  }

  test('session authorization shows the complete key and absolute expiry', () => {
    const fixture = livePokerFixture.authorizeSession
    const fullTx = Uint8Array.from(Buffer.from(fixture.rawTxBase64, 'base64'))
    const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
    const data = Buffer.from(message.instructions[fixture.instructionIndex].data)
    expect(bs58.encode(data.subarray(8, 40))).toBe(fixture.sessionKey)
    expect(data.readBigUInt64LE(40).toString()).toBe(fixture.expiryUnix)
    expect(CERTIFIED_SOLANA_CATALOG[fixture.catalogKey].args?.map((arg) => arg.label))
      .toEqual(['Session key', 'Expires Unix'])
  })
})

describe('SoltoshiDICE Cee-lo bet catalog entry', () => {
  const spec = CERTIFIED_SOLANA_CATALOG.soltoshidiceCeeloBet
  const fullTx = Uint8Array.from(Buffer.from(ceeloFixture.rawTxBase64, 'base64'))
  const message = parseSolanaMessage(solanaMessageSlice(fullTx, parseSolanaTx(fullTx)))
  // The single non-ComputeBudget instruction of the captured bet.
  const bet = message.instructions[1]

  test('is a v3 payload within the 256-byte proto cap', () => {
    const payload = serializeSolanaSchema(spec)
    expect(payload[8]).toBe(3)
    expect(payload.length).toBe(176)
    expect(payload.length).toBeLessThanOrEqual(256)
  })

  test('covers the real 26-byte instruction exactly, leaving no unshown byte', () => {
    expect(solanaSchemaCoverage(spec)).toBe(26)
    expect(bet.data.length).toBe(26)
    expect(bs58.encode(message.staticAccounts[bet.programIdIndex])).toBe(ceeloFixture.program)
    expect(Buffer.from(bet.data).toString('hex', 0, spec.discriminator.length)).toBe('36')
  })

  test('the Wager TOKEN_AMOUNT names the SDICE mint account of the real bet', () => {
    const tokenArgs = (spec.args || []).filter((arg) => arg.type === ARG_TOKEN_AMOUNT)
    expect(tokenArgs.map((arg) => arg.label)).toEqual(['Wager'])
    expect(tokenArgs[0].mintAccount!).toBeLessThan(bet.accountIndices.length)
    expect(bs58.encode(message.staticAccounts[bet.accountIndices[tokenArgs[0].mintAccount!]]))
      .toBe(spec.token!.mint)
  })

  test('decodes the real values in schema order', () => {
    const data = Buffer.from(bet.data)
    let offset = spec.discriminator.length
    const values: Record<string, string | number> = {}
    for (const arg of spec.args || []) {
      if (arg.type === ARG_U8) values[arg.label] = data[offset++]
      else { values[arg.label] = data.readBigUInt64LE(offset).toString(); offset += 8 }
    }
    expect(offset).toBe(26)
    // Independently established: round 1564 is the shared-round PDA seed of
    // this message, the wager matches the signer's SDICE debit to the unit
    // across on-chain bets 1558-1564, and the SOL leg is the encoder's
    // SOL_DEPOSIT_LAMPORTS constant. The offset-17 byte is the literal 4 the
    // encoder writes, labelled with the dapp's own word for it (`protocol`).
    expect(values).toEqual({
      Round: '1564',
      Wager: '1000000000', // 1,000 SDICE at 6 decimals
      Protocol: 4,
      'SOL deposit': '10000000', // 0.01 SOL, the refundable deposit only
    })
  })
})
