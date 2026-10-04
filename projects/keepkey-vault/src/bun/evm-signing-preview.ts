/**
 * EVM signing-overlay verdict shared by the REST and WalletConnect paths.
 *
 * Owner policy, predicted exactly as the device enforces it:
 *   needsAdvancedMode = !(firmwareNativelyDecodes || (fw >= 7.16 && certifiedPayloadAttached))
 * Runtime/provider metadata is annotation only and never relaxes the verdict.
 */
import type { SigningRequestInfo } from '../shared/types'
import { decodeCalldata, firmwareClearSigns } from './calldata-decoder'
import { findCertifiedEvmSchema, findCertifiedUniswapSwap } from './evm-schema-registry'
import { findReviewedUniversalRouter } from './evm-certified-schema'
import { urPrecheck } from './uniswap-ur'
import { supportsCertifiedClearSign } from './solana-certified-policy'

/** A chain id as dapps send it (number, "8453", "0x2105") → positive integer, else undefined. */
export function normalizeEvmChainId(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  const n = /^0x[0-9a-fA-F]+$/.test(s) ? parseInt(s, 16) : /^[0-9]+$/.test(s) ? parseInt(s, 10) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** EIP-1559 priority fee for hdwallet: a zero/absent fee must be '0x' (empty
 *  RLP string). hdwallet does not strip it, and a literal 0x00 byte makes the
 *  firmware hash non-canonically → wrong recovered signer, unbroadcastable. */
export function evmPriorityFee(prio: unknown): string {
  const raw = prio == null ? '' : String(prio)
  return (!raw || /^0x0*$/.test(raw)) ? '0x' : raw
}

/**
 * Attach a KeepKey-certified (keyId 0x80) schema for this exact call to the
 * overlay info, where the sign handler picks it up as txMetadata. Only the
 * certified service lookup — never the local CI-key registry. Returns false
 * (existing path) on older firmware, no schema, or a lookup failure.
 */
export async function attachCertifiedEvmSchema(
  signingInfo: SigningRequestInfo,
  chainId: number | undefined,
  to: string,
  data: string,
  firmwareVersion: string | undefined,
  tag = '[REST]',
): Promise<boolean> {
  if (!supportsCertifiedClearSign(firmwareVersion)) return false
  let schema
  try {
    schema = await findCertifiedEvmSchema(chainId, to, data)
  } catch (e: any) {
    console.warn(`${tag} EVM clear-sign: certified schema lookup failed (${e?.message || e}) — falling back`)
    return false
  }
  if (!schema) return false
  signingInfo.calldataDecoded = {
    ...(signingInfo.calldataDecoded ?? {
      dappName: 'Unknown', contractName: to, method: schema.method,
      selector: data.slice(0, 10).toLowerCase(), fields: [], source: 'none',
    }),
    // Same encoding as a Pioneer blob: base64, decoded to bytes by the sign handler.
    signedInsightBlob: Buffer.from(schema.signedPayload.replace(/^0x/i, ''), 'hex').toString('base64'),
    insightKeyId: schema.keyId,
  }
  console.log(`${tag} EVM clear-sign: certified schema "${schema.method}" attached (keyId=0x${schema.keyId.toString(16)}, chain ${chainId}, to ${to})`)
  return true
}

/** msg.value as the request carries it (hex, decimal, number); undefined if unreadable. */
function txValue(raw: unknown): bigint | undefined {
  if (raw == null || raw === '') return 0n
  const s = String(raw).trim()
  if (s === '0x') return 0n
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) return undefined
  return BigInt(s)
}

/**
 * Attach a certified 0x07 Uniswap swap entry when `to` is a reviewed Universal
 * Router on 7.16+ and the calldata pre-checks as a shape the device decodes
 * (<= UR_MAX_CALLDATA bytes, supported command sequence) whose every named token is
 * reviewed. The device refuses an incomplete entry with no fallback, so
 * anything short of that returns false (the AdvancedMode path).
 */
export async function attachCertifiedUniswapSwap(
  signingInfo: SigningRequestInfo,
  chainId: number | undefined,
  to: string,
  data: string,
  firmwareVersion: string | undefined,
  tag = '[REST]',
): Promise<boolean> {
  if (!supportsCertifiedClearSign(firmwareVersion) || !chainId || !findReviewedUniversalRouter(chainId, to)) return false
  const value = txValue(signingInfo.value)
  const plan = value === undefined ? null : urPrecheck(to, data, value)
  if (!plan) {
    console.log(`${tag} Uniswap clear-sign: calldata is not a shape the device decodes — not attaching`)
    return false
  }
  let entry
  try {
    entry = await findCertifiedUniswapSwap(chainId, to, plan.selector, plan.tokens)
  } catch (e: any) {
    console.warn(`${tag} Uniswap clear-sign: certified swap lookup failed (${e?.message || e}) — falling back`)
    return false
  }
  if (!entry) return false
  signingInfo.calldataDecoded = {
    ...(signingInfo.calldataDecoded ?? {
      dappName: 'Uniswap', contractName: to, method: entry.method,
      selector: plan.selector, fields: [], source: 'none',
    }),
    signedInsightBlob: Buffer.from(entry.signedPayload.replace(/^0x/i, ''), 'hex').toString('base64'),
    insightKeyId: entry.keyId,
  }
  console.log(`${tag} Uniswap clear-sign: certified swap entry attached (keyId=0x${entry.keyId.toString(16)}, chain ${chainId}, tokens ${plan.tokens.join(',')})`)
  return true
}

/**
 * Decode calldata for the overlay and set deviceClearSigns / needsBlindSigning.
 * `callerMetadata` is a runtime-signer blob a REST caller supplied directly.
 */
export async function applyEvmTxPreview(
  signingInfo: SigningRequestInfo,
  to: string | undefined,
  data: string | undefined,
  chainId: number | undefined,
  firmwareVersion: string | undefined,
  callerMetadata?: { signedPayload?: string; keyId?: number },
  tag = '[REST]',
): Promise<void> {
  if (!data || data.length < 10 || !to) return
  try {
    signingInfo.calldataDecoded = await decodeCalldata(to, data, chainId) ?? undefined
  } catch (e) { console.warn(`${tag} Calldata decode failed:`, e) }
  signingInfo.deviceClearSigns = firmwareClearSigns(to, data, chainId)

  if (callerMetadata?.signedPayload) {
    // Runtime-signer blob from the caller: the REST sign handler honours it at
    // priority 1 and the device verifies it against the loaded signer.
    signingInfo.calldataDecoded = {
      dappName: 'Unknown', contractName: 'Unknown', method: '(runtime signer)',
      selector: data.slice(0, 10), fields: [], source: 'none',
      ...signingInfo.calldataDecoded,
      signedInsightBlob: callerMetadata.signedPayload,
      insightKeyId: callerMetadata.keyId,
    }
    signingInfo.needsBlindSigning = false
    console.log(`${tag} needsBlindSigning=false (caller-provided runtime-signer blob, keyId=${callerMetadata.keyId})`)
  } else if (signingInfo.deviceClearSigns) {
    // Firmware decodes it natively — no metadata, no AdvancedMode.
    signingInfo.needsBlindSigning = false
  } else if (await attachCertifiedEvmSchema(signingInfo, chainId, to, data, firmwareVersion, tag) ||
             await attachCertifiedUniswapSwap(signingInfo, chainId, to, data, firmwareVersion, tag)) {
    signingInfo.needsBlindSigning = false
  } else {
    // Keyed off the device's own allowlist, NOT whether our decoder recognized
    // the calldata — a contract we can decode (Uniswap/1inch) but the firmware
    // can't still blind-signs (PR #261/#303).
    signingInfo.needsBlindSigning = true
  }
  console.log(`${tag} needsBlindSigning=${signingInfo.needsBlindSigning} (firmwareClearSigns=${signingInfo.deviceClearSigns}, decoder source=${signingInfo.calldataDecoded?.source})`)
}

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const sameFields = (fields: unknown, expected: [string, string][]) =>
  Array.isArray(fields) && fields.length === expected.length &&
  expected.every(([name, type], i) => fields[i]?.name === name && fields[i]?.type === type)

/**
 * True when the 7.16+ device reviews this typed-data document natively: a
 * canonical Permit2 PermitSingle (firmware eip712_stream.c permit2_domain_ok +
 * permit2_type_ok). Everything else stays hash-signed and AdvancedMode-gated.
 */
export function typedDataNativelyReviewed(typedData: any, firmwareVersion: string | undefined): boolean {
  if (!supportsCertifiedClearSign(firmwareVersion)) return false
  if (typedData?.primaryType !== 'PermitSingle') return false
  const domain = typedData.domain || {}
  const domainKeys = Object.keys(domain).filter((k) => domain[k] !== undefined).sort().join(',')
  if (domainKeys !== 'chainId,name,verifyingContract') return false
  if (domain.name !== 'Permit2' || String(domain.verifyingContract).toLowerCase() !== PERMIT2) return false
  const types = typedData.types || {}
  if (types.EIP712Domain !== undefined && !sameFields(types.EIP712Domain,
    [['name', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address']])) return false
  return sameFields(types.PermitSingle, [['details', 'PermitDetails'], ['spender', 'address'], ['sigDeadline', 'uint256']]) &&
    sameFields(types.PermitDetails, [['token', 'address'], ['amount', 'uint160'], ['expiration', 'uint48'], ['nonce', 'uint48']])
}
