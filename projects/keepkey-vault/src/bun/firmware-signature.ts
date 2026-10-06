import { createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

/**
 * KeepKey's firmware signing keys, as the bootloader holds them
 * (keepkey-firmware include/keepkey/board/pubkeys.h, identical on upstream
 * keepkey/keepkey-firmware master, checked 2026-10-05). Index i is sigindex i+1.
 */
const FIRMWARE_SIGNING_KEYS = [
  '04a33cec36d6d011af09e0c498d17c3ba7ab907abfbb64caba16ad9077caacd3e198a32362c32d0ef0a7269259abbbcd8a688a0c8f54a6dbc405459566cd65141d',
  '04ab291f6bd33d0e3974f27e50070be933695a0fab7b8b3654e7c9dce74f7f98fd739b1ed86eb0be26f026e4dc6519fd2884955fa174f8a783fe455ac43f944c70',
  '04a9c29f4e053b35ffd3b9a37b073188b624c07c3a92622c131edf1a2b2c712216a8c06c9ddfdcaa39b81d9a86f0459480b0277eab0e30a34f1d26b326b8995a33',
  '04f228448eaf05171ccb68a04a0724ac586b846c54c5fd0a526f9d7c3396c98dd47aef6b2faf47b54ffa8c2861c54920ce6c2aa5607c496869023724db285495c6',
  '0418a90b536e9ffb0ec320293c33754af89b145475c4d921f818e2062c92b01be526047ccfa042b4711fb5603fe6bd7980693100b71ee766d86116a3694873f314',
]

const hexBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)))

/**
 * True only when a KPKY image carries three valid signatures from KeepKey's
 * release keys, checked the way the bootloader does (signatures.c
 * signatures_ok): three distinct indexes 1-5, each a secp256k1 signature over
 * SHA-256 of the code_len bytes after the 256-byte header. Filled signature
 * slots alone (e.g. a test-key-signed build) are not a signature.
 */
export function verifyFirmwareSignatures(data: Uint8Array): boolean {
  // "KPKY"
  if (data.length < 256 || data[0] !== 0x4b || data[1] !== 0x50 || data[2] !== 0x4b || data[3] !== 0x59) return false
  const codeLen = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true)
  if (codeLen === 0 || 256 + codeLen > data.length) return false
  const indexes = [data[8], data[9], data[10]]
  if (indexes.some((i) => i < 1 || i > FIRMWARE_SIGNING_KEYS.length) || new Set(indexes).size !== 3) return false
  const digest = new Uint8Array(createHash('sha256').update(data.subarray(256, 256 + codeLen)).digest())
  return indexes.every((index, slot) => {
    try {
      const signature = data.subarray(64 + 64 * slot, 128 + 64 * slot)
      return secp256k1.verify(signature, digest, hexBytes(FIRMWARE_SIGNING_KEYS[index - 1]), { prehash: false, lowS: false })
    } catch {
      return false
    }
  })
}
