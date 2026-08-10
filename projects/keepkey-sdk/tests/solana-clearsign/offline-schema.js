#!/usr/bin/env node
/**
 * Offline KKSOLSC1 parity/security gate — NO device, NO vault.
 *
 * A schema is signed ONCE and reused for every future transaction to a
 * program, so a mistake here is not a one-transaction mistake: it is a
 * standing, signed licence to render a wrong screen. This gate asserts the
 * serializer matches the firmware parser byte-for-byte and that every refusal
 * rule the firmware enforces also fails here, using the REAL Relay bridge
 * instructions captured from api.relay.link.
 *
 * Firmware counterparts (keep in sync):
 *   solana_parseInstrSchema()  — layout, caps, display-safe text, exact consumption
 *   solana_schemaApplies()     — program/discriminator match, structural
 *                                completeness, account bounds, ALT exclusion
 */
const assert = require('node:assert/strict')
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const {
  MAGIC,
  MAX_PAYLOAD_BYTES,
  ARG_U64,
  ARG_U8,
  ARG_OPAQUE32,
  CATALOG,
  CI_TEST_PUBKEY,
  TEST_KEY_ID,
  TEST_PRIV,
  RELAY_PROGRAM_B58,
  RELAY_NATIVE_DISC,
  RELAY_TOKEN_DISC,
  base58Decode,
  serializeSchema,
  decodeSchema,
  schemaCoverage,
  schemaApplies,
  decodeArgs,
  buildSignedSchema,
  buildRelayInstructionData,
} = require('../fixtures/solana-schema')

let checks = 0
function check(name, fn) {
  fn()
  checks++
  console.log(`  ok  ${name}`)
}

/* A Relay instruction as it actually appears on-chain. */
function relayInstruction({ disc = RELAY_NATIVE_DISC, amount = 526490980n, accountCount = 5, external = false } = {}) {
  return {
    programId: base58Decode(RELAY_PROGRAM_B58),
    data: buildRelayInstructionData(disc, amount),
    accountCount,
    external,
  }
}

console.log('\nKKSOLSC1 offline schema gate\n')

check('payload round-trips through the firmware layout', () => {
  const { payload } = buildSignedSchema(CATALOG.relayDepositNative)
  assert.ok(payload.subarray(0, 8).equals(MAGIC))
  assert.ok(payload.length <= MAX_PAYLOAD_BYTES, `payload ${payload.length}B over cap`)
  const s = decodeSchema(payload)
  assert.equal(s.programName, 'Relay Bridge')
  assert.equal(s.instructionName, 'depositNative')
  assert.deepEqual(s.args.map((a) => a.label), ['Amount', 'Order'])
  assert.deepEqual(s.accounts.map((a) => a.label), ['Vault'])
  assert.ok(s.programId.equals(base58Decode(RELAY_PROGRAM_B58)))
  assert.ok(s.discriminator.equals(RELAY_NATIVE_DISC))
})

check('signature verifies against the device-trusted slot-3 key', () => {
  const { payload, signature, schema } = buildSignedSchema(CATALOG.relayDepositNative)
  const pub = Buffer.from(secp256k1.getPublicKey(TEST_PRIV, true))
  assert.equal(pub.toString('hex'), CI_TEST_PUBKEY, 'test key must match firmware slot 3')
  assert.equal(signature.length, 64)
  assert.ok(
    secp256k1.verify(signature, sha256(payload), pub, { lowS: false }),
    'signature must verify over SHA256(payload)',
  )
  assert.equal(schema.signerKeyId, TEST_KEY_ID)
})

/* The core property: coverage must equal the instruction data length exactly. */
check('both real Relay instructions are fully covered (48 bytes)', () => {
  for (const key of ['relayDepositNative', 'relayDepositToken']) {
    const s = decodeSchema(serializeSchema(CATALOG[key]))
    assert.equal(schemaCoverage(s), 48, `${key} must account for all 48 bytes`)
  }
})

check('schema applies to the native-SOL deposit and reads the real amount', () => {
  const s = decodeSchema(serializeSchema(CATALOG.relayDepositNative))
  const ix = relayInstruction({ amount: 526490980n })
  assert.equal(schemaApplies(s, ix), null)
  const args = decodeArgs(s, ix.data)
  assert.equal(args[0].label, 'Amount')
  assert.equal(args[0].value, 526490980n, 'amount must decode from the signed bytes')
})

check('token-source deposit uses its own discriminator and 10 accounts', () => {
  const s = decodeSchema(serializeSchema(CATALOG.relayDepositToken))
  const ix = relayInstruction({ disc: RELAY_TOKEN_DISC, amount: 25000000n, accountCount: 10 })
  assert.equal(schemaApplies(s, ix), null)
  assert.equal(decodeArgs(s, ix.data)[0].value, 25000000n)
  // ...and the native schema must NOT match it.
  const native = decodeSchema(serializeSchema(CATALOG.relayDepositNative))
  assert.match(schemaApplies(native, ix), /discriminator mismatch/)
})

/* ── Refusals. Each mirrors a firmware guard. ── */

check('REFUSE incomplete coverage (unaccounted bytes could hide an effect)', () => {
  const partial = { ...CATALOG.relayDepositNative, args: [{ type: ARG_U64, label: 'Amount' }] }
  const s = decodeSchema(serializeSchema(partial))
  assert.equal(schemaCoverage(s), 16)
  assert.match(schemaApplies(s, relayInstruction()), /incomplete coverage: schema accounts for 16 of 48/)
})

check('REFUSE over-coverage (schema claims more data than exists)', () => {
  const over = {
    ...CATALOG.relayDepositNative,
    args: [
      { type: ARG_U64, label: 'Amount' },
      { type: ARG_OPAQUE32, label: 'Order' },
      { type: ARG_U8, label: 'Extra' },
    ],
  }
  const s = decodeSchema(serializeSchema(over))
  assert.match(schemaApplies(s, relayInstruction()), /incomplete coverage/)
})

check('REFUSE lookup-table instructions (accounts absent from signed message)', () => {
  const s = decodeSchema(serializeSchema(CATALOG.relayDepositNative))
  assert.match(schemaApplies(s, relayInstruction({ external: true })), /lookup-table/)
})

check('REFUSE account index beyond the instruction account list', () => {
  const bad = { ...CATALOG.relayDepositNative, accounts: [{ index: 7, label: 'Vault' }] }
  const s = decodeSchema(serializeSchema(bad))
  assert.match(schemaApplies(s, relayInstruction({ accountCount: 5 })), /out of range/)
})

check('REFUSE a schema for a different program', () => {
  const other = { ...CATALOG.relayDepositNative, programId: Buffer.alloc(32, 0x42) }
  const s = decodeSchema(serializeSchema(other))
  assert.match(schemaApplies(s, relayInstruction()), /program mismatch/)
})

check('REFUSE trailing bytes in the payload', () => {
  const payload = serializeSchema(CATALOG.relayDepositNative)
  assert.throws(() => decodeSchema(Buffer.concat([payload, Buffer.from([0])])), /trailing bytes/)
})

check('REFUSE display text a device cannot render safely', () => {
  assert.throws(
    () => serializeSchema({ ...CATALOG.relayDepositNative, programName: 'Relay %s' }),
    /will not display/,
    'a % could smuggle a format specifier into a screen',
  )
  assert.throws(
    () => serializeSchema({ ...CATALOG.relayDepositNative, instructionName: 'dép' }),
    /will not display/,
  )
})

check('REFUSE oversize names, labels, and arg/account counts', () => {
  const c = CATALOG.relayDepositNative
  assert.throws(() => serializeSchema({ ...c, programName: 'x'.repeat(21) }), /exceeds 20/)
  assert.throws(
    () => serializeSchema({ ...c, args: [{ type: ARG_U64, label: 'y'.repeat(17) }] }),
    /exceeds 16/,
  )
  assert.throws(
    () => serializeSchema({ ...c, args: Array(5).fill({ type: ARG_U8, label: 'a' }) }),
    /at most 4 args/,
  )
  assert.throws(
    () => serializeSchema({ ...c, accounts: Array(5).fill({ index: 0, label: 'a' }) }),
    /at most 4/,
  )
})

check('REFUSE an unknown arg type (width would be unknowable)', () => {
  assert.throws(
    () => serializeSchema({ ...CATALOG.relayDepositNative, args: [{ type: 99, label: 'Nope' }] }),
    /unknown arg type/,
  )
})

console.log(`\n  ${checks} checks passed\n`)
