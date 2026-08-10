/**
 * Canonical KKSOLSW1 descriptor builder used by the KeepKey SDK tests.
 *
 * This intentionally lives in tests/fixtures so run-all.js does not execute it
 * as a suite. It mirrors docs/firmware/SOLANA-SWAP-METADATA-V1.md and signs
 * with the existing CI test key loaded into device ClearSign slot 3.
 */
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const {
  TEST_PRIV,
  TEST_KEY_ID,
  CI_TEST_PUBKEY,
  CI_SIGNER_ALIAS,
} = require('../_clearsign')

const MAGIC = Buffer.from('KKSOLSW1', 'ascii')
const PROGRAM_ID = Buffer.alloc(32, 0x44)
const DISCRIMINATOR = Buffer.from('0d9e0ddf5fd51c06', 'hex')
const ORDER_ID = Buffer.alloc(32, 0x77)
const MAX_PAYLOAD_BYTES = 320

function fixedBytes(value, length, name) {
  const bytes = Buffer.from(value)
  if (bytes.length !== length) throw new Error(`${name} must be ${length} bytes`)
  return bytes
}

function u64be(value, name) {
  const n = BigInt(value)
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`${name} is outside u64`)
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(n)
  return out
}

function displayText(value, maxLength, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  for (const char of value) {
    const codePoint = char.codePointAt(0)
    if (codePoint < 0x20 || codePoint > 0x7e || codePoint === 0x25) {
      throw new Error(`${name} contains unsafe display text`)
    }
  }
  const bytes = Buffer.from(value, 'ascii')
  if (!value || bytes.length > maxLength) {
    throw new Error(`${name} must be 1-${maxLength} ASCII bytes`)
  }
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

function serializeSolanaSwapMetadata(fields) {
  const sourceDecimals = Number(fields.sourceDecimals)
  const destinationDecimals = Number(fields.destinationDecimals)
  if (!Number.isInteger(sourceDecimals) || sourceDecimals < 0 || sourceDecimals > 18) {
    throw new Error('sourceDecimals must be an integer from 0 to 18')
  }
  if (!Number.isInteger(destinationDecimals) || destinationDecimals < 0 || destinationDecimals > 18) {
    throw new Error('destinationDecimals must be an integer from 0 to 18')
  }

  const message = Buffer.from(fields.message)
  if (message.length === 0) throw new Error('message must not be empty')
  const orderId = Buffer.from(fields.orderId)
  if (orderId.length < 1 || orderId.length > 32) {
    throw new Error('orderId must be 1-32 bytes')
  }

  const payload = Buffer.concat([
    MAGIC,
    Buffer.from(sha256(message)),
    fixedBytes(fields.programId, 32, 'programId'),
    fixedBytes(fields.discriminator, 8, 'discriminator'),
    u64be(fields.expiresAt, 'expiresAt'),
    u64be(fields.sourceAmount, 'sourceAmount'),
    u64be(fields.minimumOutput, 'minimumOutput'),
    Buffer.from([sourceDecimals, destinationDecimals]),
    displayText(fields.protocol, 20, 'protocol'),
    displayText(fields.sourceAsset, 12, 'sourceAsset'),
    displayText(fields.destinationChain, 16, 'destinationChain'),
    displayText(fields.destinationAsset, 12, 'destinationAsset'),
    displayText(fields.destinationAddress, 64, 'destinationAddress'),
    Buffer.from([orderId.length]),
    orderId,
  ])
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`KKSOLSW1 payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
  }
  return payload
}

function signSolanaSwapMetadata(payload, privateKey = TEST_PRIV) {
  const signature = secp256k1.sign(sha256(payload), privateKey, { lowS: false })
  return Buffer.from(signature.toCompactRawBytes())
}

/**
 * Build an opaque v0 message with a custom static program and one ALT account.
 * The custom instruction is structurally parsed but intentionally not decoded,
 * which is the exact case KKSOLSW1 is designed to ClearSign.
 */
function buildV0SwapMessage(signerPublicKey = Buffer.alloc(32, 0x11)) {
  const signer = fixedBytes(signerPublicKey, 32, 'signerPublicKey')
  return Buffer.concat([
    Buffer.from([0x80]),          // versioned message, v0
    Buffer.from([1, 0, 1]),       // one signer; custom program is readonly
    Buffer.from([2]),             // two static account keys
    signer,
    PROGRAM_ID,
    Buffer.alloc(32, 0xbb),       // recent blockhash
    Buffer.from([1]),             // one instruction
    Buffer.from([1]),             // program = static account 1
    Buffer.from([2, 0, 2]),       // signer + first writable ALT account
    Buffer.from([12]),            // instruction data length
    DISCRIMINATOR,
    Buffer.alloc(4, 0xaa),
    Buffer.from([1]),             // one address-table lookup
    Buffer.alloc(32, 0x55),       // lookup table account
    Buffer.from([1, 0]),          // one writable lookup: table index 0
    Buffer.from([0]),             // zero readonly lookups
  ])
}

function wrapUnsignedTransaction(message) {
  return Buffer.concat([
    Buffer.from([1]),             // compact-u16 signature count
    Buffer.alloc(64),             // empty signature slot
    Buffer.from(message),
  ])
}

function buildSolanaSwapFixture(signerPublicKey) {
  const message = buildV0SwapMessage(signerPublicKey)
  const wireTransaction = wrapUnsignedTransaction(message)
  const payload = serializeSolanaSwapMetadata({
    message,
    programId: PROGRAM_ID,
    discriminator: DISCRIMINATOR,
    expiresAt: 2000000000n,
    sourceAmount: 1500000000n,
    minimumOutput: 4200000n,
    sourceDecimals: 9,
    destinationDecimals: 6,
    protocol: 'Relay',
    sourceAsset: 'SOL',
    destinationChain: 'TRON',
    destinationAsset: 'TRX',
    destinationAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    orderId: ORDER_ID,
  })
  const signature = signSolanaSwapMetadata(payload)
  return {
    message,
    wireTransaction,
    payload,
    signature,
    metadata: {
      payload: payload.toString('base64'),
      signature: signature.toString('base64'),
      signerKeyId: TEST_KEY_ID,
    },
  }
}

/** Strict test-side decoder mirroring the firmware's payload parser. */
function decodeSolanaSwapMetadata(payload) {
  const bytes = Buffer.from(payload)
  let offset = 0
  function take(length, name) {
    if (offset + length > bytes.length) throw new Error(`truncated ${name}`)
    const out = bytes.subarray(offset, offset + length)
    offset += length
    return out
  }
  function readU64(name) {
    return take(8, name).readBigUInt64BE()
  }
  function readText(maxLength, name) {
    const length = take(1, `${name} length`)[0]
    if (length < 1 || length > maxLength) throw new Error(`invalid ${name} length`)
    const value = take(length, name)
    for (const byte of value) {
      if (byte < 0x20 || byte > 0x7e || byte === 0x25) {
        throw new Error(`unsafe ${name}`)
      }
    }
    return value.toString('ascii')
  }

  if (!take(8, 'magic').equals(MAGIC)) throw new Error('invalid KKSOLSW1 magic')
  const decoded = {
    messageHash: take(32, 'message hash'),
    programId: take(32, 'program id'),
    discriminator: take(8, 'discriminator'),
    expiresAt: readU64('expiry'),
    sourceAmount: readU64('source amount'),
    minimumOutput: readU64('minimum output'),
  }
  decoded.sourceDecimals = take(1, 'source decimals')[0]
  decoded.destinationDecimals = take(1, 'destination decimals')[0]
  if (decoded.sourceDecimals > 18 || decoded.destinationDecimals > 18) {
    throw new Error('invalid decimals')
  }
  decoded.protocol = readText(20, 'protocol')
  decoded.sourceAsset = readText(12, 'source asset')
  decoded.destinationChain = readText(16, 'destination chain')
  decoded.destinationAsset = readText(12, 'destination asset')
  decoded.destinationAddress = readText(64, 'destination address')
  const orderIdLength = take(1, 'order id length')[0]
  if (orderIdLength < 1 || orderIdLength > 32) throw new Error('invalid order id length')
  decoded.orderId = take(orderIdLength, 'order id')
  if (offset !== bytes.length) throw new Error('trailing KKSOLSW1 bytes')
  return decoded
}

/** Decode a raw Base58 Solana address into its 32-byte Ed25519 public key. */
function decodeSolanaAddress(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const char of address) {
    const digit = alphabet.indexOf(char)
    if (digit < 0) throw new Error(`invalid Base58 character: ${char}`)
    value = value * 58n + BigInt(digit)
  }
  const tail = []
  while (value > 0n) {
    tail.push(Number(value & 0xffn))
    value >>= 8n
  }
  tail.reverse()
  let leadingZeros = 0
  while (leadingZeros < address.length && address[leadingZeros] === '1') leadingZeros++
  const decoded = Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(tail)])
  if (decoded.length !== 32) throw new Error(`Solana address decoded to ${decoded.length} bytes`)
  return decoded
}

module.exports = {
  MAGIC,
  PROGRAM_ID,
  DISCRIMINATOR,
  ORDER_ID,
  MAX_PAYLOAD_BYTES,
  TEST_KEY_ID,
  CI_TEST_PUBKEY,
  CI_SIGNER_ALIAS,
  TEST_PRIV,
  serializeSolanaSwapMetadata,
  signSolanaSwapMetadata,
  buildV0SwapMessage,
  wrapUnsignedTransaction,
  buildSolanaSwapFixture,
  decodeSolanaSwapMetadata,
  decodeSolanaAddress,
}
