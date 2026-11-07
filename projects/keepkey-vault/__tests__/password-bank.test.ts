import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto'
import { HDKey } from '@scure/bip32'
import { PasswordBank, PASSWORD_BANK_FLAG, PASSWORD_BANK_SETTING } from '../src/bun/password-bank'
import { passwordOrigin } from '../src/shared/password-bank'

function fixture() {
  const db = new Map<string, string>()
  let now = 1_000_000, seed = 'test seed', session = 'session1', calls = 0
  const deps = {
    read: (key: string) => db.get(key) || null,
    write: (key: string, value: string) => { db.set(key, value) },
    now: () => now,
    device: () => ({ session, cipher: async (path: number[], label: string) => {
      calls++
      return new Uint8Array(createHmac('sha256', seed).update(JSON.stringify(path)).update(label).digest())
    } }),
  }
  const bank = new PasswordBank(deps)
  return { db, deps, bank, calls: () => calls, advance: (ms: number) => { now += ms }, seed: (s: string) => { seed = s }, session: (s: string) => { session = s } }
}
async function assigned(f = fixture()) {
  f.bank.setEnabled(true)
  await f.bank.unlock(true)
  await f.bank.generate(3, 5)
  const state = f.bank.assign('accounts.google.com', 'person@example.com', 90)
  return { ...f, id: state.profiles[0].id }
}

describe('password bank release gates', () => {
  test('frozen v1 public-seed vector matches firmware-compatible CKV and host formatting', async () => {
    const f = fixture()
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const seed = pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512')
    const bank = new PasswordBank({ ...f.deps, device: () => ({ session: 'vector', cipher: async (path, label) => {
      expect(path).toEqual([0x80002720, 0x8000000b, 0x80000001, 0x80000007])
      expect(label).toBe('KeepKey Password Bank v1 00000000000000000000000000000001 slot 7')
      const node = HDKey.fromMasterSeed(new Uint8Array(seed)).derive("m/10016'/11'/1'/7'")
      const key = createHmac('sha512', node.privateKey!).update(label + 'E1D1').digest().subarray(0, 32)
      const cipher = createCipheriv('aes-256-cbc', new Uint8Array(key), new Uint8Array(16)); cipher.setAutoPadding(false)
      const raw = Buffer.concat([new Uint8Array(cipher.update(new Uint8Array(32))), new Uint8Array(cipher.final())])
      expect(raw.toString('hex')).toBe('f175ad6c34511e75dda60261f56eb57a6bf72384d793e014c62f880530692175')
      return new Uint8Array(raw)
    } }) })
    bank.setEnabled(true)
    const digest = await (bank as any).derive('00000000000000000000000000000001', 7)
    expect(digest.toString('base64url').slice(0, 24)).toBe('mtzY2TVqtboJQbQv9lwjlIrT')
  })
  test('defaults off and every secret operation fails without contacting hardware', async () => {
    const f = fixture()
    expect(f.bank.view().enabled).toBe(false)
    await expect(f.bank.unlock(true)).rejects.toThrow('disabled')
    await expect(f.bank.generate(1, 5)).rejects.toThrow('disabled')
    expect(() => f.bank.reveal('x')).toThrow('disabled')
    expect(() => f.bank.exportBackup()).toThrow('disabled')
    expect(f.calls()).toBe(0)
    expect(f.db.has(PASSWORD_BANK_SETTING)).toBe(false)
  })
  test('feature changes apply immediately and clear secrets without restart', async () => {
    const f = await assigned()
    expect(f.bank.reveal(f.id).password).toHaveLength(24)
    f.bank.setEnabled(false)
    expect(f.bank.view().unlocked).toBe(false)
    expect(() => f.bank.reveal(f.id)).toThrow('disabled')
    f.bank.setEnabled(true)
    expect(f.bank.view().exists).toBe(true)
    expect(f.bank.view().unlocked).toBe(false)
    expect(f.db.get(PASSWORD_BANK_FLAG)).toBe('1')
  })
  test('metadata and passwords are absent from persistent plaintext', async () => {
    const f = await assigned()
    const stored = f.db.get(PASSWORD_BANK_SETTING)!
    expect(stored).not.toContain('person@example.com')
    expect(stored).not.toContain('accounts.google.com')
    expect(stored).not.toContain(f.bank.reveal(f.id).password)
    expect(JSON.parse(stored).format).toBe('keepkey-password-bank')
  })
  test('replacement device and encrypted manifest reproduce the exact same password', async () => {
    const f = await assigned()
    const password = f.bank.reveal(f.id).password
    const backup = f.bank.exportBackup()
    const replacement = fixture()
    replacement.bank.setEnabled(true)
    const restored = await replacement.bank.unlock(false, backup.json)
    expect(restored.profiles[0].account).toBe('person@example.com')
    expect(restored.profiles[0].cachedUntil).toBeUndefined()
    await replacement.bank.rehydrate(f.id, false, 5)
    expect(replacement.bank.reveal(f.id).password).toBe(password)
  })
  test('wrong seed cannot open a backup and does not replace local data', async () => {
    const f = await assigned()
    const other = fixture(); other.bank.setEnabled(true); other.seed('wrong seed')
    await expect(other.bank.unlock(false, f.bank.exportBackup().json)).rejects.toThrow('same seed')
    expect(other.db.has(PASSWORD_BANK_SETTING)).toBe(false)
    expect(other.bank.view().unlocked).toBe(false)
  })
  test('tampered authenticated backup is rejected', async () => {
    const f = await assigned(), b = JSON.parse(f.bank.exportBackup().json)
    const bytes = Buffer.from(b.ciphertext, 'base64'); bytes[0] ^= 1; b.ciphertext = bytes.toString('base64')
    const other = fixture(); other.bank.setEnabled(true)
    await expect(other.bank.unlock(false, JSON.stringify(b))).rejects.toThrow('damage')
    expect(other.bank.view().exists).toBe(false)
  })
  test('TTL evicts cached secrets; rehydration preserves the website password and slot', async () => {
    const f = await assigned(), old = f.bank.reveal(f.id).password
    f.advance(5 * 60000)
    expect(() => f.bank.reveal(f.id)).toThrow('expired')
    expect(f.bank.view().profiles[0].slot).toBe(0)
    await f.bank.rehydrate(f.id, false, 5)
    expect(f.bank.reveal(f.id).password).toBe(old)
  })
  test('session timeout and wallet switch both lock metadata and cache', async () => {
    const f = await assigned()
    f.session('different wallet')
    expect(f.bank.view().unlocked).toBe(false)
    f.session('session1'); await f.bank.unlock()
    f.advance(15 * 60000)
    expect(f.bank.view().unlocked).toBe(false)
  })
  test('rotation requires saved pending locations and explicit verification', async () => {
    const f = await assigned(), old = f.bank.reveal(f.id).password
    f.bank.rotate(f.id, 'prepare', false)
    const staged = f.bank.reveal(f.id, true).password
    expect(staged).not.toBe(old)
    expect(() => f.bank.rotate(f.id, 'submitted', false)).toThrow('backup')
    const b = f.bank.exportBackup(); f.bank.acknowledgeBackup(b.revision)
    f.bank.rotate(f.id, 'submitted', false)
    expect(() => f.bank.rotate(f.id, 'cancel', false)).toThrow('reconciled')
    expect(() => f.bank.rotate(f.id, 'verify', false)).toThrow('Confirm')
    expect(f.bank.reveal(f.id).password).toBe(old)
    f.bank.rotate(f.id, 'verify', true)
    expect(f.bank.reveal(f.id).password).toBe(staged)
    expect(f.bank.view().profiles[0].rotationState).toBe('active')
    expect(f.bank.view().backupRequired).toBe(true)
  })
  test('a backup made before submission preserves both locations after total app loss', async () => {
    const f = await assigned()
    f.bank.rotate(f.id, 'prepare', false)
    const old = f.bank.reveal(f.id).password, pending = f.bank.reveal(f.id, true).password
    const backup = f.bank.exportBackup()
    const other = fixture(); other.bank.setEnabled(true); await other.bank.unlock(false, backup.json)
    await other.bank.rehydrate(f.id, false, 5); await other.bank.rehydrate(f.id, true, 5)
    expect(other.bank.reveal(f.id).password).toBe(old)
    expect(other.bank.reveal(f.id, true).password).toBe(pending)
  })
  test('new assignment invalidates acknowledgment and retired slots are not reused', async () => {
    const f = await assigned()
    const b = f.bank.exportBackup()
    f.bank.assign('github.com', 'other', 30)
    expect(() => f.bank.acknowledgeBackup(b.revision)).toThrow('changed')
    f.bank.rotate(f.id, 'prepare', false)
    f.bank.rotate(f.id, 'cancel', false)
    expect(f.bank.view().readySlots).toHaveLength(0)
    await f.bank.generate(1, 5)
    expect(f.bank.view().readySlots[0].slot).toBe(3)
  })
  test('existing banks cannot be overwritten through create or import', async () => {
    const f = await assigned(), backup = f.bank.exportBackup()
    await expect(f.bank.unlock(true)).rejects.toThrow('already exists')
    await expect(f.bank.unlock(false, backup.json)).rejects.toThrow('already exists')
    expect(f.bank.view().exists).toBe(true)
  })
  test('in-flight device result is discarded if feature toggles off and back on', async () => {
    const f = await assigned()
    let finish!: (bytes: Uint8Array) => void
    const deps = { ...f.deps, device: () => ({ session: 'session1', cipher: () => new Promise<Uint8Array>(resolve => { finish = resolve }) }) }
    const bank = new PasswordBank(deps)
    const pending = bank.unlock()
    bank.setEnabled(false); bank.setEnabled(true)
    finish(new Uint8Array(32))
    await expect(pending).rejects.toThrow('changed')
    expect(bank.view().unlocked).toBe(false)
  })
  test('rejects oversized batches, invalid TTLs and duplicate accounts', async () => {
    const f = await assigned()
    await expect(f.bank.generate(9, 5)).rejects.toThrow('1 and 8')
    await expect(f.bank.generate(1, 0)).rejects.toThrow('duration')
    expect(() => f.bank.assign('accounts.google.com', 'person@example.com', 90)).toThrow('already tracked')
  })
  test('failed persistence never acknowledges a feature change', () => {
    const f = fixture(), bank = new PasswordBank({ ...f.deps, write: () => {} })
    expect(() => bank.setEnabled(true)).toThrow('save')
    expect(bank.enabled).toBe(false)
  })
  test('another app instance cannot overwrite an already allocated slot range', async () => {
    const f = await assigned()
    const second = new PasswordBank(f.deps)
    await second.unlock()
    // Opening in another process rewraps the metadata. The first session must
    // observe that changed envelope before allocating or revealing anything.
    await expect(f.bank.generate(1, 5)).rejects.toThrow('another window')
    expect(f.bank.view().unlocked).toBe(false)
    await second.generate(1, 5)
    expect(second.view().readySlots.map(s => s.slot)).toEqual([1, 2, 3])
  })
  test('origin matching is exact and rejects credentials and paths', () => {
    expect(passwordOrigin('ACCOUNTS.GOOGLE.COM')).toBe('https://accounts.google.com')
    for (const origin of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/password', 'https://example.com?next=evil', 'https://example.com:1234', 'localhost']) expect(() => passwordOrigin(origin)).toThrow()
  })
})
