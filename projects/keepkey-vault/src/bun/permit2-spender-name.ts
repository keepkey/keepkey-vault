import { CERTIFIED_METADATA_KEY_ID, findEvmNameRecord, findReviewedUniversalRouter, isCertifiedEvmMetadata, reviewedSwapTokens, UR_SELECTORS } from './evm-certified-schema'
import { findCertifiedUniswapSwap } from './evm-schema-registry'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

export interface Permit2NameMetadata {
  signedPayload: string
  keyId: number
}

/** The canonical Permit2 PermitSingle's chain, spender and token, else undefined. */
export function permit2Spender(typedData: any): { chainId: number; spender: string; token?: string } | undefined {
  const domain = typedData?.domain
  if (typedData?.primaryType !== 'PermitSingle') return undefined
  if (String(domain?.verifyingContract || '').toLowerCase() !== PERMIT2) return undefined
  const chainId = Number(domain?.chainId)
  const spender = String(typedData?.message?.spender || '')
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(spender)) return undefined
  const token = String(typedData?.message?.details?.token || '')
  return /^0x[0-9a-fA-F]{40}$/.test(token) ? { chainId, spender, token } : { chainId, spender }
}

/**
 * The certified 0x07 Uniswap decoder entry for a PermitSingle whose spender is
 * a reviewed Universal Router and whose token is reviewed on that chain (today
 * Base and Arbitrum). Firmware (7.16, F-D) names the permit's token from the
 * entry's token list and the spender by the entry's title. The device holds
 * one record at a time, so this replaces the spender's 0x06 name. Only the
 * router and the token address leave the host, as for a swap. A 7.16 test
 * build without F-D (firmware #949) reads only 0x06 records here: it shows the
 * spender's full address as "Not identified" and still signs (no capability
 * flag tells the two apart).
 */
async function permit2RouterEntry(target: { chainId: number; spender: string; token?: string }): Promise<Permit2NameMetadata | undefined> {
  if (!target.token || !findReviewedUniversalRouter(target.chainId, target.spender) || !reviewedSwapTokens(target.chainId, [target.token])) return undefined
  try {
    const entry = await findCertifiedUniswapSwap(target.chainId, target.spender, UR_SELECTORS[0], [target.token])
    return entry ? { signedPayload: entry.signedPayload, keyId: entry.keyId } : undefined
  } catch (error: any) {
    console.warn(`[permit2] no certified token entry for ${target.token} on chain ${target.chainId}: ${error?.message || error}`)
    return undefined
  }
}

/**
 * KeepKey-certified metadata for a Permit2 PermitSingle (7.16+): the router's
 * 0x07 entry naming the permit's token when there is one, else the spender's
 * 0x06 name record. The device
 * shows it beside the full spender address, which it shows either way. The
 * name is optional: on any failure the device says "Not identified", so this
 * never blocks signing. Only addresses already in the reviewed catalog are
 * looked up, so no dapp-chosen address leaves the host.
 */
export async function permit2SpenderNameMetadata(
  typedData: any,
  firmwareVersion: string | undefined,
): Promise<Permit2NameMetadata | undefined> {
  if (!supportsCertifiedClearSign(firmwareVersion)) return undefined
  const target = permit2Spender(typedData)
  if (!target) return undefined
  const routerEntry = await permit2RouterEntry(target)
  if (routerEntry) return routerEntry
  const record = findEvmNameRecord(target.chainId, target.spender)
  if (!record) return undefined
  const base = String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL).trim().replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/v1/evm/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: record.chainId, address: record.address }),
      signal: AbortSignal.timeout(3_000),
    })
    const result: any = await response.json()
    const metadata = { signedPayload: result?.signedPayload, keyId: result?.keyId }
    if (
      !response.ok ||
      result?.classification !== 'VERIFIED' ||
      result?.chainId !== record.chainId ||
      String(result?.address || '').toLowerCase() !== record.address ||
      result?.keyId !== CERTIFIED_METADATA_KEY_ID ||
      !isCertifiedEvmMetadata(metadata)
    ) {
      console.warn(`[permit2] no certified name for ${record.address} on chain ${record.chainId}: ${result?.error || response.status}`)
      return undefined
    }
    return metadata
  } catch (error: any) {
    console.warn(`[permit2] ClearSign name lookup failed: ${error?.message || error}`)
    return undefined
  }
}

/** Typed-data sign params with the spender's certified name, when there is one. */
export async function withPermit2SpenderName<T extends { typedData: any }>(
  params: T,
  firmwareVersion: string | undefined,
): Promise<T & { txMetadata?: Permit2NameMetadata }> {
  const txMetadata = await permit2SpenderNameMetadata(params.typedData, firmwareVersion)
  return txMetadata ? { ...params, txMetadata } : params
}
