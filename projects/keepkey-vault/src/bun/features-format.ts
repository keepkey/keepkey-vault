/**
 * Convert raw hdwallet features (camelCase) to keepkey-desktop REST format (snake_case).
 * Matches the types.Features schema from keepkey-sdk-server swagger spec.
 */
export function formatFeatures(f: any): any {
  const decodeB64 = (x: any): string | undefined => {
    if (x === undefined || x === null) return undefined
    if (x instanceof Uint8Array || Buffer.isBuffer(x)) return Buffer.from(x).toString('hex')
    if (typeof x === 'string') {
      if (/^[0-9a-fA-F]+$/.test(x)) return x.toLowerCase()
      return Buffer.from(x, 'base64').toString('hex')
    }
    return undefined
  }

  return {
    vendor: f.vendor,
    major_version: f.majorVersion,
    minor_version: f.minorVersion,
    patch_version: f.patchVersion,
    bootloader_mode: f.bootloaderMode ?? false,
    device_id: f.deviceId,
    pin_protection: f.pinProtection,
    passphrase_protection: f.passphraseProtection,
    language: f.language,
    label: f.label,
    initialized: f.initialized,
    revision: decodeB64(f.revision),
    bootloader_hash: decodeB64(f.bootloaderHash),
    imported: f.imported,
    pin_cached: f.pinCached,
    passphrase_cached: f.passphraseCached,
    policies: Array.isArray(f.policiesList) ? f.policiesList.map((p: any) => ({
      policy_name: p.policyName ?? p.policy_name,
      enabled: p.enabled,
    })) : f.policies,
    model: f.model,
    firmware_variant: f.firmwareVariant,
    firmware_hash: decodeB64(f.firmwareHash),
    supports_taproot: f.supportsTaproot === true,
    no_backup: f.noBackup,
    wipe_code_protection: f.wipeCodeProtection,
    auto_lock_delay_ms: f.autoLockDelayMs,
    // Features.capabilities (7.15+). Read-only; the same list the engine keeps
    // in getDeviceState().capabilities for the ClearSign gates.
    capabilities: Array.isArray(f.capabilitiesList) ? [...f.capabilitiesList] : undefined,
  }
}
