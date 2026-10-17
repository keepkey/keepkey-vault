/**
 * The Studio provider key, held in memory for one Studio session only.
 *
 * Owner rule (2026-10-16): the third-party provider private key is NEVER
 * written to disk. The operator re-enters the BIP-85 words the device shows,
 * the key is derived here, used to sign, and zeroed when the session ends
 * (Studio closes, a new key is derived, AdvancedMode is found off, the device
 * it was derived with is unplugged or swapped, or the app quits).
 * Every entry point requires AdvancedMode, like the rest of Studio.
 *
 * JS cannot zero strings or bigints the libraries make internally; we zero
 * every buffer we own, which is the best this runtime allows.
 */
import { deriveProviderKey, validateProviderCeremony, type ProviderKey } from '../shared/clearsign-provider-key'
import { buildStudioEvmSchema, signEvmBody } from './clearsign-studio-evm'
import type { ClearSignEvmSchemaDraft, ClearSignEvmSignedEntry } from '../shared/types'

export interface ProviderKeyIdentity {
  alias: string
  publicKeyHex: string
  fingerprint: string
}

export function createProviderKeySession(
  requireAdvancedMode: () => void,
  derive: (mnemonic: string) => ProviderKey = deriveProviderKey,
  /** The connected device's id: the key belongs to the device it was derived with. */
  deviceId: () => string | undefined = () => undefined,
) {
  let current: (ProviderKeyIdentity & { privateKey: Uint8Array; deviceId?: string }) | null = null

  const clear = (): boolean => {
    if (!current) return false
    current.privateKey.fill(0)
    current = null
    return true
  }

  const gate = () => {
    try {
      requireAdvancedMode()
    } catch (cause) {
      clear()
      throw cause
    }
    if (current && current.deviceId !== deviceId()) clear()
  }

  return {
    clear,

    /** AdvancedMode check for every Studio handler: a failure (or another
     * device) also ends the session. */
    requireAdvancedMode: gate,

    /** The engine's device state: an unplugged or different device ends the session. */
    onDeviceState(state: { state?: unknown; deviceId?: unknown }): boolean {
      if (!current) return false
      return state?.state === 'disconnected' || (!!state?.deviceId && state.deviceId !== current.deviceId) ? clear() : false
    },

    /** A policy change on the device: AdvancedMode off ends the Studio session
     * (the device drops its session signers at the same time). Every path that
     * applies a policy (RPC applyPolicy, REST /system/apply-policies) calls it. */
    onPolicy(policy: { policyName?: unknown; enabled?: unknown }): boolean {
      return policy?.policyName === 'AdvancedMode' && policy.enabled !== true ? clear() : false
    },

    /** Derive from the device's BIP-85 words; returns only the public half. */
    derive(params: { childMnemonic: string; alias: string; wordCount: number; index: number }): ProviderKeyIdentity {
      gate()
      // Every attempt ends the previous key, even one that fails validation:
      // the Studio card already shows "not derived" once any input changes.
      clear()
      const alias = String(params.alias || '').trim()
      if (!alias || alias.length > 31 || !/^[A-Za-z0-9 _-]+$/.test(alias)) {
        throw new Error('Alias must be 1-31 letters, digits, spaces, hyphens, or underscores')
      }
      const mnemonic = validateProviderCeremony(params)
      const key = derive(mnemonic)
      current = { alias, publicKeyHex: key.publicKeyHex, fingerprint: key.fingerprint, privateKey: key.privateKey, deviceId: deviceId() }
      return { alias, publicKeyHex: key.publicKeyHex, fingerprint: key.fingerprint }
    },

    /** Sign a v0x02 description built host-side from the draft, never raw renderer bytes. */
    signEvmSchema(draft: ClearSignEvmSchemaDraft, keyId: number): ClearSignEvmSignedEntry & ProviderKeyIdentity {
      gate()
      if (!current) throw new Error('Derive the provider key from the device words first; it is kept only for this Studio session')
      const artifact = buildStudioEvmSchema(draft, keyId)
      const signedPayload = signEvmBody(Uint8Array.from(Buffer.from(artifact.body, 'hex')), current.privateKey)
      const { alias, publicKeyHex, fingerprint } = current
      return { keyId, signedPayload, draft: artifact.draft, alias, publicKeyHex, fingerprint }
    },
  }
}
