/**
 * The Studio provider key, held in memory for one Studio session only.
 *
 * Owner rule (2026-10-16): the third-party provider private key is NEVER
 * written to disk. The operator re-enters the BIP-85 words the device shows,
 * the key is derived here, used to sign, and zeroed when the session ends
 * (Studio closes, a new key is derived, or AdvancedMode is found off).
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
) {
  let current: (ProviderKeyIdentity & { privateKey: Uint8Array }) | null = null

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
  }

  return {
    clear,

    /** Derive from the device's BIP-85 words; returns only the public half. */
    derive(params: { childMnemonic: string; alias: string; wordCount: number; index: number }): ProviderKeyIdentity {
      gate()
      const alias = String(params.alias || '').trim()
      if (!alias || alias.length > 31 || !/^[A-Za-z0-9 _-]+$/.test(alias)) {
        throw new Error('Alias must be 1-31 letters, digits, spaces, hyphens, or underscores')
      }
      const mnemonic = validateProviderCeremony(params)
      clear()
      const key = derive(mnemonic)
      current = { alias, publicKeyHex: key.publicKeyHex, fingerprint: key.fingerprint, privateKey: key.privateKey }
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
