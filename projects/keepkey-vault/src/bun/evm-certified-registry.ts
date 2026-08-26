import { DEFAULT_CLEARSIGN_SERVICE_URL } from './solana-certified-registry'

export interface CertifiedEvmEnvelope {
  method: string
  signedPayload: string
  keyId: number
  fingerprint: string
}

function normalizedCalldata(data: string): string | undefined {
  const value = String(data || '').replace(/^0x/i, '')
  if (value.length < 8 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined
  return value
}

/**
 * Fetch a reviewed static/dynamic schema by transaction shape.  Argument
 * values never leave Vault: the service receives only chain, contract,
 * selector and byte length.  The response is untrusted until the KeepKey
 * verifies both signatures and decodes the actual transaction itself.
 */
export async function findCertifiedEvmEnvelope(
  chainId: number | undefined,
  contract: string | undefined,
  data: string | undefined,
): Promise<CertifiedEvmEnvelope | undefined> {
  const calldata = normalizedCalldata(String(data || ''))
  if (!chainId || !contract || !calldata || !/^0x[0-9a-f]{40}$/i.test(contract)) return undefined
  const selector = `0x${calldata.slice(0, 8).toLowerCase()}`
  const base = String(process.env.CLEARSIGN_SERVICE_URL || DEFAULT_CLEARSIGN_SERVICE_URL)
    .trim()
    .replace(/\/+$/, '')

  let response: Response
  try {
    response = await fetch(`${base}/v1/evm/schema`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId,
        contract,
        selector,
        calldataLength: calldata.length / 2,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error: any) {
    throw new Error(`ClearSign verification service is unavailable: ${error?.message || 'connection failed'}`)
  }

  let result: any
  try {
    result = await response.json()
  } catch {
    throw new Error(`ClearSign verification service returned HTTP ${response.status} without valid JSON`)
  }
  if (!response.ok) {
    if (response.status === 422) return undefined
    throw new Error(`ClearSign verification service returned HTTP ${response.status}: ${result?.error || 'request failed'}`)
  }

  const payload = String(result?.signedPayload || '').replace(/^0x/i, '')
  if (
    result?.classification !== 'VERIFIED' ||
    result?.keyId !== 0x80 ||
    Number(result?.chainId) !== chainId ||
    String(result?.contract || '').toLowerCase() !== contract.toLowerCase() ||
    String(result?.selector || '').toLowerCase() !== selector ||
    payload.length <= 280 || payload.slice(0, 2).toLowerCase() !== '03' ||
    payload.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(payload)
  ) {
    throw new Error('ClearSign verification service returned an invalid certified EVM envelope')
  }
  return {
    method: String(result.method || 'Reviewed contract call'),
    signedPayload: `0x${payload}`,
    keyId: result.keyId,
    fingerprint: String(result.fingerprint || ''),
  }
}
