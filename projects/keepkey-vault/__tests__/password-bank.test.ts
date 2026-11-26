import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { HDKey } from '@scure/bip32'
import { DeviceOperationCoordinator, type DeviceOperationSnapshot } from '../src/bun/device-operation'
import { PasswordBank, PASSWORD_BANK_FLAG, PASSWORD_BANK_SETTING, PASSWORD_CACHE_MAX_MINUTES } from '../src/bun/password-bank'
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

function legacyPasswordBackup(rotationState: 'prepared' | 'submitted' = 'prepared') {
  const bankId = '0123456789abcdef0123456789abcdef'
  const id = 'legacy-profile'
  const raw = createHmac('sha256', 'test seed')
    .update(JSON.stringify([0x80002720, 0x8000000b, 0x80000000]))
    .update(`KeepKey Password Bank v1 ${bankId} unlock`)
    .digest()
  const key = createHash('sha256').update('keepkey-password-bank/v1/metadata').update(raw).digest()
  const iv = Buffer.alloc(12)
  const cipher = createCipheriv('aes-256-gcm', new Uint8Array(key), new Uint8Array(iv))
  cipher.setAAD(new TextEncoder().encode(`keepkey-password-bank/1/${bankId}`))
  const plaintext = JSON.stringify({
    version: 1, bankId, algorithm: 'keepkey-ckv-base64url-v1',
    revision: 12, backedUpRevision: 12, nextSlot: 3, ready: [2],
    profiles: [{ id, origin: 'https://example.org', account: 'legacy', slot: 0, pendingSlot: 1, rotationState, reviewDays: 90, createdAt: 1_000_000 }],
  })
  const ciphertext = Buffer.concat([new Uint8Array(cipher.update(plaintext)), new Uint8Array(cipher.final())])
  const v1Backup = JSON.stringify({ format: 'keepkey-password-bank', version: 1, bankId, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') })
  return { id, json: v1Backup }
}

describe('password bank release gates', () => {
  test('43 created and changed profiles reopen from the encrypted database using 86 lifetime slots', async () => {
    const { bank, db, deps } = fixture()
    bank.setEnabled(true)
    await bank.unlock(true)
    const profileIds: string[] = []
    for (let i = 0; i < 43; i++) {
      await bank.generate(2, 5)
      const account = `pilot-${i}@example.com`
      const profile = bank.assign('https://login.example.com', account, 90).profiles.find(entry => entry.account === account)!
      profileIds.push(profile.id)
      bank.change(profile.id)
    }
    const stored = db.get(PASSWORD_BANK_SETTING)!
    bank.lock()
    const reopened = new PasswordBank(deps)
    const restored = await reopened.unlock()
    expect(restored.profiles.map(profile => profile.id)).toEqual(profileIds)
    expect(restored.profiles.every(profile => profile.changedAt && profile.pendingSlot === undefined)).toBe(true)
    expect(restored.profiles.map(profile => profile.slot)).toEqual(profileIds.map((_, index) => 2 * index + 1))
    expect((await reopened.generate(1, 5)).readySlots.map(({ slot }) => slot)).toEqual([86])
    expect(stored).not.toContain('@example.com')
  })

  test('banks follow the device and effective wallet; only explicit recovery can open the previous global bank', async () => {
    const f = await assigned()
    const legacy = f.db.get(PASSWORD_BANK_SETTING)
    let scope: string | null = null
    const bank = new PasswordBank({ ...f.deps, walletScope: () => scope })
    expect(bank.view()).toMatchObject({ exists: false, walletPending: true })

    scope = 'device-a:hidden-wallet'
    f.seed('different passphrase')
    expect((await bank.unlock()).exists).toBe(false)
    await expect(bank.unlock(false, undefined, true)).rejects.toThrow('could not be verified')
    expect(bank.view().exists).toBe(false)
    await bank.unlock(true)
    const hiddenBankId = bank.view().bankId

    scope = 'device-a:standard-wallet'
    f.seed('test seed')
    expect(bank.view()).toMatchObject({ exists: false, unlocked: false, profiles: [] })
    expect((await bank.unlock(false, undefined, true)).profiles[0]?.id).toBe(f.id)
    expect(f.db.get(PASSWORD_BANK_SETTING)).toBe(legacy)

    scope = 'device-b:standard-wallet'
    expect((await bank.unlock()).exists).toBe(false)
    scope = 'device-a:hidden-wallet'
    f.seed('different passphrase')
    expect((await bank.unlock()).bankId).toBe(hiddenBankId)
  })

  test('explicit recovery prefers the matching preview bank to the previous global bank', async () => {
    const f = await assigned()
    const previousScope = 'device-a:preview-public-address'
    const currentScope = 'device-a:wallet-selector'
    const preview = new PasswordBank({ ...f.deps, walletScope: () => previousScope })
    await preview.unlock(true)
    await preview.generate(1, 5)
    const profile = preview.assign('example.org', 'preview account', 90).profiles[0]
    const password = preview.reveal(profile.id).password
    let lookups = 0
    const scoped = new PasswordBank({
      ...f.deps,
      walletScope: () => currentScope,
      legacyWalletScope: async () => { lookups++; return previousScope },
    })
    expect((await scoped.unlock()).exists).toBe(false)
    expect(lookups).toBe(0)
    const restored = await scoped.unlock(false, undefined, true)
    expect(lookups).toBe(1)
    expect(restored.bankId).toBe(preview.view().bankId)
    expect(restored.profiles.map(p => p.id)).toEqual([profile.id])
    await scoped.rehydrate(profile.id, 5)
    expect(scoped.reveal(profile.id).password).toBe(password)
    expect([...f.db.keys()].every(key => !key.includes(previousScope))).toBe(true)
  })

  test('explicit recovery refuses a wallet change while it locates an older bank', async () => {
    const f = await assigned()
    const before = [...f.db]
    let scope = 'device-a:wallet-one'
    let finishLookup!: (value: string | null) => void
    const scoped = new PasswordBank({
      ...f.deps,
      walletScope: () => scope,
      legacyWalletScope: () => new Promise(resolve => { finishLookup = resolve }),
    })
    const recovering = scoped.unlock(false, undefined, true)
    scope = 'device-a:wallet-two'
    f.session('session2')
    finishLookup(null)
    await expect(recovering).rejects.toThrow('wallet changed')
    expect(scoped.view()).toMatchObject({ exists: false, unlocked: false })
    expect([...f.db]).toEqual(before)
  })

  test('a foreground bank unlock prompts for the PIN before asking the device to derive a key', async () => {
    const f = fixture()
    const snapshot: DeviceOperationSnapshot = { wallet: {}, deviceId: 'device', seedAddress: null, state: 'needs_pin' }
    let finishPin!: (accepted: boolean) => void
    let prompts = 0
    const coordinator = new DeviceOperationCoordinator({
      snapshot: () => snapshot,
      unlock: async () => {
        prompts++
        const accepted = await new Promise<boolean>(resolve => { finishPin = resolve })
        if (!accepted) throw new Error('PIN cancelled')
        snapshot.state = 'ready'
      },
    })
    const bank = new PasswordBank({
      ...f.deps,
      async withDeviceUnlock(action) {
        const release = await coordinator.acquire({ unlock: true, rejectIfBusy: true })
        try { return await action() } finally { release() }
      },
      device: () => {
        if (snapshot.state !== 'ready') throw new Error('KeepKey is locked')
        return f.deps.device()
      },
    })
    await expect(bank.unlock(true)).rejects.toThrow('disabled')
    expect(prompts).toBe(0)
    bank.setEnabled(true)

    const cancelled = bank.unlock(true)
    expect(prompts).toBe(1)
    expect(f.calls()).toBe(0)
    finishPin(false)
    await expect(cancelled).rejects.toThrow('PIN cancelled')
    expect(f.db.has(PASSWORD_BANK_SETTING)).toBe(false)

    const unlocking = bank.unlock(true)
    expect(prompts).toBe(2)
    expect(f.calls()).toBe(0)
    finishPin(true)
    expect((await unlocking).unlocked).toBe(true)
    expect(f.calls()).toBe(1)
  })

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
  test('a v1 backup keeps allocated passwords and reserves the new format for subsequent slots', async () => {
    const { id, json: v1Backup } = legacyPasswordBackup()
    const { bank, db } = fixture()
    bank.setEnabled(true)
    await bank.unlock(false, v1Backup)
    expect(JSON.parse(db.get(PASSWORD_BANK_SETTING)!).version).toBe(1)

    // The backup's unused staged replacement (slot 1) is settled away on open.
    expect(bank.view().profiles[0]).toMatchObject({ slot: 0, rotationState: 'active' })
    expect(bank.view().profiles[0].pendingSlot).toBeUndefined()
    await bank.rehydrate(id, 5)
    await bank.generate(1, 5)
    const legacyReady = bank.assign('https://example.org', 'legacy ready', 90).profiles[1]
    const generated = bank.assign('https://example.org', 'new', 90).profiles[2]
    expect(legacyReady.slot).toBe(2)
    expect(generated.slot).toBe(3)
    await bank.rehydrate(legacyReady.id, 5)
    expect(bank.reveal(id).password).toBe('bvAL4r1L1LIeH5ng_5yzu6GZ')
    expect(bank.reveal(legacyReady.id).password).toBe('2RhYI69aOsTHPKsSnpqUcBC7')
    const password = bank.reveal(generated.id).password
    expect(password).toBe('IwYRPTifAKKsZj&nTtmb3oPt')
    expect(password).toMatch(/^[A-Za-z0-9!@#$%^&*]{24}$/)
    expect(password.match(/[!@#$%^&*]/g)).toHaveLength(1)
    expect(password).toMatch(/[A-Z]/)
    expect(password).toMatch(/[a-z]/)
    expect(password).toMatch(/[0-9]/)

    const stored = db.get(PASSWORD_BANK_SETTING)!
    const envelope = JSON.parse(stored)
    expect(envelope.version).toBe(2)
    expect(envelope.symbolFromSlot).toBeUndefined()
    const { bank: restored } = fixture()
    restored.setEnabled(true)
    await expect(restored.unlock(false, JSON.stringify({ ...envelope, version: 1 }))).rejects.toThrow('could not be verified')
    await restored.unlock(false, stored)
    await restored.rehydrate(id, 5)
    await restored.rehydrate(legacyReady.id, 5)
    await restored.rehydrate(generated.id, 5)
    expect(restored.reveal(id).password).toBe('bvAL4r1L1LIeH5ng_5yzu6GZ')
    expect(restored.reveal(legacyReady.id).password).toBe('2RhYI69aOsTHPKsSnpqUcBC7')
    expect(restored.reveal(generated.id).password).toBe(password)
  })
  test('new replacements skip unassigned slots from the previous format', async () => {
    const { bank } = fixture()
    const { id, json } = legacyPasswordBackup()
    bank.setEnabled(true)
    const previous = await bank.unlock(false, json)

    expect(previous.readySlots).toEqual([{ slot: 2, symbolFormat: false, cachedUntil: undefined }])
    expect(() => bank.change(id)).toThrow('Generate a new ready password first')
    expect(bank.view().revision).toBe(previous.revision)

    const generated = await bank.generate(1, 5)
    expect(generated.readySlots.map(({ slot, symbolFormat }) => [slot, symbolFormat])).toEqual([[2, false], [3, true]])
    const changed = bank.change(id)
    expect(changed.profiles[0].slot).toBe(3)
    expect(changed.readySlots).toEqual(previous.readySlots)
    expect(bank.reveal(id).password).toBe('IwYRPTifAKKsZj&nTtmb3oPt')
  })
  test('an entry left mid-change by the retired flow opens settled', async () => {
    const submitted = fixture(), legacy = legacyPasswordBackup('submitted')
    submitted.bank.setEnabled(true)
    // A submitted replacement may already be on the website, so it is kept.
    expect((await submitted.bank.unlock(false, legacy.json)).profiles[0]).toMatchObject({ slot: 1, rotationState: 'active', changedAt: 1_000_000 })
    await submitted.bank.rehydrate(legacy.id, 5)
    expect(submitted.bank.reveal(legacy.id).password).toBe('raPeMGFpZtHfOu-dJxTKR1B0')
  })
  test('defaults off and every secret operation fails without contacting hardware', async () => {
    const f = fixture()
    expect(f.bank.view().enabled).toBe(false)
    await expect(f.bank.unlock(true)).rejects.toThrow('disabled')
    await expect(f.bank.generate(1, 5)).rejects.toThrow('disabled')
    expect(() => f.bank.reveal('x')).toThrow('disabled')
    expect(() => f.bank.change('x')).toThrow('disabled')
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
    const stored = f.db.get(PASSWORD_BANK_SETTING)!
    const replacement = fixture()
    replacement.bank.setEnabled(true)
    const restored = await replacement.bank.unlock(false, stored)
    expect(restored.profiles[0].account).toBe('person@example.com')
    expect(restored.profiles[0].cachedUntil).toBeUndefined()
    await replacement.bank.rehydrate(f.id, 5)
    expect(replacement.bank.reveal(f.id).password).toBe(password)
  })
  test('wrong seed cannot open a backup and does not replace local data', async () => {
    const f = await assigned()
    const other = fixture(); other.bank.setEnabled(true); other.seed('wrong seed')
    await expect(other.bank.unlock(false, f.db.get(PASSWORD_BANK_SETTING)!)).rejects.toThrow('could not be verified')
    expect(other.db.has(PASSWORD_BANK_SETTING)).toBe(false)
    expect(other.bank.view().unlocked).toBe(false)
  })
  test('tampered authenticated backup is rejected', async () => {
    const f = await assigned(), b = JSON.parse(f.db.get(PASSWORD_BANK_SETTING)!)
    const bytes = Buffer.from(b.ciphertext, 'base64'); bytes[0] ^= 1; b.ciphertext = bytes.toString('base64')
    const other = fixture(); other.bank.setEnabled(true)
    await expect(other.bank.unlock(false, JSON.stringify(b))).rejects.toThrow('could not be verified')
    expect(other.bank.view().exists).toBe(false)
  })
  test('TTL evicts cached secrets; rehydration preserves the website password and slot', async () => {
    const f = await assigned(), old = f.bank.reveal(f.id).password
    f.advance(5 * 60000)
    expect(() => f.bank.reveal(f.id)).toThrow('expired')
    expect(f.bank.view().profiles[0].slot).toBe(0)
    await f.bank.rehydrate(f.id, 5)
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
  test('changing a password replaces it in one step and records when', async () => {
    const f = await assigned(), old = f.bank.reveal(f.id).password
    f.advance(60000)
    const changed = f.bank.change(f.id).profiles[0]
    expect(changed).toMatchObject({ slot: 1, rotationState: 'active', createdAt: 1_000_000, changedAt: 1_060_000 })
    const next = f.bank.reveal(f.id).password
    expect(next).not.toBe(old)
    f.bank.lock()
    const restarted = new PasswordBank(f.deps)
    await restarted.unlock()
    await restarted.rehydrate(f.id, 5)
    expect(restarted.reveal(f.id).password).toBe(next)
  })

  test('a failed database write keeps the current password', async () => {
    const f = await assigned()
    let writeFails = false
    const bank = new PasswordBank({
      ...f.deps,
      replace(key, value, expected) {
        if (writeFails) throw new Error('Database write failed')
        if (f.deps.read(key) !== expected) return false
        f.deps.write(key, value)
        return true
      },
    })
    await bank.unlock()
    await bank.generate(1, 5)
    await bank.rehydrate(f.id, 5)
    const old = bank.reveal(f.id).password, stored = f.db.get(PASSWORD_BANK_SETTING)
    writeFails = true
    expect(() => bank.change(f.id)).toThrow('Database write failed')
    expect(f.db.get(PASSWORD_BANK_SETTING)).toBe(stored)
    expect(bank.view().profiles[0].slot).toBe(0)
    expect(bank.reveal(f.id).password).toBe(old)
  })

  test('new entries and changes never reuse retired slots', async () => {
    const f = await assigned()
    f.bank.assign('github.com', 'other', 30)
    f.bank.change(f.id)
    expect(f.bank.view().readySlots).toHaveLength(0)
    await f.bank.generate(1, 5)
    expect(f.bank.view().readySlots[0].slot).toBe(3)
  })
  test('existing banks cannot be overwritten through create or import', async () => {
    const f = await assigned(), stored = f.db.get(PASSWORD_BANK_SETTING)!
    await expect(f.bank.unlock(true)).rejects.toThrow('already exists')
    await expect(f.bank.unlock(false, stored)).rejects.toThrow('already exists')
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
  // Audit v6 A10: the API took 1–1440 minutes but the cache never outlived the
  // 15-minute unlock session, so anything above 15 was silently cut. It now
  // takes only what it can honor, and says why.
  test('cache duration is bounded by the unlock session, and a longer one is refused with the reason', async () => {
    expect(PASSWORD_CACHE_MAX_MINUTES).toBe(15)
    const f = fixture(); f.bank.setEnabled(true); await f.bank.unlock(true)
    for (const minutes of [16, 60, 1440]) {
      await expect(f.bank.generate(1, minutes)).rejects.toThrow('Cache duration must be 1–15 minutes: the unlock session lasts 15 minutes')
    }
    const before = f.bank.view().readySlots.length
    await f.bank.generate(1, 15)
    const slots = f.bank.view().readySlots
    expect(slots.length).toBe(before + 1)
    expect(slots.at(-1)!.cachedUntil).toBe(1_000_000 + 15 * 60000)
  })
  test('rehydrate refuses a cache longer than the session too', async () => {
    const f = await assigned()
    await expect(f.bank.rehydrate(f.id, 1440)).rejects.toThrow('1–15 minutes')
    await f.bank.rehydrate(f.id, 15)
  })
  test('the session is not extended by caching: a password cached late still ends with the session', async () => {
    const f = fixture(); f.bank.setEnabled(true); await f.bank.unlock(true)
    f.advance(10 * 60000)
    await f.bank.generate(1, 15)
    // Reported expiry is the real one: session end, not 15 minutes from now.
    expect(f.bank.view().readySlots.at(-1)!.cachedUntil).toBe(1_000_000 + 15 * 60000)
    f.advance(5 * 60000)
    expect(f.bank.view().unlocked).toBe(false)
    expect(f.bank.view().readySlots).toEqual([])
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
