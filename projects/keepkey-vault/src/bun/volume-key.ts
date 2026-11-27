import { createHash } from 'node:crypto'
import { isBitcoinOnlyVariant } from '../shared/flags'
import { parseVolumeKeyRecord, volumeCipherKey, type VolumeKeyRecord } from '../shared/volume-key'
import { confirmedDeviceCipher, type CipherWallet } from './password-device'

interface VolumeDevice {
  state: string
  firmwareVariant?: string
  isEmulator: boolean
  isCurrent: () => boolean
}

/** V1 recovery inputs are immutable. Never include a device ID, host path, or display name.
 * The native disk-image operation owns the returned ASCII buffer and wipes it after use. */
export async function deriveVolumePassword(record: VolumeKeyRecord, wallet: CipherWallet | null | undefined,
  device: VolumeDevice): Promise<Buffer> {
  const keyLabel = volumeCipherKey(parseVolumeKeyRecord(record))
  if (!wallet || device.state !== 'ready' || device.isEmulator || typeof wallet.cipherKeyValue !== 'function') {
    throw new Error('Connect and unlock a physical KeepKey to use this volume.')
  }
  if (isBitcoinOnlyVariant(device.firmwareVariant)) throw new Error('Volume derivation requires multi-chain firmware.')
  const checkSession = () => {
    if (!device.isCurrent()) throw new Error('The KeepKey session changed. Try again.')
  }
  checkSession()
  // m/10016'/12'/1'. E1/D1, zero plaintext, zero IV, and the exact label are part of the recipe.
  const reply = await confirmedDeviceCipher(wallet, [0x80002720, 0x8000000c, 0x80000001], keyLabel)
  if (typeof reply === 'string' && !/^[A-Za-z0-9+/]{43}=$/.test(reply)) throw new Error('Invalid volume key response.')
  const raw = typeof reply === 'string' ? Buffer.from(reply, 'base64') : reply
  try {
    checkSession()
    if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('Invalid volume key response.')
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const digest = createHash('sha256').update('keepkey-volume/v1/password').update(bytes).digest()
    // Encode directly into mutable ASCII memory for hdiutil stdin.
    const hex = '0123456789abcdef'
    const password = Buffer.alloc(digest.length * 2)
    for (let i = 0; i < digest.length; i++) {
      password[i * 2] = hex.charCodeAt(digest[i] >>> 4)
      password[i * 2 + 1] = hex.charCodeAt(digest[i] & 15)
    }
    digest.fill(0)
    return password
  } finally {
    if (raw instanceof Uint8Array) raw.fill(0)
  }
}
