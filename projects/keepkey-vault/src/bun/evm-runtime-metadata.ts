import { createHash } from 'node:crypto'
import { versionCompare } from '../shared/firmware-versions'
import type { SigningRequestInfo } from '../shared/types'

export interface RuntimeEvmSigner {
  keyId: number
  alias: string
  publicKeyHex: string
  /** First 4 bytes of sha256(pubkey), lowercase: the provider wire format. */
  fingerprint: string
  /** First 8 bytes of sha256(pubkey), uppercase: what 7.16 shows on screen. */
  deviceFingerprint: string
}

export interface RuntimeEvmMetadata {
  signedPayload: string
  keyId: number
  signer: RuntimeEvmSigner
}

/** Each provider request gets this long; a slower provider means no description. */
export const RUNTIME_PROVIDER_TIMEOUT_MS = 5_000

/** RAM-signer reports remain available on certified-capable firmware. The
 * certified catalog has priority, but it cannot be the reason an otherwise
 * reviewable unknown transaction loses its explicitly user-trusted fallback. */
export function supportsRuntimeEvmMetadata(firmwareVersion: string | undefined, advancedMode: boolean): boolean {
  return advancedMode && !!firmwareVersion && versionCompare(firmwareVersion, '7.15.0') >= 0
}

/** The signer fingerprint as the device shows it on the trust and Identity
 * screens: sha256 of the compressed key, first 8 bytes, uppercase hex
 * (signed_metadata_pubkey_fingerprint, METADATA_FINGERPRINT_LEN 17). */
export function deviceFingerprint(publicKeyHex: string): string {
  const key = publicKeyHex.replace(/^0x/i, '')
  return createHash('sha256').update(Uint8Array.from(Buffer.from(key, 'hex'))).digest('hex').slice(0, 16).toUpperCase()
}

/** A provider decline or outage is "no description", never a failed
 * signature: one warning naming the provider and the reason. */
function noDescription(provider: string, reason: string): undefined {
  console.warn(`[clearsign] runtime provider ${provider}: ${reason}; signing with no description`)
  return undefined
}

/** Resolve transaction-bound metadata for the 7.15 RAM signer path. This is
 * deliberately opt-in: production builds do not contact localhost or load a
 * trust key unless CLEARSIGN_RUNTIME_URL names the provider service.
 *
 * Every failure returns undefined (the device then shows the call as it would
 * with no provider): a decline (422), any other non-ok status, a network
 * error or timeout, and an answer whose signer identity, slot or payload is
 * malformed. None of these can make the device sign under a misleading name:
 * the device names only a key the user trusted on its own screen, and a
 * malformed answer is never sent to it. */
export async function resolveRuntimeEvmMetadata(tx: any, timeoutMs = RUNTIME_PROVIDER_TIMEOUT_MS): Promise<RuntimeEvmMetadata | undefined> {
  const configured = String(process.env.CLEARSIGN_RUNTIME_URL || '').trim().replace(/\/+$/, '')
  if (!configured) return undefined

  let signerResponse: Response
  let signResponse: Response
  try {
    [signerResponse, signResponse] = await Promise.all([
      fetch(`${configured}/signer`, { signal: AbortSignal.timeout(timeoutMs) }),
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
        signal: AbortSignal.timeout(timeoutMs),
      }),
    ])
  } catch (e: any) {
    return noDescription(configured, e?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : `unreachable (${e?.message || e})`)
  }
  const signer: any = await signerResponse.json().catch(() => null)
  const signed: any = await signResponse.json().catch(() => null)
  if (signResponse.status === 422) {
    const reason = typeof signed?.error === 'string' && signed.error.length <= 240
      ? signed.error
      : 'transaction is outside the provider coverage policy'
    return noDescription(configured, `declined (${reason})`)
  }
  if (!signerResponse.ok || !signResponse.ok) {
    return noDescription(configured, `unavailable (${signerResponse.status}/${signResponse.status})`)
  }
  const identity = signerIdentity(signer)
  if (typeof identity === 'string') return noDescription(configured, identity)
  if (Number(signed?.keyId) !== identity.keyId) {
    return noDescription(configured, 'returned a non-loadable or mismatched signer slot')
  }
  const payload = String(signed?.signedPayload || '').replace(/^0x/i, '')
  if (!/^[0-9a-f]+$/i.test(payload) || payload.length < 130) return noDescription(configured, 'returned malformed metadata')
  return { signedPayload: `0x${payload}`, keyId: identity.keyId, signer: identity }
}

/** Transaction-bound metadata only from the signer an approval card named:
 * never attach a description under a name the user was not shown. Nothing
 * named, or a different key answering, means no description. */
export async function resolveNamedRuntimeEvmMetadata(
  tx: any, named: { publicKeyHex: string; fingerprint: string } | undefined, timeoutMs = RUNTIME_PROVIDER_TIMEOUT_MS,
): Promise<RuntimeEvmMetadata | undefined> {
  if (!named) return undefined
  const answer = await resolveRuntimeEvmMetadata(tx, timeoutMs)
  if (!answer || answer.signer.publicKeyHex === named.publicKeyHex) return answer
  console.warn(`[clearsign] runtime provider signer changed since approval (${named.fingerprint} → ${answer.signer.deviceFingerprint}); signing with no description`)
  return undefined
}

/** The provider's advertised signer, checked against its own key, or why not. */
function signerIdentity(signer: any): RuntimeEvmSigner | string {
  const publicKeyHex = String(signer?.publicKeyHex || '').replace(/^0x/i, '').toLowerCase()
  if (!/^0[23][0-9a-f]{64}$/.test(publicKeyHex)) return 'signer identity is malformed'
  const shown = deviceFingerprint(publicKeyHex)
  // The provider may advertise the 4-byte wire form or the 8-byte device form.
  const advertised = String(signer?.fingerprint || '').toUpperCase()
  if ((advertised.length !== 8 && advertised.length !== 16) || !shown.startsWith(advertised)) {
    return 'signer identity is malformed (fingerprint does not match its key)'
  }
  const keyId = Number(signer?.keyId)
  if (!Number.isInteger(keyId) || keyId < 1 || keyId > 3) return 'returned a non-loadable or mismatched signer slot'
  return {
    keyId, alias: String(signer.alias || 'ClearSign Provider').slice(0, 31), publicKeyHex,
    fingerprint: shown.slice(0, 8).toLowerCase(), deviceFingerprint: shown,
  }
}

/** The configured provider's signer, for the approval card to name before the
 * user approves (the transaction-bound description is fetched only after). No
 * provider, or one that is down or malformed, gives undefined. */
export async function resolveRuntimeEvmSigner(timeoutMs = RUNTIME_PROVIDER_TIMEOUT_MS): Promise<RuntimeEvmSigner | undefined> {
  const configured = String(process.env.CLEARSIGN_RUNTIME_URL || '').trim().replace(/\/+$/, '')
  if (!configured) return undefined
  let response: Response
  try {
    response = await fetch(`${configured}/signer`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e: any) {
    return noDescription(configured, e?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : `unreachable (${e?.message || e})`)
  }
  if (!response.ok) return noDescription(configured, `unavailable (${response.status})`)
  const identity = signerIdentity(await response.json().catch(() => null))
  return typeof identity === 'string' ? noDescription(configured, identity) : identity
}

/** Whether the REST sign handler will ask the runtime provider for this call:
 * no caller blob, no certified or Pioneer description, and 7.15+ with
 * AdvancedMode on (the same order the handler resolves metadata in). */
export function runtimeProviderWillBeAsked(info: SigningRequestInfo, callerMetadata: unknown): boolean {
  return !(callerMetadata as { signedPayload?: unknown } | undefined)?.signedPayload
    && !info.certifiedEvmSchema && !info.calldataDecoded?.signedInsightBlob
    && supportsRuntimeEvmMetadata(info.firmwareVersion, info.advancedModeEnabled === true)
}

/** Ask the device to trust the provider's signer for this session. A refusal
 * (the user declines the trust screen, or the device refuses the load) means
 * no description: the caller drops the metadata and signs as without a
 * provider, so the device never names a key the user did not trust. */
export async function trustRuntimeSigner(signer: RuntimeEvmSigner, load: () => Promise<unknown>, tag: string): Promise<boolean> {
  try {
    await load()
    return true
  } catch (e: any) {
    console.warn(`${tag} runtime provider signer ${signer.alias} (${signer.deviceFingerprint}) not trusted on the device (${e?.message || e}); signing with no description`)
    return false
  }
}
