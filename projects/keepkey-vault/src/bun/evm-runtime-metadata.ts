import { createHash } from 'node:crypto'
import { versionCompare } from '../shared/firmware-versions'

export interface RuntimeEvmSigner {
  keyId: number
  alias: string
  publicKeyHex: string
  fingerprint: string
}

export interface RuntimeEvmMetadata {
  signedPayload: string
  keyId: number
  signer: RuntimeEvmSigner
}

/** RAM-signer reports remain available on certified-capable firmware. The
 * certified catalog has priority, but it cannot be the reason an otherwise
 * reviewable unknown transaction loses its explicitly user-trusted fallback. */
export function supportsRuntimeEvmMetadata(firmwareVersion: string | undefined, advancedMode: boolean): boolean {
  return advancedMode && !!firmwareVersion && versionCompare(firmwareVersion, '7.15.0') >= 0
}

/** Resolve transaction-bound metadata for the 7.15 RAM signer path. This is
 * deliberately opt-in: production builds do not contact localhost or load a
 * trust key unless CLEARSIGN_RUNTIME_URL names the provider service. */
export async function resolveRuntimeEvmMetadata(tx: any): Promise<RuntimeEvmMetadata | undefined> {
  const configured = String(process.env.CLEARSIGN_RUNTIME_URL || '').trim().replace(/\/+$/, '')
  if (!configured) return undefined

  const [signerResponse, signResponse] = await Promise.all([
    fetch(`${configured}/signer`, { signal: AbortSignal.timeout(3_000) }),
    fetch(`${configured}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chainId: tx.chainId, nonce: tx.nonce, gasLimit: tx.gasLimit,
        to: tx.to, value: tx.value, data: tx.data,
        ...(tx.gasPrice !== undefined ? { gasPrice: tx.gasPrice } : {}),
        ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: tx.maxFeePerGas } : {}),
        ...(tx.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    }),
  ])
  const signer: any = await signerResponse.json().catch(() => null)
  const signed: any = await signResponse.json().catch(() => null)
  if (signResponse.status === 422) {
    const reason = typeof signed?.error === 'string' && signed.error.length <= 240
      ? signed.error
      : 'transaction is outside the provider coverage policy'
    throw new Error(`7.15 ClearSign provider refused transaction: ${reason}`)
  }
  if (!signerResponse.ok || !signResponse.ok) {
    throw new Error(`7.15 ClearSign provider unavailable (${signerResponse.status}/${signResponse.status})`)
  }
  const publicKeyHex = String(signer?.publicKeyHex || '').replace(/^0x/i, '').toLowerCase()
  const fingerprint = createHash('sha256').update(Uint8Array.from(Buffer.from(publicKeyHex, 'hex'))).digest('hex').slice(0, 8)
  if (!/^0[23][0-9a-f]{64}$/.test(publicKeyHex) || fingerprint !== String(signer?.fingerprint || '').toLowerCase()) {
    throw new Error('7.15 ClearSign provider signer identity is malformed')
  }
  const keyId = Number(signed?.keyId)
  if (!Number.isInteger(keyId) || keyId < 1 || keyId > 3 || keyId !== Number(signer?.keyId)) {
    throw new Error('7.15 ClearSign provider returned a non-loadable or mismatched signer slot')
  }
  const payload = String(signed?.signedPayload || '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(payload) || payload.length < 130) throw new Error('7.15 ClearSign provider returned malformed metadata')
  return {
    signedPayload: `0x${payload}`,
    keyId,
    signer: { keyId, alias: String(signer.alias || 'ClearSign Provider').slice(0, 31), publicKeyHex, fingerprint },
  }
}
