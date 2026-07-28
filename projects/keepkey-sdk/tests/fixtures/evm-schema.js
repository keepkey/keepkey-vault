/**
 * EVM v2 clear-sign schema blobs ("METADATA_VERSION_SCHEMA").
 *
 * A v2 blob describes ONE (chain, contract, selector): the method name and the
 * labelled args, each occupying exactly one 32-byte ABI word. It carries no
 * values and NO tx_hash, so it is signed once and reused for every future call
 * to that method — the device decodes the args from the calldata it is about
 * to sign.
 *
 * Byte-for-byte mirror of the firmware:
 *   keepkey-firmware lib/firmware/signed_metadata.c
 *     parse_metadata_binary()  — header layout
 *     parse_v2_args()          — arg encoding + accepted formats
 *     decode_v2_args()         — "4 + 32*num_args == calldata length" exactly
 *
 * Lives in tests/fixtures so run-all.js does not execute it as a suite.
 */
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const { TEST_PRIV, TEST_KEY_ID, CI_TEST_PUBKEY, CI_SIGNER_ALIAS } = require('../_clearsign')

const METADATA_VERSION_SCHEMA = 0x02

/** ArgFormat values the v2 parser accepts (signed_metadata.h). */
const ARG_ADDRESS = 1
const ARG_AMOUNT = 2
const ARG_BYTES = 3
const ARG_TOKEN_AMOUNT = 5
/* STRING (4) and RAW (0) are deliberately absent: they are not readable from a
 * single fixed word, so accepting them would break the completeness rule that
 * makes a hash-free schema safe. */

const CLASSIFICATION_VERIFIED = 1

function u8(v) {
  return Buffer.from([v & 0xff])
}
function be16(v) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(v)
  return b
}
function be32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0)
  return b
}
function hexBytes(hex, expectLen, name) {
  const clean = hex.replace(/^0x/, '')
  const buf = Buffer.from(clean, 'hex')
  if (expectLen != null && buf.length !== expectLen) {
    throw new Error(`${name} must be ${expectLen} bytes, got ${buf.length}`)
  }
  return buf
}

/**
 * Serialize the signed body of a v2 schema.
 * @param {{chainId:number, contract:string, selector:string, method:string,
 *          args:{name:string,format:number,decimals?:number,symbol?:string}[],
 *          keyId?:number}} spec
 */
function buildV2Body(spec) {
  const parts = [
    u8(METADATA_VERSION_SCHEMA),
    be32(spec.chainId),
    hexBytes(spec.contract, 20, 'contract'),
    hexBytes(spec.selector, 4, 'selector'),
    be16(Buffer.byteLength(spec.method, 'ascii')),
    Buffer.from(spec.method, 'ascii'),
    u8(spec.args.length),
  ]
  for (const a of spec.args) {
    parts.push(u8(Buffer.byteLength(a.name, 'ascii')), Buffer.from(a.name, 'ascii'), u8(a.format))
    if (a.format === ARG_TOKEN_AMOUNT) {
      parts.push(u8(a.decimals), u8(a.symbol.length), Buffer.from(a.symbol, 'ascii'))
    }
  }
  parts.push(
    u8(CLASSIFICATION_VERIFIED),
    be32(0), // timestamp — v2 carries no freshness claim
    u8(spec.keyId ?? TEST_KEY_ID),
  )
  return Buffer.concat(parts)
}

/**
 * Sign the body: 64-byte compact secp256k1 over SHA256(body), then a
 * recovery byte (27 + pby). lowS:false matches the reference signer — see
 * tests/_clearsign.js for why noble's default diverges.
 */
function signV2(body, privateKey = TEST_PRIV) {
  const sig = secp256k1.sign(sha256(body), privateKey, { lowS: false })
  const compact = Buffer.from(sig.toCompactRawBytes())
  return Buffer.concat([body, compact, Buffer.from([27 + (sig.recovery ?? 0)])])
}

/** A complete signed v2 blob, base64 for the Vault/SDK txMetadata field. */
function buildSignedV2(spec) {
  const body = buildV2Body(spec)
  const blob = signV2(body, spec.privateKey)
  return {
    body,
    blob,
    txMetadata: { signedPayload: blob.toString('base64'), keyId: spec.keyId ?? TEST_KEY_ID },
  }
}

/**
 * Real Relay routes, captured from api.relay.link on 2026-07-27.
 *
 * ETH -> Solana was the transaction that motivated this whole path: it sends
 * native ETH (payable) and its second arg is an opaque order id, so it needed
 * both the payable-schema fix and BYTES support before it could clear-sign.
 */
const CATALOG = {
  relayBridgeDepositEth: {
    chainId: 1,
    contract: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    selector: '0x49290c1c',
    method: 'bridgeDeposit',
    args: [
      { name: 'depositor', format: ARG_ADDRESS },
      { name: 'orderId', format: ARG_BYTES },
    ],
    /** Calldata is 4 + 2*32; the device requires this to match exactly. */
    expectedCalldataLength: 68,
  },
}

/** Bytes a schema claims: selector + one word per arg. */
function expectedCalldataLength(spec) {
  return 4 + 32 * spec.args.length
}

module.exports = {
  METADATA_VERSION_SCHEMA,
  ARG_ADDRESS,
  ARG_AMOUNT,
  ARG_BYTES,
  ARG_TOKEN_AMOUNT,
  CLASSIFICATION_VERIFIED,
  TEST_KEY_ID,
  CI_TEST_PUBKEY,
  CI_SIGNER_ALIAS,
  TEST_PRIV,
  CATALOG,
  buildV2Body,
  signV2,
  buildSignedV2,
  expectedCalldataLength,
}
