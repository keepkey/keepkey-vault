/** Public recovery data stored beside a KeepKey-protected volume image. */
export interface VolumeKeyRecord {
  version: 1
  id: string
}

// The firmware displays this literal header and the cipher key below it.
export const VOLUME_APPROVAL_TITLE = 'Encrypt Key Value'

export function volumeCipherKey(record: VolumeKeyRecord): string {
  return `KeepKey Volume v1 ${record.id}`
}

export function makeVolumeKeyRecord(): VolumeKeyRecord {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return { version: 1, id: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') }
}

export function parseVolumeKeyRecord(value: unknown): VolumeKeyRecord {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
      !('id' in value) || typeof value.id !== 'string' || value.id.length !== 32 || !/^[0-9a-f]+$/.test(value.id)) {
    throw new Error('Invalid or unsupported volume recovery record.')
  }
  return { version: 1, id: value.id }
}
