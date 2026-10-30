/**
 * EVM signing-overlay verdict shared by the REST and WalletConnect paths.
 *
 * Owner policy, predicted exactly as the device enforces it:
 *   needsAdvancedMode = !(firmwareNativelyDecodes || (fw >= 7.16 && certifiedPayloadAttached))
 * Runtime/provider metadata is annotation only and never relaxes the verdict.
 */
import type { CalldataDecodedField, SafeCallPreview, SigningRequestInfo } from '../shared/types'
import { decodeCalldata, firmwareClearSigns, formatDeadline } from './calldata-decoder'
import { findCertifiedEvmSchema, findCertifiedUniswapSwap } from './evm-schema-registry'
import { findEvmNameRecord, findReviewedUniversalRouter, reviewedSwapToken } from './evm-certified-schema'
import { evmContractIdentity } from '../shared/evm-contract-identity'
import { knownSpenderName } from '../shared/evm-known-spenders'
import { urPrecheck } from './uniswap-ur'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import { certifiedBodyRefused, certifiedEnvelopeShown, metadataPayloadBytes } from '../shared/certified-evm-envelope'
import { fetchErc7730CalldataDefinition, resolveErc7730ForCall } from './erc7730-resolver'
import { describeErc7730Call } from './erc7730-describe'
import { safeTxCalls } from '../shared/safe-tx'

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
  // The same rule as the swap gate: a body this firmware refuses is never attached.
  if (certifiedBodyRefused(schema.signedPayload, firmwareVersion)) {
    console.log(`${tag} EVM clear-sign: certified "${schema.method}" is a dynamic schema this firmware (${firmwareVersion}) refuses — not attached`)
    return false
  }
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

/**
 * Attach a KeepKey ClearSign service ERC-7730 definition for this exact call,
 * when the call is still blind (nothing else describes it) and the device takes
 * one. The sign handler sends exactly signingInfo.erc7730, so the card, the
 * gate (evmCallRequiresAdvancedMode) and the device agree. Returns true when
 * one was attached.
 */
export async function attachErc7730Definition(
  signingInfo: SigningRequestInfo,
  to: string | undefined,
  data: string | undefined,
  firmwareVersion: string | undefined,
  capabilities: readonly number[] | undefined,
  tag = '[REST]',
): Promise<boolean> {
  if (!signingInfo.needsBlindSigning || signingInfo.deviceClearSigns || signingInfo.calldataDecoded?.signedInsightBlob) return false
  const catalog = await resolveErc7730ForCall({
    chainId: signingInfo.chainId, to, data, value: signingInfo.value, firmwareVersion, capabilities,
  })
  if (!catalog) return false
  signingInfo.erc7730 = catalog
  signingInfo.needsBlindSigning = false
  const description = describeErc7730Call(catalog.definitions[0].envelope, {
    chainId: signingInfo.chainId as number, to: to!, data: data!, value: signingInfo.value, from: signingInfo.from,
  })
  if (description) signingInfo.erc7730Description = description
  console.log(`${tag} EVM clear-sign: ERC-7730 definition ${catalog.primaryDefinitionId.slice(0, 18)}… attached (chain ${signingInfo.chainId}, to ${to})`)
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
 * The swap a reviewed Universal Router call makes, as card rows: the same
 * decode and token-flow review the device runs (urPrecheck), so a call it
 * would not decode gets no rows, and a call it reviews gets the facts its
 * screens state (signed_metadata_build_ur_review): what is paid, the minimum
 * received, the recipient, the fee, the Permit2 allowance and every V4 pool
 * hook. Token names come only from reviewedSwapToken by chain:address; any
 * other token is shown as raw units of its address with a "Token warning".
 * Advice checked on this computer (D-018): it never sets or relaxes a gate.
 * `firmwareVersion` picks the device's decoder (urRules; unknown = 7.16).
 */
export function uniswapSwapFields(
  chainId: number | undefined, router: string, data: string, value: unknown, from?: string, firmwareVersion?: string,
): CalldataDecodedField[] {
  const v = txValue(value)
  if (!chainId || v === undefined || !findReviewedUniversalRouter(chainId, router)) return []
  const plan = urPrecheck(router, data, v, firmwareVersion)
  if (!plan) return []
  const s = plan.summary
  const unknown: string[] = []
  const amount = (raw: bigint, token: string, isEth: boolean, unlimitedAt?: bigint) => {
    const t = isEth ? { symbol: 'ETH', decimals: 18 } : reviewedSwapToken(chainId, token)
    if (!t) { unknown.push(token); return `${raw} base units of token ${token}` }
    // The device's ur_amount_text: a permit's all-ones uint160 reads UNLIMITED.
    if (raw === unlimitedAt) return `UNLIMITED ${t.symbol}`
    const scale = 10n ** BigInt(t.decimals)
    const frac = (raw % scale).toString().padStart(t.decimals, '0').replace(/0+$/, '')
    return `${raw / scale}${frac ? `.${frac}` : ''} ${t.symbol}`
  }
  const amountIn = amount(s.amountIn, s.tokenIn, s.inIsEth)
  const amountOut = amount(s.amountOut, s.tokenOut, s.outIsEth)
  const self = s.recipientIsSender || (!!from && s.recipient === from.toLowerCase())
  const recipient = s.recipientIsSender ? 'the signing account' : `${s.recipient}${self ? ' (the signing account)' : ''}`
  const row = (name: string, val: string): CalldataDecodedField => ({ name, type: 'string', value: val, format: 'raw' })
  const rows = [
    row('Action', s.exactIn
      ? `Swap ${amountIn} for at least ${amountOut}${self ? '' : ` to ${s.recipient}`}`
      : `Swap at most ${amountIn} for ${amountOut}${self ? '' : ` to ${s.recipient}`}`),
    row(s.exactIn ? 'You pay' : 'You pay at most', amountIn),
    // Exact-out delivers exactly this, so it is also the minimum (the
    // "no minimum" risk rule reads this row).
    row('Minimum output', amountOut),
    row('Recipient', recipient),
  ]
  if (s.fee?.amount !== undefined) {
    // 7.17: the app's exact-output fee, a fixed amount of the output token.
    rows.push(row('Fee', `${amount(s.fee.amount, s.tokenOut, false)} to ${s.fee.recipient}`))
  } else if (s.fee) {
    const pct = `${Math.floor(s.fee.bips / 100)}.${String(s.fee.bips % 100).padStart(2, '0')}%`
    rows.push(row('Fee', `${pct} of the output to ${s.fee.recipient}`))
  }
  if (s.permit) rows.push(row('Permit2 allowance', `${amount(s.permit.amount, s.permit.token, false, (1n << 160n) - 1n)} for the router, until ${formatDeadline(s.permit.expiration.toString())}`))
  // Uniswap v4 pools whose hook contract runs during the swap: every one, as
  // the device shows them. The limits above hold whatever a hook does.
  s.hooks.forEach((hook, i) => rows.push(row(s.hooks.length > 1 ? `Pool hook ${i + 1}/${s.hooks.length}` : 'Pool hook', `The swap runs this hook contract ${hook}`)))
  for (const t of [...new Set(unknown)]) rows.push(row('Token warning', `Token ${t} is not on KeepKey's reviewed list`))
  rows.push(row('Preview', 'Checked on this computer. Your KeepKey screen is the final word.'))
  return rows
}

/**
 * Attach a certified 0x07 Uniswap swap entry when `to` is a reviewed Universal
 * Router on 7.16+ and the calldata pre-checks as a call this firmware decodes
 * and reviews (urPrecheck: any length; V4 only through UR 2.1.2 on Base on
 * 7.16, through every V4_ROUTERS router on 7.17) whose every named token is
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
  const plan = value === undefined ? null : urPrecheck(to, data, value, firmwareVersion)
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
/** A spender KeepKey has reviewed: canonical Permit2, an address with a
 * certified name record (the same list the device names spenders from), or a
 * swap/bridge contract on Desktop's own list (advice only, evm-known-spenders). */
export function recognizedSpender(chainId: number | undefined, address: string | undefined): string | undefined {
  if (!chainId || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined
  const identity = evmContractIdentity(chainId, address)
  return identity === 'Uniswap Permit2' ? identity : findEvmNameRecord(chainId, address)?.name ?? knownSpenderName(chainId, address)
}

/** The reviewed spender of a decoded permit, for both REST and WalletConnect. */
export function recognizedTypedDataSpender(decoded: SigningRequestInfo['typedDataDecoded'], chainId: number | undefined): string | undefined {
  const spender = decoded?.fields.find((x) => x.label === 'Spender')?.raw
  return recognizedSpender(chainId, typeof spender === 'string' ? spender : undefined)
}

/**
 * Safe requests: each call the SafeTx makes (one, or each MultiSend entry)
 * gets the preview a call from an account gets: the local calldata decode,
 * the reviewed spender or recipient, and, when nothing else describes it, a
 * KeepKey ClearSign service definition checked here. Advice for the approval
 * card only; nothing here is sent to the KeepKey, which shows SafeTx.data as hex.
 */
export async function attachSafeCallPreviews(info: SigningRequestInfo, fetchImpl: typeof fetch = fetch): Promise<void> {
  const d = info.typedDataDecoded
  if (d?.primaryType !== 'SafeTx') return
  const raw = (label: string) => String(d.fields.find((x) => x.label === label)?.raw ?? '')
  const chainId = normalizeEvmChainId(d.domain.chainId ?? info.chainId)
  const safe = String(d.domain.verifyingContract ?? '').toLowerCase()
  const to = raw('To').toLowerCase()
  const data = /^(0x)?$/.test(raw('Data')) ? '0x' : raw('Data').toLowerCase()
  if (!chainId || !/^0x[0-9a-f]{40}$/.test(to) || !/^0x([0-9a-f]{2})*$/.test(data) || !/^[01]$/.test(raw('Operation'))) return
  let value: bigint
  try { value = BigInt(raw('Value') || '0') } catch { return }
  const calls = safeTxCalls(chainId, to, Number(raw('Operation')), value, data)
  if (!calls) return
  info.safeCalls = await Promise.all(calls.map(async (c): Promise<SafeCallPreview> => {
    if (c.operation !== 0 || c.to === safe || c.data.length < 10) return {}
    const callValue = c.value.toString()
    let calldataDecoded = await decodeCalldata(c.to, c.data, chainId, callValue).catch(() => null) ?? undefined
    const swapRows = uniswapSwapFields(chainId, c.to, c.data, callValue, safe, info.firmwareVersion)
    if (swapRows.length > 0 && calldataDecoded) calldataDecoded = { ...calldataDecoded, fields: [...swapRows, ...calldataDecoded.fields] }
    const selector = c.data.slice(0, 10)
    const arg0 = /^0{24}[0-9a-f]{40}$/.test(c.data.slice(10, 74)) ? `0x${c.data.slice(34, 74)}` : undefined
    const tokenCall = ['0x095ea7b3', '0x39509351', '0xa22cb465', '0xa9059cbb'].includes(selector)
    const catalog = tokenCall || calldataDecoded?.source === 'local'
      ? undefined : await fetchErc7730CalldataDefinition(chainId, c.to, c.data, fetchImpl)
    return {
      calldataDecoded,
      recognizedSpender: selector === '0x095ea7b3' || selector === '0x39509351' ? recognizedSpender(chainId, arg0) : undefined,
      recognizedRecipient: selector === '0xa9059cbb' ? recognizedSpender(chainId, arg0) : undefined,
      erc7730Description: catalog && describeErc7730Call(catalog.definitions[0].envelope, { chainId, to: c.to, data: c.data, value: callValue, from: safe }),
    }
  }))
}

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
    signingInfo.calldataDecoded = await decodeCalldata(to, data, chainId, signingInfo.value) ?? undefined
  } catch (e) { console.warn(`${tag} Calldata decode failed:`, e) }
  const swapRows = uniswapSwapFields(chainId, to, data, signingInfo.value, signingInfo.from, firmwareVersion)
  if (swapRows.length > 0 && signingInfo.calldataDecoded) {
    signingInfo.calldataDecoded.fields = [...swapRows, ...signingInfo.calldataDecoded.fields]
  }
  signingInfo.deviceClearSigns = firmwareClearSigns(to, data, chainId, firmwareVersion, signingInfo.value)
  // approve / increaseAllowance: is the spender one KeepKey has reviewed?
  const selector = data.slice(0, 10).toLowerCase()
  if ((selector === '0x095ea7b3' || selector === '0x39509351') && /^0{24}[0-9a-fA-F]{40}$/.test(data.slice(10, 74))) {
    signingInfo.recognizedSpender = recognizedSpender(chainId, `0x${data.slice(34, 74)}`)
  }
  // transfer straight to a reviewed contract: the risk bar flags it.
  if (selector === '0xa9059cbb' && /^0{24}[0-9a-fA-F]{40}$/.test(data.slice(10, 74))) {
    signingInfo.recognizedRecipient = recognizedSpender(chainId, `0x${data.slice(34, 74)}`)
  }

  if (callerMetadata?.signedPayload) {
    // A blob from the caller: the REST sign handler sends it at priority 1.
    // It relaxes the gate only as a KeepKey-certified envelope this firmware
    // shows for this exact call (the device refuses a forged one outright).
    // A runtime-signer blob is annotation only: the device still shows the
    // raw data and needs AdvancedMode, so the gate stays as without it.
    signingInfo.calldataDecoded = {
      dappName: 'Unknown', contractName: 'Unknown', method: '(runtime signer)',
      selector: data.slice(0, 10), fields: [], source: 'none',
      ...signingInfo.calldataDecoded,
      signedInsightBlob: callerMetadata.signedPayload,
      insightKeyId: callerMetadata.keyId,
      insightSource: 'caller',
    }
    const certified = certifiedEnvelopeShown(
      metadataPayloadBytes(callerMetadata.signedPayload), callerMetadata.keyId, firmwareVersion, { chainId, to, data },
    )
    signingInfo.needsBlindSigning = !certified && !signingInfo.deviceClearSigns
    console.log(`${tag} needsBlindSigning=${signingInfo.needsBlindSigning} (caller-provided blob, keyId=${callerMetadata.keyId}, certified envelope shown=${certified})`)
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
