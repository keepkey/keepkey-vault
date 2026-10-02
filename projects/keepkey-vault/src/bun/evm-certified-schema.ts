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
  /** v0x05: ROLE_* (1-5) on amounts, 0 otherwise. */
  role?: number
}

/** v0x05 roles, numbered as Solana KKSOLSC1 v3. */
export const ROLE_SPEND_MAX = 1
export const ROLE_RECEIVE_MIN = 2
export const ROLE_SPEND_EXACT = 3
export const ROLE_RECEIVE_EXACT = 4
export const ROLE_CAP = 5

/** Human-readable review (SRS-7.16 §3.7): firmware fills every value. */
export interface EvmIntent {
  title: string
  /** `{n}` = arg n, `{v}` = msg.value; <=96 chars. */
  template: string
  /** ROLE_SPEND_EXACT / ROLE_SPEND_MAX when msg.value moves; else 0. */
  valueRole: number
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
  intent?: EvmIntent
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
    intent: {
      title: 'Relay',
      template: 'Bridge {v} through Relay for {0}; delivery is by Relay',
      valueRole: ROLE_SPEND_EXACT,
    },
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

export const EVM_NAME_RECORD_VERSION = 0x06

/** A vouched name for one address on one chain (firmware METADATA_VERSION_NAME).
 * The device shows it only beside that exact address; it describes nothing. */
export interface EvmNameRecord {
  chainId: number
  address: string
  name: string
  source: string
}

/** Uniswap Universal Router deployments, verbatim from Uniswap's own repo:
 * https://github.com/Uniswap/universal-router/tree/a9c574f6caf1d6f1b51facd3fe32dec7c4df392c/deploy-addresses
 * These are the Permit2 spenders in Uniswap's swap flow. */
export const UNIVERSAL_ROUTER_PROVENANCE =
  'https://github.com/Uniswap/universal-router/tree/a9c574f6caf1d6f1b51facd3fe32dec7c4df392c/deploy-addresses'
export const CERTIFIED_EVM_NAMES: EvmNameRecord[] = [
  { chainId: 1, address: '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV1' },
  { chainId: 1, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV1_2_V2Support' },
  { chainId: 1, address: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2' },
  { chainId: 1, address: '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2_1_1' },
  { chainId: 1, address: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2_1_2' },
  { chainId: 42161, address: '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1' },
  { chainId: 42161, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 42161, address: '0x5e325eda8064b456f4781070c0738d849c824258', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1_2_V2Support' },
  { chainId: 42161, address: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2' },
  { chainId: 42161, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2_1_1' },
  { chainId: 42161, address: '0x2d01411773c8c24805306e89a41f7855c3c4fe65', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2_1_2' },
  { chainId: 56, address: '0x5dc88340e1c5c6366864ee415d6034cadd1a9897', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV1' },
  { chainId: 56, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 56, address: '0x4dae2f939acf50408e13d58534ff8c2776d45265', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV1_2_V2Support' },
  { chainId: 56, address: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV2' },
  { chainId: 56, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV2_1_1' },
  { chainId: 56, address: '0xdc264714f68d84cf29bc605589405e78bdbe7c9f', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV2_1_2' },
  { chainId: 8453, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 8453, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV1_2_V2Support' },
  { chainId: 8453, address: '0x6ff5693b99212da76ad316178a184ab56d299b43', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2' },
  { chainId: 8453, address: '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2_1_1' },
  { chainId: 8453, address: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2_1_2' },
  { chainId: 10, address: '0xb555edf5dcf85f42ceef1f3630a52a108e55a654', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV1' },
  { chainId: 10, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 10, address: '0xcb1355ff08ab38bbce60111f1bb2b784be25d7e8', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV1_2_V2Support' },
  { chainId: 10, address: '0x851116d9223fabed8e56c0e6b8ad0c31d98b3507', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV2' },
  { chainId: 10, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV2_1_1' },
  { chainId: 10, address: '0xc09255d86db563cbc11c2fcf4a0c512e160111b4', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV2_1_2' },
  { chainId: 137, address: '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV1' },
  { chainId: 137, address: '0x643770e279d5d0733f21d6dc03a8efbabf3255b4', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 137, address: '0xec7be89e9d109e7e3fec59c222cf297125fefda2', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV1_2_V2Support' },
  { chainId: 137, address: '0x1095692a6237d83c6a72f3f5efedb9a670c49223', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV2' },
  { chainId: 137, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV2_1_1' },
  { chainId: 137, address: '0xdc264714f68d84cf29bc605589405e78bdbe7c9f', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV2_1_2' },
]

export function findEvmNameRecord(chainId: number | undefined, address: string | undefined): EvmNameRecord | undefined {
  if (!chainId || !address) return undefined
  const a = address.toLowerCase()
  return CERTIFIED_EVM_NAMES.find((r) => r.chainId === chainId && r.address === a)
}

export function buildEvmNameBody(record: EvmNameRecord): Buffer {
  const name = ascii(record.name, 24, 'name')
  return Buffer.concat([
    u8(EVM_NAME_RECORD_VERSION),
    be32(record.chainId),
    hexBytes(record.address, 20, 'address'),
    u8(name.length),
    name,
    u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID),
  ])
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
  const intent = spec.intent
  if (intent) validateEvmIntent(spec, intent)
  if (spec.expectedCalldataLength !== 4 + 32 * spec.args.length) {
    throw new Error('schema argument widths do not account for the complete calldata')
  }
  const parts: Buffer[] = [
    u8(intent ? 0x05 : 0x02),
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
    if (intent) parts.push(u8(arg.role ?? 0))
  }
  if (intent) {
    const title = ascii(intent.title, 20, 'intent title')
    const template = ascii(intent.template, 96, 'intent template')
    parts.push(u8(intent.valueRole), u8(title.length), title, u8(template.length), template)
  }
  parts.push(u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID))
  return Buffer.concat(parts)
}

const isAmount = (format: number) => format === EVM_ARG_AMOUNT || format === EVM_ARG_TOKEN_AMOUNT

/** Mirrors firmware signed_metadata_intent_valid(): certify only what it accepts. */
export function validateEvmIntent(spec: EvmSchemaSpec, intent: EvmIntent): void {
  if (![0, ROLE_SPEND_MAX, ROLE_SPEND_EXACT].includes(intent.valueRole)) throw new Error('value role must be 0, spend-max or spend-exact')
  spec.args.forEach((arg, i) => {
    const role = arg.role ?? 0
    if (isAmount(arg.format) ? role < ROLE_SPEND_MAX || role > ROLE_CAP : role !== 0) {
      throw new Error(`argument ${i} (${arg.name}) has an invalid role ${role}`)
    }
  })
  const used = new Set<number>()
  let value = false
  let width = 0
  const literal = intent.template.replace(/\{(v|\d)\}/g, (_, p) => {
    if (p === 'v') {
      value = true
      width += 90
      return ''
    }
    const i = Number(p)
    const arg = spec.args[i]
    if (!arg || ![EVM_ARG_ADDRESS, EVM_ARG_AMOUNT, EVM_ARG_TOKEN_AMOUNT].includes(arg.format)) {
      throw new Error(`template placeholder {${p}} is out of range or not displayable in a sentence`)
    }
    used.add(i)
    width += arg.format === EVM_ARG_ADDRESS ? 13 : 90
    return ''
  })
  if (/[{}]/.test(literal)) throw new Error('template has a stray brace')
  // Firmware refuses digits outside placeholders: numbers come only from signed bytes.
  if (/[0-9]/.test(literal)) throw new Error('template states a number of its own; values must come from placeholders')
  width += literal.length
  if (width > 280) throw new Error(`template can expand to ${width} chars; firmware limit is 280`)
  spec.args.forEach((arg, i) => {
    if (isAmount(arg.format) && !used.has(i)) throw new Error(`template must state amount ${arg.name}`)
  })
  if (value !== (intent.valueRole !== 0)) throw new Error('{v} must appear exactly when the value has a role')
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
  return signCertifiedEvmBody(body, certificate, certificateInfo.alias, signingKey)
}

/** A certified name record; the certificate must be scoped to its chain. */
export function buildCertifiedEvmNameEnvelope(
  record: EvmNameRecord,
  certificateHex: string,
  delegatePrivateKeyHex: string,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
  const certificate = hexBytes(certificateHex, 139, 'alpha certificate')
  const certificateInfo = inspectAlphaCertificate(certificate.toString('hex'))
  if (certificateInfo.chainId !== record.chainId) {
    throw new Error(`certificate is scoped to ${certificateInfo.chainId}, not chain ${record.chainId}`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }
  return signCertifiedEvmBody(buildEvmNameBody(record), certificate, certificateInfo.alias, signingKey)
}

function signCertifiedEvmBody(
  body: Buffer,
  certificate: Buffer,
  alias: string,
  signingKey: InstanceType<typeof ethersUtils.SigningKey>,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
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
    alias,
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
