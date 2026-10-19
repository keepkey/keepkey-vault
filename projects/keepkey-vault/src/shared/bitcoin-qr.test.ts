import { Buffer } from 'buffer'
import { describe, test, expect } from 'bun:test'
import { BitcoinQrDecoder, bitcoinQrFrames, encodeBase43, decodeBase43, MAX_QR_BYTES } from './bitcoin-qr'
import { base32nopad, hex } from '@scure/base'
import { deflateSync } from 'fflate'
import { UR, UREncoder } from '@ngraveio/bc-ur'
import Bytewords from '@ngraveio/bc-ur/dist/bytewords'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { generateQRSvg } from '../mainview/lib/qr'

const psbt = Uint8Array.from([112, 115, 98, 116, 255, ...Array.from({ length: 2300 }, (_, i) => i % 251)])
const finish = (frames: string[]) => {
  const decoder = new BitcoinQrDecoder()
  let result
  for (const frame of frames) result = decoder.receive(frame).result ?? result
  return result!
}
describe('Bitcoin QR transport', () => {
  for (const format of ['ur', 'bbqr', 'electrum'] as const) {
    test(`${format}: lossless shuffled frames and duplicates`, () => {
      const bytes = format === 'electrum' ? psbt.slice(0,1500) : psbt
      const frames = bitcoinQrFrames(bytes, format).reverse()
      expect(finish(frames.flatMap(f => [f, f])).bytes).toEqual(bytes)
    })
  }
  test('missing fragments stay incomplete; a fresh decoder resets state', () => {
    for (const format of ['ur', 'bbqr'] as const) {
      const frames = bitcoinQrFrames(psbt, format)
      const decoder = new BitcoinQrDecoder()
      expect(decoder.receive(frames[0]).result).toBeUndefined()
      expect(decoder.receive(frames[0]).result).toBeUndefined()
      expect(finish(frames).bytes).toEqual(psbt)
    }
  })
  test('UR mixed fountain frames reconstruct when initial frames were missed', () => {
    const header = Uint8Array.from([0x59, psbt.length >> 8, psbt.length & 255])
    const encoder = new UREncoder(new UR(Buffer.from([...header, ...psbt]), 'crypto-psbt'), 150)
    const decoder = new BitcoinQrDecoder()
    for (let i = 0; i < 500; i++) {
      const frame = encoder.nextPart()
      if (i < 30) continue
      const result = decoder.receive(frame).result
      if (result) { expect(result.bytes).toEqual(psbt); return }
    }
    throw new Error('Fountain decode failed')
  })
  test('accepts modern psbt UR type too', () => {
    const ur = new UR(Buffer.from([0x45,112,115,98,116,255]), 'psbt')
    expect(finish(new UREncoder(ur).encodeWhole()).kind).toBe('psbt')
  })
  test('raw transaction and public wallet transports', () => {
    const tx = Uint8Array.from([2,0,0,0,...new Array(100).fill(7)])
    const wallet = new TextEncoder().encode('{"format":"keepkey-public-wallet"}')
    for (const format of ['ur', 'bbqr'] as const) {
      expect(finish(bitcoinQrFrames(tx, format)).kind).toBe('transaction')
      expect(finish(bitcoinQrFrames(wallet, format)).bytes).toEqual(wallet)
    }
    expect(finish([encodeBase43(tx)]).bytes).toEqual(tx)
    expect(finish([hex.encode(tx)]).bytes).toEqual(tx)
  })
  test('base43 preserves leading zeros and rejects unsupported characters', () => {
    for (const bytes of [new Uint8Array([0]), new Uint8Array([0,0,1,255]), psbt]) expect(decodeBase43(encodeBase43(bytes))).toEqual(bytes)
    expect(() => decodeBase43('!')).toThrow()
    expect(() => bitcoinQrFrames(new Uint8Array(MAX_QR_BYTES + 1), 'ur')).toThrow()
    expect(() => bitcoinQrFrames(psbt, 'electrum')).toThrow('Too large')
  })
  test('BBQr hex and compressed base32 imports', () => {
    for (const [encoding, body] of [['H', hex.encode(psbt).toUpperCase()], ['Z', base32nopad.encode(deflateSync(psbt))]]) {
      expect(finish([`B$${encoding}P0100${body}`]).bytes).toEqual(psbt)
    }
  })
  test('rejects conflicting sequences, wrong type, oversize frames and decompression bombs', () => {
    const frames = bitcoinQrFrames(psbt, 'bbqr')
    const decoder = new BitcoinQrDecoder()
    decoder.receive(frames[0])
    expect(() => decoder.receive(frames[0].slice(0,-1) + (frames[0].endsWith('A') ? 'B' : 'A'))).toThrow('Conflicting duplicate')
    expect(() => new BitcoinQrDecoder().receive(`B$2T0100${base32nopad.encode(psbt)}`)).toThrow('type')
    expect(() => new BitcoinQrDecoder().receive('A'.repeat(8193))).toThrow('too large')
    const bomb = deflateSync(new Uint8Array(MAX_QR_BYTES + 1))
    expect(() => new BitcoinQrDecoder().receive(`B$ZP0100${base32nopad.encode(bomb)}`)).toThrow('exceeds')
    const ur = bitcoinQrFrames(psbt, 'ur')
    const other = bitcoinQrFrames(Uint8Array.from([...psbt, 1]), 'ur')
    const mixed = new BitcoinQrDecoder()
    mixed.receive(ur[0])
    expect(() => mixed.receive(other[1])).toThrow('different transaction')
    expect(() => mixed.receive(frames[0])).toThrow('Different QR format')
    expect(() => new BitcoinQrDecoder().receive(ur[0].slice(0,-1) + 'z')).toThrow()
  })
  test('rejects hostile fountain CBOR before the general decoder allocates or recurses', () => {
    // Five-field tuples with a 4 GB string declaration, a billion parts, or a nested value.
    for (const cbor of ['85010205005affffffff', '85011affffffff05004100', '858181010205004100']) {
      const body = Bytewords.encode(cbor, Bytewords.STYLES.MINIMAL)
      expect(() => new BitcoinQrDecoder().receive(`ur:crypto-psbt/1-2/${body}`)).toThrow()
    }
  })
  test('actual QR pixels decode with jsQR, including larger versions', () => {
    for (const text of ['bitcoin:bc1qexample', ...bitcoinQrFrames(psbt, 'ur'), ...bitcoinQrFrames(psbt, 'bbqr'), ...bitcoinQrFrames(psbt.slice(0,1500), 'electrum')]) {
      const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
      const scale = 4, size = (modules.size + 8) * scale
      const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
      for (let y=0; y<modules.size; y++) for (let x=0; x<modules.size; x++) if (modules.get(y,x)) {
        for (let dy=0; dy<scale; dy++) for (let dx=0; dx<scale; dx++) {
          const offset = (((y+4)*scale+dy)*size+(x+4)*scale+dx)*4
          pixels[offset] = pixels[offset+1] = pixels[offset+2] = 0
        }
      }
      expect(jsQR(pixels,size,size)?.data).toBe(text)
      expect(generateQRSvg(text)).toContain(`viewBox="0 0 ${modules.size+8} ${modules.size+8}"`)
    }
  })
})
