import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import {
  ALPHA_DELEGATE_PUBLIC_KEY,
  ALPHA_DELEGATE_FINGERPRINT,
  CLEARSIGN_SCOPE_ETHEREUM,
  inspectAlphaCertificate,
} from './clearsign-alpha-ceremony'

export const CERTIFIED_METADATA_VERSION = 0x03
export const CERTIFIED_METADATA_KEY_ID = 0x80

export const EVM_ARG_ADDRESS = 1
export const EVM_ARG_AMOUNT = 2
export const EVM_ARG_BYTES = 3
export const EVM_ARG_TOKEN_AMOUNT = 5
export const EVM_DECODER_PORTALS_NATIVE_ORDER_V1 = 1

export interface EvmSchemaArg {
  name: string
  format: number
  decimals?: number
  symbol?: string
}

export interface EvmSchemaSpec {
  chainId: number
  contract: string
  selector: string
  method: string
  args: EvmSchemaArg[]
  /** Fixed v2 schemas account for every byte exactly. */
  expectedCalldataLength?: number
  /** v4 schemas select a reviewed firmware decoder for dynamic calldata. */
  decoder?: number
  minimumCalldataLength?: number
  maximumCalldataLength?: number
  displayFields?: string[]
  protocol?: string
  maintainedBy?: string
  action?: string
  provenance?: Record<string, string>
}

export const CERTIFIED_EVM_CATALOG: Record<string, EvmSchemaSpec> = {
  '1:0x4cd00e387622c35bddb9b4c962c136462338bc31:0x49290c1c': {
    chainId: 1,
    contract: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    selector: '0x49290c1c',
    method: 'bridgeDeposit',
    args: [
      { name: 'depositor', format: EVM_ARG_ADDRESS },
      { name: 'orderId', format: EVM_ARG_BYTES },
    ],
    expectedCalldataLength: 68,
  },
  '1:0xbf5a7f3629fb325e2a8453d595ab103465f75e62:0xa2e42c65': {
    chainId: 1,
    contract: '0xbf5A7F3629fB325E2a8453D595AB103465F75E62',
    selector: '0xa2e42c65',
    method: 'Portals swap',
    args: [],
    decoder: EVM_DECODER_PORTALS_NATIVE_ORDER_V1,
    minimumCalldataLength: 452,
    maximumCalldataLength: 16_388,
    displayFields: ['Output token', 'Minimum output', 'Recipient', 'Native input amount'],
    protocol: 'Portals',
    maintainedBy: 'Portals',
    action: 'Swap native ETH through the Portals router',
    provenance: {
      protocol: 'https://docs.portals.fi/',
      verifiedContract: 'https://eth.blockscout.com/address/0xbf5A7F3629fB325E2a8453D595AB103465F75E62?tab=contract',
    },
  },
}

function ascii(value: string, max: number, label: string): Buffer {
  const bytes = Buffer.from(String(value || ''), 'ascii')
  if (bytes.length < 1 || bytes.length > max || bytes.toString('ascii') !== value) {
    throw new Error(`${label} must be 1-${max} printable ASCII characters`)
  }
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e || byte === 0x25) {
      throw new Error(`${label} contains a character the device will not render`)
    }
  }
  return bytes
}

function hexBytes(value: string, length: number, label: string): Buffer {
  const clean = String(value || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== length * 2) {
    throw new Error(`${label} must be exactly ${length} bytes of hex`)
  }
  return Buffer.from(clean, 'hex')
}

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff])
}

function be16(value: number): Buffer {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(value)
  return out
}

function be32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value)
  return out
}

export function findCertifiedEvmSchemaSpec(
  chainId: number | undefined,
  contract: string | undefined,
  data: string | undefined,
): EvmSchemaSpec | undefined {
  if (!chainId || !contract || !data) return undefined
  const calldata = data.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(calldata) || calldata.length < 8 || calldata.length % 2 !== 0) return undefined
  return findCertifiedEvmSchemaByShape(
    chainId,
    contract,
    `0x${calldata.slice(0, 8).toLowerCase()}`,
    calldata.length / 2,
  )
}

/** Match without sending transaction arguments to a remote schema service. */
export function findCertifiedEvmSchemaByShape(
  chainId: number | undefined,
  contract: string | undefined,
  selector: string | undefined,
  calldataLength: number | undefined,
): EvmSchemaSpec | undefined {
  if (!chainId || !contract || !selector || !Number.isInteger(calldataLength)) return undefined
  const normalizedSelector = selector.toLowerCase()
  if (!/^0x[0-9a-f]{8}$/.test(normalizedSelector)) return undefined
  const spec = CERTIFIED_EVM_CATALOG[`${chainId}:${contract.toLowerCase()}:${normalizedSelector}`]
  if (!spec) return undefined
  if (spec.expectedCalldataLength !== undefined) {
    if (calldataLength !== spec.expectedCalldataLength) return undefined
  } else {
    if (!spec.decoder || spec.minimumCalldataLength === undefined || spec.maximumCalldataLength === undefined) return undefined
    if (calldataLength < spec.minimumCalldataLength || calldataLength > spec.maximumCalldataLength) return undefined
    if ((calldataLength - 4) % 32 !== 0) return undefined
  }
  return spec
}

/** Serialize a device-decoded v2 or v4 schema. */
export function buildEvmSchemaBody(spec: EvmSchemaSpec): Buffer {
  if (!Number.isInteger(spec.chainId) || spec.chainId <= 0 || spec.chainId > 0xffffffff) {
    throw new Error('schema chainId must be a nonzero uint32')
  }
  const method = ascii(spec.method, 64, 'method')
  if (spec.decoder !== undefined) {
    if (spec.decoder !== EVM_DECODER_PORTALS_NATIVE_ORDER_V1 || spec.args.length !== 0) {
      throw new Error('unsupported EVM dynamic decoder')
    }
    if (spec.minimumCalldataLength === undefined || spec.maximumCalldataLength === undefined) {
      throw new Error('dynamic schema requires calldata bounds')
    }
    return Buffer.concat([
      u8(0x04),
      be32(spec.chainId),
      hexBytes(spec.contract, 20, 'contract'),
      hexBytes(spec.selector, 4, 'selector'),
      be16(method.length),
      method,
      u8(spec.decoder),
      u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID),
    ])
  }
  if (spec.expectedCalldataLength !== 4 + 32 * spec.args.length) {
    throw new Error('schema argument widths do not account for the complete calldata')
  }
  const parts: Buffer[] = [
    u8(0x02),
    be32(spec.chainId),
    hexBytes(spec.contract, 20, 'contract'),
    hexBytes(spec.selector, 4, 'selector'),
    be16(method.length),
    method,
    u8(spec.args.length),
  ]
  for (const arg of spec.args) {
    const name = ascii(arg.name, 32, 'argument name')
    if (![EVM_ARG_ADDRESS, EVM_ARG_AMOUNT, EVM_ARG_BYTES, EVM_ARG_TOKEN_AMOUNT].includes(arg.format)) {
      throw new Error(`unsupported EVM schema format ${arg.format}`)
    }
    parts.push(u8(name.length), name, u8(arg.format))
    if (arg.format === EVM_ARG_TOKEN_AMOUNT) {
      const symbol = ascii(arg.symbol || '', 10, 'token symbol')
      if (!Number.isInteger(arg.decimals) || arg.decimals! < 0 || arg.decimals! > 36) {
        throw new Error('token decimals must be 0-36')
      }
      parts.push(u8(arg.decimals!), u8(symbol.length), symbol)
    }
  }
  parts.push(u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID))
  return Buffer.concat(parts)
}

/** Backwards-compatible name retained for existing v2 callers/tests. */
export const buildEvmV2SchemaBody = buildEvmSchemaBody

export function buildCertifiedEvmEnvelope(
  spec: EvmSchemaSpec,
  certificateHex: string,
  delegatePrivateKeyHex: string,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
  const certificate = hexBytes(certificateHex, 139, 'alpha certificate')
  const certificateInfo = inspectAlphaCertificate(certificate.toString('hex'))
  if (certificateInfo.chainId !== CLEARSIGN_SCOPE_ETHEREUM) {
    throw new Error(`certificate is scoped to ${certificateInfo.chainId}, not Ethereum (${CLEARSIGN_SCOPE_ETHEREUM})`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }

  const body = buildEvmSchemaBody(spec)
  const digest = createHash('sha256').update(body).digest('hex')
  const signature = signingKey.signDigest(`0x${digest}`)
  const compact = Buffer.concat([
    hexBytes(signature.r, 32, 'signature r'),
    hexBytes(signature.s, 32, 'signature s'),
    u8(27 + (signature.recoveryParam ?? 0)),
  ])
  const inner = Buffer.concat([body, compact])
  const envelope = Buffer.concat([u8(CERTIFIED_METADATA_VERSION), certificate, inner])
  return {
    signedPayload: `0x${envelope.toString('hex')}`,
    keyId: CERTIFIED_METADATA_KEY_ID,
    fingerprint: ALPHA_DELEGATE_FINGERPRINT,
    alias: certificateInfo.alias,
  }
}

export function isCertifiedEvmMetadata(metadata: unknown): boolean {
  const candidate = metadata as { signedPayload?: unknown; keyId?: unknown } | null
  if (!candidate || candidate.keyId !== CERTIFIED_METADATA_KEY_ID) return false
  const payload = candidate.signedPayload
  if (payload instanceof Uint8Array) return payload.length > 140 && payload[0] === CERTIFIED_METADATA_VERSION
  if (typeof payload !== 'string') return false
  const clean = payload.replace(/^0x/i, '')
  return clean.length > 280 && clean.slice(0, 2).toLowerCase() === '03' && /^[0-9a-fA-F]+$/.test(clean)
}
