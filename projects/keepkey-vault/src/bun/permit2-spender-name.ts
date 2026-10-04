import { CERTIFIED_METADATA_KEY_ID, findEvmNameRecord, isCertifiedEvmMetadata } from './evm-certified-schema'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'

export interface Permit2NameMetadata {
  signedPayload: string
  keyId: number
}

/** The canonical Permit2 PermitSingle's chain and spender, else undefined. */
export function permit2Spender(typedData: any): { chainId: number; spender: string } | undefined {
  const domain = typedData?.domain
  if (typedData?.primaryType !== 'PermitSingle') return undefined
  if (String(domain?.verifyingContract || '').toLowerCase() !== PERMIT2) return undefined
  const chainId = Number(domain?.chainId)
  const spender = String(typedData?.message?.spender || '')
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(spender)) return undefined
  return { chainId, spender }
}

/**
 * A KeepKey-certified name record for a Permit2 spender (7.16+). The device
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
  const record = target && findEvmNameRecord(target.chainId, target.spender)
  if (!target || !record) return undefined
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
