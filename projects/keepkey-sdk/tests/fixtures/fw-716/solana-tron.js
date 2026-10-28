/**
 * Solana and TRON transaction builders for tests/fw-716/04, 12, 13, 36, 39.
 * Not a suite (run-all.js skips tests/fixtures). Requiring it does no I/O.
 *
 * Generator note: nothing here is a stored fixture. Every suite builds its
 * transaction at run time from these functions with a random Solana blockhash
 * or random TRON ref_block_bytes/ref_block_hash, so no signature produced on
 * the owner's device can ever land on chain. Byte layouts follow:
 *   - Solana legacy message: header, compact-u16 account keys, blockhash,
 *     compact-u16 instructions (what Desktop's solana-tx.ts and the firmware
 *     parse).
 *   - TRON protocol.Transaction.raw: the fields firmware tron_parseRawTx
 *     accepts (1, 4, 8, 11, 14, 18), as in python-keepkey
 *     tests/test_msg_tron_signtx.py _trc20_transfer_raw_data.
 * Offline checks for these builders: see the suites' headers.
 */
const crypto = require('node:crypto')
const { encodeBase58, decodeBase58, SigningKey, Signature, computeAddress } = require('ethers')

// ── Base58 ───────────────────────────────────────────────────────────

/** Base58 string to exactly `len` bytes (leading '1's are zero bytes). */
function b58decode(text, len) {
  const hex = decodeBase58(text).toString(16)
  const out = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')
  if (out.length > len) throw new Error(`base58 ${text} is longer than ${len} bytes`)
  return Buffer.concat([Buffer.alloc(len - out.length), out])
}
const b58encode = (bytes) => encodeBase58(Uint8Array.from(bytes))

// ── Solana ───────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/** Relay Bridge depositNative, the catalog entry `relayDepositNative`
 *  (Desktop solana-certified-schema.ts). Accounts as in the production quote
 *  captured in keepkey-vault __tests__/fixtures/solana/relay-deposit-native-no-alt.json:
 *  instruction accounts [config, depositor, refundTo, vault, system]. */
const RELAY = {
  program: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
  instruction: 'depositNative',
  catalogKey: 'relayDepositNative',
  discriminator: Buffer.from('0d9e0ddf5fd51c06', 'hex'),
  vault: '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ',
  config: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc',
}

function compactU16(n) {
  const out = []
  for (;;) {
    const b = n & 0x7f
    n >>= 7
    if (n === 0) { out.push(b); return Buffer.from(out) }
    out.push(b | 0x80)
  }
}

/**
 * Legacy message. `keys` are 32-byte buffers in Solana order (writable
 * signers, readonly signers, writable non-signers, readonly non-signers);
 * `header` is [numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned];
 * each instruction is { program: index, accounts: [index], data: Buffer }.
 */
function legacyMessage({ header, keys, blockhash, instructions }) {
  const parts = [Buffer.from(header), compactU16(keys.length), ...keys, blockhash, compactU16(instructions.length)]
  for (const ix of instructions) {
    parts.push(Buffer.from([ix.program]), compactU16(ix.accounts.length), Buffer.from(ix.accounts),
      compactU16(ix.data.length), ix.data)
  }
  return Buffer.concat(parts)
}

/** Wire transaction with empty (zero) signature slots, base64. */
function unsignedWireTx(message) {
  const sigCount = message[0]
  return Buffer.concat([compactU16(sigCount), Buffer.alloc(64 * sigCount), message]).toString('base64')
}

function u64le(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

/** SystemProgram Transfer: u32 LE 2, u64 LE lamports (12 bytes). */
function systemTransferData(lamports) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(2)
  return Buffer.concat([b, u64le(lamports)])
}

/** 1-lamport transfer from `from` to `to` (both base58), `from` the only
 *  signer and fee payer. from === to gives the self-transfer. */
function solTransferMessage(from, to, lamports, blockhash) {
  const self = from === to
  const keys = self
    ? [b58decode(from, 32), b58decode(SYSTEM_PROGRAM, 32)]
    : [b58decode(from, 32), b58decode(to, 32), b58decode(SYSTEM_PROGRAM, 32)]
  const system = keys.length - 1
  return legacyMessage({
    header: [1, 0, 1], keys, blockhash,
    instructions: [{ program: system, accounts: self ? [0, 0] : [0, 1], data: systemTransferData(lamports) }],
  })
}

/** The self-transfer plus one instruction to `unknownProgram` (32 bytes),
 *  no accounts, one data byte. */
function solTransferPlusUnknownMessage(owner, unknownProgram, blockhash) {
  return legacyMessage({
    header: [1, 0, 2],
    keys: [b58decode(owner, 32), b58decode(SYSTEM_PROGRAM, 32), unknownProgram],
    blockhash,
    instructions: [
      { program: 1, accounts: [0, 0], data: systemTransferData(1) },
      { program: 2, accounts: [], data: Buffer.from([0x01]) },
    ],
  })
}

/** Relay depositNative from `depositor` (signer, fee payer, refundTo).
 *  Data: discriminator, u64 lamports, 32-byte order id (48 bytes). */
function relayDepositNativeMessage(depositor, lamports, orderId, blockhash) {
  return legacyMessage({
    header: [1, 0, 3],
    keys: [b58decode(depositor, 32), b58decode(RELAY.vault, 32), b58decode(RELAY.program, 32),
      b58decode(RELAY.config, 32), b58decode(SYSTEM_PROGRAM, 32)],
    blockhash,
    instructions: [{
      program: 2, accounts: [3, 0, 0, 1, 4],
      data: Buffer.concat([RELAY.discriminator, u64le(lamports), orderId]),
    }],
  })
}

/** Throwaway ed25519 keypair: { address (base58), publicKey (32 bytes) }. */
function throwawaySolanaKey() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  return { address: b58encode(raw), publicKey: raw }
}

/** ed25519 verify of a 64-byte signature over `message` by a base58 key. */
function ed25519Verify(signature, message, address) {
  const key = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b58decode(address, 32).toString('base64url') }, format: 'jwk',
  })
  return crypto.verify(null, message, key, signature)
}

// ── TRON ─────────────────────────────────────────────────────────────

/** Firmware trusted TRC-20 table (scripts/tron_tokens.json): USDT, USDD, WTRX. */
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
/** USDC on TRON: a real TRC-20 the table leaves out on purpose (Circle ended
 *  TRON support), so a transfer on it is outside the trusted table. */
const TRON_USDC = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'
const TRIGGER_URL = 'type.googleapis.com/protocol.TriggerSmartContract'

function varint(n) {
  let v = BigInt(n)
  const out = []
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n }
  out.push(Number(v))
  return Buffer.from(out)
}
const pbBytes = (field, payload) => Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload])
const pbUint = (field, value) => Buffer.concat([varint(field << 3), varint(value)])

const sha256 = (b) => crypto.createHash('sha256').update(b).digest()

/** 21-byte 0x41 address from Base58Check, checksum verified. */
function tronAddressBytes(address) {
  const raw = b58decode(address, 25)
  const payload = raw.subarray(0, 21)
  if (!sha256(sha256(payload)).subarray(0, 4).equals(raw.subarray(21))) throw new Error(`bad TRON checksum: ${address}`)
  if (payload[0] !== 0x41) throw new Error(`not a TRON address: ${address}`)
  return payload
}
const tronAddressFromBytes = (raw21) => b58encode(Buffer.concat([raw21, sha256(sha256(raw21)).subarray(0, 4)]))

/**
 * protocol.Transaction.raw for one TriggerSmartContract transfer(address,
 * uint256) of `amount` base units on `contract` from `owner` to `to`, with
 * random ref_block_bytes (2) and ref_block_hash (8): TaPoS can never match a
 * real block, so the transaction can never be accepted. Returns hex.
 */
function trc20TransferRaw({ owner, contract, to, amount, feeLimit, now = Date.now() }) {
  const calldata = Buffer.concat([
    Buffer.from('a9059cbb', 'hex'), Buffer.alloc(12), tronAddressBytes(to).subarray(1),
    Buffer.from(BigInt(amount).toString(16).padStart(64, '0'), 'hex'),
  ])
  const trigger = Buffer.concat([pbBytes(1, tronAddressBytes(owner)), pbBytes(2, tronAddressBytes(contract)), pbBytes(4, calldata)])
  const contractMsg = Buffer.concat([pbUint(1, 31), pbBytes(2, Buffer.concat([pbBytes(1, Buffer.from(TRIGGER_URL)), pbBytes(2, trigger)]))])
  return Buffer.concat([
    pbBytes(1, crypto.randomBytes(2)),
    pbBytes(4, crypto.randomBytes(8)),
    pbUint(8, now + 10 * 60 * 1000),
    pbBytes(11, contractMsg),
    pbUint(14, now),
    pbUint(18, feeLimit),
  ]).toString('hex')
}

/** TRON address that signed sha256(raw_data) with a 65-byte r||s||v
 *  signature (v = recovery id 0/1, or 27/28). */
function recoverTronSigner(rawHex, signatureHex) {
  const sig = Buffer.from(String(signatureHex).replace(/^0x/, ''), 'hex')
  if (sig.length !== 65) throw new Error(`signature is ${sig.length} bytes, expected 65`)
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64]
  const signature = Signature.from({ r: '0x' + sig.subarray(0, 32).toString('hex'), s: '0x' + sig.subarray(32, 64).toString('hex'), v: 27 + v })
  const pub = SigningKey.recoverPublicKey(sha256(Buffer.from(rawHex, 'hex')), signature)
  return tronAddressFromBytes(Buffer.from('41' + computeAddress(pub).slice(2), 'hex'))
}

module.exports = {
  b58decode, b58encode,
  SYSTEM_PROGRAM, RELAY, legacyMessage, unsignedWireTx, systemTransferData, solTransferMessage, solTransferPlusUnknownMessage,
  relayDepositNativeMessage, throwawaySolanaKey, ed25519Verify,
  TRON_USDT, TRON_USDC, tronAddressBytes, tronAddressFromBytes, trc20TransferRaw, recoverTronSigner,
}
