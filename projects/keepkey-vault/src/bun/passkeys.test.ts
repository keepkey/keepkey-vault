import { expect, test } from 'bun:test'
import { cborDecode, frames, readStatus, runReset, PasskeyError, type HidLike } from './passkeys'

const CID = 0x01020304
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const pkt = (cid: number, cmd: number, data: number[]) => frames(cid, cmd, data)

/** Fake authenticator: answers INIT, then maps each CBOR request to a scripted reply. */
function fake(replies: Record<number, number[][][]>): HidLike & { sent: number[][] } {
  const out: number[][] = []; const sent: number[][] = []
  return {
    sent,
    write(d) {
      const p = d.slice(1); sent.push(p)
      if (p[4] === 0x86) out.push(...pkt(0xffffffff, 0x86, [...p.slice(7, 15), ...u32(CID), 2, 7, 17, 0, 5]))
      else if (p[4] === 0x90 && p[7] !== undefined) for (const msg of replies[p[7]] ?? []) out.push(...msg)
      return d.length
    },
    readTimeout() { return out.shift() ?? [] },
    close() {},
  }
}

// GetInfo: {1:["FIDO_2_0","U2F_V2"], 3:<16B aaguid>, 4:{rk:true, up:true, clientPin:false}}
const text = (s: string) => [0x60 + s.length, ...Buffer.from(s)]
const getInfo = [0x00, 0xa3, 0x01, 0x82, ...text('FIDO_2_0'), ...text('U2F_V2'), 0x03, 0x50, ...Array.from({ length: 16 }, (_, i) => i), 0x04, 0xa3, ...text('rk'), 0xf5, ...text('up'), 0xf5, ...text('clientPin'), 0xf4]

test('cbor reader decodes ints, text, bytes, maps, arrays, bools', () => {
  const m = cborDecode(Uint8Array.from(getInfo.slice(1))) as Map<number, any>
  expect(m.get(1)).toEqual(['FIDO_2_0', 'U2F_V2'])
  expect(m.get(4).get('rk')).toBe(true)
  expect(m.get(4).get('clientPin')).toBe(false)
  expect(cborDecode(Uint8Array.from([0x38, 0x26]))).toBe(-39)
})

test('frames split a payload into init + continuation packets of 64 bytes', () => {
  const f = frames(CID, 0x90, Array.from({ length: 100 }, (_, i) => i))
  expect(f.length).toBe(2); expect(f.every(p => p.length === 64)).toBe(true)
  expect(f[0].slice(4, 7)).toEqual([0x90, 0, 100]); expect(f[1][4]).toBe(0)
})

test('readStatus reads GetInfo and PIN retries; the device version comes from INIT', async () => {
  const hid = fake({ 0x04: [pkt(CID, 0x90, getInfo)], 0x06: [pkt(CID, 0x90, [0x00, 0xa1, 0x03, 0x08])] })
  const s = await readStatus(hid)
  expect(s).toMatchObject({ available: true, deviceVersion: '7.17.0', discoverable: true, pinSet: false, pinRetries: 8, ctapVersions: ['FIDO_2_0', 'U2F_V2'] })
  expect(s.aaguid).toBe('000102030405060708090a0b0c0d0e0f')
})

test('reset: waits through keepalives, resolves on status 0, and sends exactly authenticatorReset', async () => {
  const hid = fake({ 0x07: [pkt(CID, 0xbb, [2]), pkt(CID, 0x90, [0x00])] })
  let waiting = 0
  expect(await runReset(hid, () => waiting++)).toEqual({ reset: true })
  expect(waiting).toBe(1)
  const cbor = hid.sent.filter(p => p[4] === 0x90); expect(cbor.length).toBe(1)
  expect(cbor[0].slice(5, 8)).toEqual([0, 1, 0x07])
})

test('reset: declined or timed-out on the device is a typed error, never success', async () => {
  await expect(runReset(fake({ 0x07: [pkt(CID, 0x90, [0x27])] }))).rejects.toMatchObject({ code: 'denied' })
  await expect(runReset(fake({ 0x07: [pkt(CID, 0x90, [0x2f])] }))).rejects.toMatchObject({ code: 'timeout' })
  await expect(runReset(fake({ 0x07: [pkt(CID, 0x90, [0x01])] }))).rejects.toBeInstanceOf(PasskeyError)
})
