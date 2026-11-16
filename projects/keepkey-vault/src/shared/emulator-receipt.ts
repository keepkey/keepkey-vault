import emulatorManifest from '../../emulator-bundle/manifest.json'

export const EMULATOR_RECEIPT_FILENAME = 'nu7-emulator-receipt.json'
export interface SignedEmulatorReceipt {
  schemaVersion: 1
  version: '7.17.0'
  filename: string
  certifiedSourceSha256: string
  signedSha256: string
}

export function certifiedEmulatorSourceSha256(filename: string): string | null {
  if (emulatorManifest.version !== '7.17.0') return null
  if (filename !== 'libkkemu.dylib' && filename !== 'libkkemu.dll') return null
  return emulatorManifest.files[filename].sha256
}

/** A receipt links signed bytes to the source pinned into this app, never to
 * a source identity supplied by a caller or an adjacent user library. */
export function reviewedEmulatorReceiptSource(receipt: unknown, filename: string, actualSha256: string): string | null {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null
  const value = receipt as Record<string, unknown>
  const source = certifiedEmulatorSourceSha256(filename)
  if (!source || value.schemaVersion !== 1 || value.version !== '7.17.0' || value.filename !== filename
    || value.certifiedSourceSha256 !== source || typeof value.signedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.signedSha256) || value.signedSha256 !== actualSha256) return null
  const fields = ['schemaVersion', 'version', 'filename', 'certifiedSourceSha256', 'signedSha256']
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) return null
  return source
}
