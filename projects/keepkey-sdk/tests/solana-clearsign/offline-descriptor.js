#!/usr/bin/env node
/**
 * Offline KKSOLSW1 parity/security gate — NO device, NO vault.
 *
 * Covers the canonical descriptor layout, deterministic CI-key signature,
 * exact Solana-message binding, protocol instruction binding, and strict
 * rejection of unsafe/trailing display data.
 */
const nodeAssert = require('node:assert/strict')
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const {
  MAGIC,
  PROGRAM_ID,
  DISCRIMINATOR,
  MAX_PAYLOAD_BYTES,
  CI_TEST_PUBKEY,
  TEST_PRIV,
  buildSolanaSwapFixture,
  decodeSolanaSwapMetadata,
  decodeSolanaAddress,
  serializeSolanaSwapMetadata,
} = require('../fixtures/solana-clearsign')

function main() {
  const fixture = buildSolanaSwapFixture()
  const decoded = decodeSolanaSwapMetadata(fixture.payload)

  nodeAssert.equal(fixture.payload.subarray(0, 8).toString('ascii'), MAGIC.toString('ascii'))
  nodeAssert.ok(fixture.payload.length <= MAX_PAYLOAD_BYTES)
  nodeAssert.equal(fixture.signature.length, 64)
  nodeAssert.equal(fixture.wireTransaction[0], 1)
  nodeAssert.deepEqual(fixture.wireTransaction.subarray(65), fixture.message)

  // The device-trusted slot-3 public key must be the public half of the test
  // private key, and its compact signature must verify over SHA256(payload).
  const derivedPubkey = Buffer.from(secp256k1.getPublicKey(TEST_PRIV, true))
  nodeAssert.equal(derivedPubkey.toString('hex'), CI_TEST_PUBKEY)
  nodeAssert.equal(
    secp256k1.verify(fixture.signature, sha256(fixture.payload), derivedPubkey, { lowS: false }),
    true,
  )

  // Exact message, protocol, and discriminator bindings.
  nodeAssert.deepEqual(decoded.messageHash, Buffer.from(sha256(fixture.message)))
  nodeAssert.deepEqual(decoded.programId, PROGRAM_ID)
  nodeAssert.deepEqual(decoded.discriminator, DISCRIMINATOR)
  nodeAssert.deepEqual(fixture.message.subarray(37, 69), PROGRAM_ID)
  nodeAssert.equal(fixture.message[102], 1) // instruction program index
  nodeAssert.deepEqual(fixture.message.subarray(107, 115), DISCRIMINATOR)
  nodeAssert.equal(decoded.sourceAmount, 1500000000n)
  nodeAssert.equal(decoded.minimumOutput, 4200000n)
  nodeAssert.equal(decoded.protocol, 'Relay')
  nodeAssert.equal(decoded.sourceAsset, 'SOL')
  nodeAssert.equal(decoded.destinationChain, 'TRON')
  nodeAssert.equal(decoded.destinationAsset, 'TRX')
  nodeAssert.equal(decoded.destinationAddress, 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')
  nodeAssert.deepEqual(
    decodeSolanaAddress('11111111111111111111111111111111'),
    Buffer.alloc(32),
  )

  // Frozen canonical snapshot: catches accidental byte-order, field-order, or
  // deterministic-signature changes before any device test is attempted.
  nodeAssert.equal(fixture.payload.length, 193)
  nodeAssert.equal(
    Buffer.from(sha256(fixture.payload)).toString('hex'),
    '4a41ad7de9898b260a25ac8f32c9213f103d33553ec449708e77eb9c7760d091',
  )
  nodeAssert.equal(
    Buffer.from(sha256(fixture.signature)).toString('hex'),
    'd5e5c4b545e110cff6cbb8dc258438a532aee8fc0f3f3b1fa4ace200f1ad3f9c',
  )

  // Mutating the message invalidates descriptor binding.
  const mutatedMessage = Buffer.from(fixture.message)
  mutatedMessage[69] ^= 1 // recent blockhash byte; signer/program remain intact
  nodeAssert.notDeepEqual(decoded.messageHash, Buffer.from(sha256(mutatedMessage)))

  // Mutating any display claim invalidates the metadata signature.
  const mutatedPayload = Buffer.from(fixture.payload)
  mutatedPayload[107] ^= 1 // first protocol byte
  nodeAssert.equal(
    secp256k1.verify(fixture.signature, sha256(mutatedPayload), derivedPubkey, { lowS: false }),
    false,
  )

  // Firmware-equivalent strict parsing: unsafe percent text and trailing bytes
  // never downgrade to blind signing.
  const unsafePayload = Buffer.from(fixture.payload)
  unsafePayload[107] = 0x25
  nodeAssert.throws(() => decodeSolanaSwapMetadata(unsafePayload), /unsafe protocol/)
  nodeAssert.throws(
    () => decodeSolanaSwapMetadata(Buffer.concat([fixture.payload, Buffer.from([0])])),
    /trailing/,
  )
  nodeAssert.throws(
    () => serializeSolanaSwapMetadata({
      message: fixture.message,
      programId: PROGRAM_ID,
      discriminator: DISCRIMINATOR,
      expiresAt: 1n,
      sourceAmount: 1n,
      minimumOutput: 1n,
      sourceDecimals: 9,
      destinationDecimals: 6,
      protocol: 'Relay%spoof',
      sourceAsset: 'SOL',
      destinationChain: 'TRON',
      destinationAsset: 'TRX',
      destinationAddress: 'TRecipient',
      orderId: Buffer.from([1]),
    }),
    /unsafe display text/,
  )

  console.log(
    `\nSolana ClearSign offline descriptor: PASS ` +
    `(${fixture.payload.length}B KKSOLSW1, exact-message + instruction binding, strict display parsing)\n`,
  )
}

main()
