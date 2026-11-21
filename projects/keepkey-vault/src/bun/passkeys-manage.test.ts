import { expect, test } from 'bun:test'
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, randomBytes } from 'node:crypto'
import { cborDecode, frames, type HidLike } from './passkeys'
import { cborEncode, deletePasskey, listPasskeys, setFidoPin } from './passkeys-manage'
import { cleanLabel, resolveLabels, rpHashHex } from './passkey-labels'

const CID = 0x0a0b0c0d
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const aes = (enc: boolean, key: Uint8Array, data: Uint8Array) => { const c = enc ? createCipheriv('aes-256-cbc', key, new Uint8Array(16)) : createDecipheriv('aes-256-cbc', key, new Uint8Array(16)); c.setAutoPadding(false); return Uint8Array.from([...c.update(data), ...c.final()]) }
const mac16 = (key: Uint8Array, ...p: Uint8Array[]) => { const h = createHmac('sha256', key); p.forEach(x => h.update(x)); return new Uint8Array(h.digest().subarray(0, 16)) }

interface Slot { rpHash: Uint8Array; userId: Uint8Array; userName: string; credentialId: Uint8Array }
/** A KeepKey RC4 stand-in: same PIN protocol 1 and credential-management rules as ctap2.c. */
function authenticator(opts: { pin?: string; slots: Slot[] }) {
  const st = { pin: opts.pin ?? null as string | null, retries: 8, slots: [...opts.slots], token: null as Uint8Array | null, ecdh: null as ReturnType<typeof createECDH> | null, deleted: [] as string[] }
  const out: number[][] = []
  let rx: { cmd: number; want: number; data: number[] } | null = null
  const reply = (cmd: number, data: number[]) => out.push(...frames(CID, cmd, data))
  const ok = (m?: unknown) => reply(0x90, [0, ...(m ? cborEncode(m) : [])])
  const err = (c: number) => reply(0x90, [c])
  const pinHash = (p: string) => new Uint8Array(createHash('sha256').update(p).digest().subarray(0, 16))
  const secretFor = (cose: Map<number, Uint8Array>) => {
    const ecdh = st.ecdh!; st.ecdh = null
    return new Uint8Array(createHash('sha256').update(new Uint8Array(ecdh.computeSecret(Uint8Array.from([4, ...cose.get(-2)!, ...cose.get(-3)!])))).digest())
  }
  const cbor = (payload: number[]) => {
    const cmd = payload[0]; const req = payload.length > 1 ? cborDecode(Uint8Array.from(payload.slice(1))) as Map<number, any> : new Map()
    if (cmd === 0x06) {
      const sub = req.get(2)
      if (sub === 1) return ok(new Map([[3, st.retries]]))
      if (sub === 2) { st.ecdh = createECDH('prime256v1'); st.ecdh.generateKeys(); const pub = st.ecdh.getPublicKey(); return ok(new Map([[1, new Map<number, unknown>([[1, 2], [3, -25], [-1, 1], [-2, new Uint8Array(pub.subarray(1, 33))], [-3, new Uint8Array(pub.subarray(33, 65))]])]])) }
      if (sub === 3) {
        const secret = secretFor(req.get(3)); const enc = req.get(5) as Uint8Array
        if (Buffer.compare(mac16(secret, enc), req.get(4)) !== 0) return err(0x33)
        const plain = aes(false, secret, enc); let n = plain.indexOf(0); if (n < 0) n = 64
        if (n < 4) return err(0x37)
        st.pin = Buffer.from(plain.subarray(0, n)).toString(); return ok()
      }
      if (sub === 9) {
        const secret = secretFor(req.get(3))
        if (!st.pin) return err(0x35)
        const given = aes(false, secret, req.get(6))
        if (Buffer.compare(given, pinHash(st.pin)) !== 0) { st.retries--; return err(0x31) }
        st.retries = 8; st.token = new Uint8Array(randomBytes(32)); return ok(new Map([[2, aes(true, secret, st.token)]]))
      }
      return err(0x02)
    }
    if (cmd === 0x0a) {
      const sub = req.get(1)
      if (sub !== 3 && sub !== 5) {
        const params = req.get(2) as Map<number, unknown> | undefined
        const bytes = params ? Uint8Array.from(cborEncode(params)) : new Uint8Array(0)
        if (!st.token || Buffer.compare(mac16(st.token, Uint8Array.from([sub]), bytes), req.get(4)) !== 0) return err(0x33)
      }
      const rps = [...new Map(st.slots.map(s => [Buffer.from(s.rpHash).toString('hex'), s.rpHash]))].map(([, v]) => v)
      if (sub === 1) return ok(new Map([[1, st.slots.length], [2, 4 - st.slots.length]]))
      if (sub === 2) return ok(new Map<number, unknown>([[3, new Map()], [4, rps[0]], [5, rps.length]]))
      if (sub === 3) { cursor = 1; return ok(new Map<number, unknown>([[3, new Map()], [4, rps[cursor++ - 0]]])) }
      if (sub === 4) {
        current = st.slots.filter(s => Buffer.compare(s.rpHash, req.get(2).get(1)) === 0); idx = 0
        return ok(entry(current[0], current.length))
      }
      if (sub === 5) return ok(entry(current[++idx]))
      if (sub === 6) {
        const id = Buffer.from(req.get(2).get(2).get('id')).toString('hex')
        if (!st.slots.some(s => Buffer.from(s.credentialId).toString('hex') === id)) return err(0x2e)
        reply(0xbb, [2]) // keepalive: waiting for the hold
        st.slots = st.slots.filter(s => Buffer.from(s.credentialId).toString('hex') !== id); st.deleted.push(id); return ok()
      }
    }
    err(0x01)
  }
  let cursor = 0, idx = 0, current: Slot[] = []
  const entry = (s: Slot, total?: number) => { const m = new Map<number, unknown>([[6, new Map<string, unknown>([['id', s.userId], ['name', s.userName]])], [7, new Map<string, unknown>([['id', s.credentialId], ['type', 'public-key']])], [8, new Map()]]); if (total) m.set(9, total); return m }
  const hid: HidLike = {
    write(d) {
      const p = d.slice(1)
      if (p[4] === 0x86) { out.push(...frames(0xffffffff, 0x86, [...p.slice(7, 15), ...u32(CID), 2, 7, 17, 0, 5])); return d.length }
      if (p[4] & 0x80) { const want = (p[5] << 8) | p[6]; rx = { cmd: p[4], want, data: p.slice(7, 7 + want) } } else if (rx) rx.data.push(...p.slice(5, 5 + rx.want - rx.data.length))
      if (rx && rx.data.length >= rx.want) { const payload = rx.data; rx = null; cbor(payload) }
      return d.length
    },
    readTimeout() { return out.shift() ?? [] },
    close() {},
  }
  return { hid, st }
}
const slot = (rp: string, name: string, n: number): Slot => ({ rpHash: new Uint8Array(Buffer.from(rpHashHex(rp), 'hex')), userId: Uint8Array.from([n]), userName: name, credentialId: new Uint8Array(64).fill(n) })

test('list: right PIN returns capacity and every slot, including two accounts on one site', async () => {
  const { hid } = authenticator({ pin: '1234', slots: [slot('github.com', 'ann', 1), slot('github.com', 'bob', 2), slot('google.com', 'ann@x.com', 3)] })
  const inv = await listPasskeys(hid, '1234')
  expect(inv.used).toBe(3); expect(inv.remaining).toBe(1)
  expect(inv.slots.map(s => s.userName).sort()).toEqual(['ann', 'ann@x.com', 'bob'])
  expect(inv.slots.find(s => s.userName === 'bob')!.rpHash).toBe(rpHashHex('github.com'))
})

test('list: wrong PIN is a typed error with the retries left, never a listing', async () => {
  const { hid, st } = authenticator({ pin: '1234', slots: [slot('github.com', 'ann', 1)] })
  await expect(listPasskeys(hid, '0000')).rejects.toMatchObject({ code: 'pin_invalid', retries: 7 })
  expect(st.retries).toBe(7)
})

test('list: empty device and no PIN set', async () => {
  expect(await listPasskeys(authenticator({ pin: '1234', slots: [] }).hid, '1234')).toEqual({ used: 0, remaining: 4, slots: [] })
  await expect(listPasskeys(authenticator({ slots: [] }).hid, '1234')).rejects.toMatchObject({ code: 'pin_not_set' })
})

test('delete: removes exactly the chosen credential, waits through the hold keepalive', async () => {
  const { hid, st } = authenticator({ pin: '1234', slots: [slot('github.com', 'ann', 1), slot('google.com', 'ann@x.com', 3)] })
  let waited = 0
  await deletePasskey(hid, '1234', Buffer.alloc(64, 1).toString('hex'), () => waited++)
  expect(waited).toBe(1)
  expect(st.slots.map(s => s.userName)).toEqual(['ann@x.com'])
})

test('delete: wrong PIN deletes nothing; unknown credential is reported; bad id rejected before the device', async () => {
  const { hid, st } = authenticator({ pin: '1234', slots: [slot('github.com', 'ann', 1)] })
  await expect(deletePasskey(hid, '9999', Buffer.alloc(64, 1).toString('hex'))).rejects.toMatchObject({ code: 'pin_invalid' })
  expect(st.slots.length).toBe(1)
  await expect(deletePasskey(hid, '1234', Buffer.alloc(64, 7).toString('hex'))).rejects.toMatchObject({ code: 'no_credential' })
  await expect(deletePasskey(hid, '1234', 'zz')).rejects.toMatchObject({ code: 'protocol' })
})

test('set PIN: stores it, then the same PIN lists; a short PIN is refused before the device', async () => {
  const { hid, st } = authenticator({ slots: [] })
  await setFidoPin(hid, 'hunter22')
  expect(st.pin).toBe('hunter22')
  expect((await listPasskeys(hid, 'hunter22')).used).toBe(0)
  await expect(setFidoPin(authenticator({ slots: [] }).hid, 'abc')).rejects.toMatchObject({ code: 'pin_policy' })
})

test('labels: your name wins, known domains match by hash, everything else stays unknown', () => {
  const g = rpHashHex('github.com'), z = rpHashHex('my-bank.example'), w = rpHashHex('webauthn.io')
  const r = resolveLabels([g, z, w], { [w]: '  Test site  ' })
  expect(r[g]).toEqual({ label: 'github.com', source: 'known' })
  expect(r[z]).toEqual({ label: '', source: 'unknown' })
  expect(r[w]).toEqual({ label: 'Test site', source: 'you' })
  expect(resolveLabels([z], {}, ['my-bank.example'])[z].label).toBe('my-bank.example')
  expect(cleanLabel('a\nb\u0000c' + 'x'.repeat(80))).toHaveLength(40)
})
