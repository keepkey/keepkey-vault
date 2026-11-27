import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { PASSWORD_BANK_ALGORITHM, PASSWORD_CACHE_MAX_MINUTES, passwordOrigin, type PasswordBankBackup, type PasswordBankView, type PasswordProfile } from '../shared/password-bank'

export const PASSWORD_BANK_SETTING = 'password_bank_v1'
export const PASSWORD_BANK_FLAG = 'password_manager_enabled'
const MAX_SLOTS = 4096

function scopedBankSetting(scope: string): string {
  return `${PASSWORD_BANK_SETTING}:${createHash('sha256').update(scope).digest('hex')}`
}
/** A cached password lives inside the unlock session and never outlasts it, so
 *  the longest cache is the session itself. The session is not extended. */
const SESSION_MS = PASSWORD_CACHE_MAX_MINUTES * 60 * 1000
export { PASSWORD_CACHE_MAX_MINUTES }
// Preserve older backups' risk metadata inside the encrypted registry.
type StoredPasswordProfile = PasswordProfile & { riskFindings?: unknown }
type Registry = {
  bankId: string
  algorithm: typeof PASSWORD_BANK_ALGORITHM
  revision: number
  nextSlot: number
  ready: number[]
  profiles: StoredPasswordProfile[]
} & ({ version: 1; symbolFromSlot?: never } | { version: 2; symbolFromSlot: number })
interface Device {
  /** Stable for this wallet/passphrase SESSION, invalidated on seed/session changes. */
  session: string
  cipher: (path: number[], label: string) => Promise<Uint8Array>
}
interface Dependencies {
  read: (key: string) => string | null
  write: (key: string, value: string) => void
  replace?: (key: string, value: string, expected: string | null) => boolean
  device: () => Device
  walletScope?: () => string | null
  legacyWalletScope?: () => Promise<string | null>
  withDeviceUnlock?: <T>(action: () => Promise<T>) => Promise<T>
  now?: () => number
}
type Cache = { bytes: Buffer; expiresAt: number }

const PASSWORD_LENGTH = 24
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const SYMBOLS = '!@#$%^&*'

function usesSymbolFormat(registry: Registry, slot: number): boolean {
  return registry.version === 2 && slot >= registry.symbolFromSlot
}

function formatSymbolPassword(entropy: Buffer): Buffer {
  const key = new Uint8Array(entropy.buffer, entropy.byteOffset, entropy.byteLength)
  let block = Buffer.alloc(0), offset = 0, counter = 0
  const sample = (size: number) => {
    const limit = Math.floor(256 / size) * size
    for (;;) {
      if (offset === block.length) {
        block.fill(0)
        block = createHmac('sha256', key).update(`keepkey-password-bank/v2/symbol-password/${counter++}`).digest()
        offset = 0
      }
      const value = block[offset++]
      if (value < limit) return value % size
    }
  }
  const password = Buffer.alloc(PASSWORD_LENGTH)
  try {
    const symbolPosition = sample(password.length)
    password[symbolPosition] = SYMBOLS.charCodeAt(sample(SYMBOLS.length))
    // Sample uniformly from strings that contain all three alphanumeric classes.
    let classes: number
    do {
      classes = 0
      for (let index = 0; index < password.length; index++) {
        if (index === symbolPosition) continue
        const character = sample(ALPHANUMERIC.length)
        password[index] = ALPHANUMERIC.charCodeAt(character)
        classes |= character < 26 ? 1 : character < 52 ? 2 : 4
      }
    } while (classes !== 7)
    return password
  } finally { block.fill(0) }
}

/** Device PRF compatibility scheme, explicitly not BIP85. Nothing invokes a
 * device while the flag is off. Only encrypted registry metadata is persisted;
 * generated passwords and the metadata key live in this process session. */
export class PasswordBank {
  private key: Buffer | null = null
  private registry: Registry | null = null
  private session: string | null = null
  private deadline = 0
  private epoch = 0
  private busy = false
  private persisted: string | null = null
  private registrySetting: string | null = null
  private cache = new Map<number, Cache>()
  private now: () => number
  constructor(private deps: Dependencies) { this.now = deps.now || Date.now }

  get enabled() { return this.deps.read(PASSWORD_BANK_FLAG) === '1' }
  setEnabled(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    this.save(PASSWORD_BANK_FLAG, enabled ? '1' : '0')
    this.lock()
  }
  private save(key: string, value: string) {
    this.deps.write(key, value)
    if (this.deps.read(key) !== value) throw new Error('Could not save the password bank')
  }
  private bankSetting() {
    if (!this.deps.walletScope) return PASSWORD_BANK_SETTING
    const scope = this.deps.walletScope()
    return scope ? scopedBankSetting(scope) : null
  }
  private saveRegistry(setting: string, value: string, expected = this.persisted) {
    const saved = this.deps.replace
      ? this.deps.replace(setting, value, expected)
      : this.deps.read(setting) === expected
    if (!saved) { this.lock(); throw new Error('Password bank changed in another window. Unlock and review it again.') }
    if (!this.deps.replace) this.save(setting, value)
    this.persisted = value
  }
  lock() {
    this.epoch++
    this.key?.fill(0)
    this.key = null
    this.registry = null
    this.session = null
    this.deadline = 0
    this.persisted = null
    this.registrySetting = null
    for (const c of this.cache.values()) c.bytes.fill(0)
    this.cache.clear()
  }
  private guard() {
    if (!this.enabled) { this.lock(); throw new Error('Password manager is disabled') }
  }
  private active() {
    this.guard()
    if (!this.registry || !this.key) throw new Error('Unlock the password bank with KeepKey first')
    if (!this.registrySetting || this.bankSetting() !== this.registrySetting) {
      this.lock()
      throw new Error('Unlock the password bank with KeepKey first')
    }
    if (this.deps.read(this.registrySetting) !== this.persisted) {
      this.lock(); throw new Error('Password bank changed in another window. Unlock it again.')
    }
    if (this.now() >= this.deadline || this.deps.device().session !== this.session) {
      this.lock(); throw new Error('Password bank locked. Reconnect and unlock with the same wallet.')
    }
    this.expire()
    return this.registry
  }
  private expire() {
    for (const [slot, c] of this.cache) if (c.expiresAt <= this.now()) { c.bytes.fill(0); this.cache.delete(slot) }
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    this.guard()
    if (this.busy) throw new Error('A password operation is already in progress')
    this.busy = true
    try { return await run() } finally { this.busy = false }
  }
  private async derive(bankId: string, slot?: number): Promise<Buffer> {
    const device = this.deps.device(), epoch = this.epoch
    const path = [0x80002720, 0x8000000b, slot === undefined ? 0x80000000 : 0x80000001, ...(slot === undefined ? [] : [0x80000000 + slot])]
    const raw = await device.cipher(path, `KeepKey Password Bank v1 ${bankId}${slot === undefined ? ' unlock' : ` slot ${slot}`}`)
    try {
      this.guard()
      if (epoch !== this.epoch || device.session !== this.deps.device().session) throw new Error('Wallet or feature changed during device approval')
      if (raw.length !== 32) throw new Error('Unexpected device response')
      return createHash('sha256').update(`keepkey-password-bank/v1/${slot === undefined ? 'metadata' : 'password'}`).update(raw).digest()
    } finally { raw.fill(0) }
  }
  private seal(registry: Registry, key = this.key!): PasswordBankBackup {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', new Uint8Array(key), new Uint8Array(iv))
    cipher.setAAD(new TextEncoder().encode(`keepkey-password-bank/${registry.version}/${registry.bankId}`))
    // Earlier Vault versions expect this field in both envelope versions.
    const plaintext = Buffer.from(JSON.stringify({ backedUpRevision: -1, ...registry }))
    try {
      const ciphertext = Buffer.concat([new Uint8Array(cipher.update(new Uint8Array(plaintext))), new Uint8Array(cipher.final())])
      return { format: 'keepkey-password-bank', version: registry.version, bankId: registry.bankId, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
    } finally { plaintext.fill(0) }
  }
  private parseBackup(value: string): PasswordBankBackup {
    if (typeof value !== 'string' || value.length > 2_000_000) throw new Error('Invalid or oversized backup')
    const b = JSON.parse(value)
    if (b?.format !== 'keepkey-password-bank' || (b.version !== 1 && b.version !== 2) || !/^[a-f0-9]{32}$/.test(b.bankId)) throw new Error('Unsupported password-bank backup')
    for (const field of ['iv', 'ciphertext', 'tag']) if (typeof b[field] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b[field])) throw new Error('Invalid encrypted backup')
    if (Buffer.from(b.iv, 'base64').length !== 12 || Buffer.from(b.tag, 'base64').length !== 16) throw new Error('Invalid encrypted backup')
    return b
  }
  private open(b: PasswordBankBackup, key: Buffer): Registry {
    const decipher = createDecipheriv('aes-256-gcm', new Uint8Array(key), new Uint8Array(Buffer.from(b.iv, 'base64')))
    decipher.setAAD(new TextEncoder().encode(`keepkey-password-bank/${b.version}/${b.bankId}`))
    decipher.setAuthTag(new Uint8Array(Buffer.from(b.tag, 'base64')))
    let plain: Buffer
    try { plain = Buffer.concat([new Uint8Array(decipher.update(new Uint8Array(Buffer.from(b.ciphertext, 'base64')))), new Uint8Array(decipher.final())]) }
    catch { throw new Error('This encrypted bank could not be verified for the current KeepKey wallet.') }
    try {
      const r = JSON.parse(plain.toString('utf8')) as Registry
      if (r.version !== b.version || r.bankId !== b.bankId || r.algorithm !== PASSWORD_BANK_ALGORITHM || !Number.isSafeInteger(r.revision) || r.revision < 0 || !Number.isSafeInteger(r.nextSlot) || r.nextSlot < 0 || r.nextSlot > MAX_SLOTS || !Array.isArray(r.profiles) || !Array.isArray(r.ready) || r.profiles.length > MAX_SLOTS) throw new Error('Invalid password-bank registry')
      if (r.version === 2) {
        if (!Number.isSafeInteger(r.symbolFromSlot) || r.symbolFromSlot < 0 || r.symbolFromSlot >= r.nextSlot) throw new Error('Invalid password format boundary')
      } else if (r.symbolFromSlot !== undefined) throw new Error('Invalid password format boundary')
      const allocated = new Set<number>()
      const ids = new Set<string>()
      const use = (slot: number) => {
        if (!Number.isSafeInteger(slot) || slot < 0 || slot >= r.nextSlot || allocated.has(slot)) throw new Error('Invalid or reused password slot')
        allocated.add(slot)
      }
      r.ready.forEach(use)
      for (const p of r.profiles) {
        if (typeof p.id !== 'string' || ids.has(p.id) || typeof p.account !== 'string' || !p.account.trim() || p.account.length > 200 || passwordOrigin(p.origin) !== p.origin || !['active', 'prepared', 'submitted'].includes(p.rotationState) || !Number.isSafeInteger(p.reviewDays) || p.reviewDays < 1 || p.reviewDays > 3650 || !Number.isFinite(p.createdAt) || (p.changedAt !== undefined && !Number.isFinite(p.changedAt))) throw new Error('Invalid password profile')
        ids.add(p.id); use(p.slot)
        if (p.pendingSlot !== undefined) use(p.pendingSlot)
        if ((p.rotationState === 'active') !== (p.pendingSlot === undefined)) throw new Error('Invalid rotation journal')
      }
      return r
    } finally { plain.fill(0) }
  }
  private commit(next: Registry) {
    this.active()
    next.revision++
    this.saveRegistry(this.registrySetting!, JSON.stringify(this.seal(next)))
    this.registry = next
  }
  private copy() { return structuredClone(this.active()) }
  private profile(r: Registry, id: string) {
    const p = r.profiles.find(p => p.id === id)
    if (!p) throw new Error('Password profile not found')
    return p
  }

  view(): PasswordBankView {
    if (!this.enabled) { this.lock(); return this.empty(false) }
    if (this.registry) { try { this.active() } catch { this.lock() } }
    if (!this.registry) return this.empty(true)
    const r = this.registry
    return {
      enabled: true, exists: true, unlocked: true, bankId: r.bankId, algorithm: PASSWORD_BANK_ALGORITHM,
      profiles: r.profiles.map(({ riskFindings: _riskFindings, ...profile }) => ({
        ...profile,
        cachedUntil: this.cache.get(profile.slot)?.expiresAt,
        pendingCachedUntil: profile.pendingSlot === undefined ? undefined : this.cache.get(profile.pendingSlot)?.expiresAt,
        due: !profile.changedAt || this.now() >= profile.changedAt + profile.reviewDays * 86400000,
      })),
      readySlots: r.ready.map(slot => ({
        slot, symbolFormat: usesSymbolFormat(r, slot), cachedUntil: this.cache.get(slot)?.expiresAt,
      })),
      revision: r.revision,
    }
  }
  private empty(enabled: boolean): PasswordBankView {
    const setting = enabled ? this.bankSetting() : null
    return { enabled, exists: !!setting && !!this.deps.read(setting), walletPending: enabled && !setting, unlocked: false, algorithm: PASSWORD_BANK_ALGORITHM, profiles: [], readySlots: [], revision: 0 }
  }
  async unlock(create = false, importJson?: string, recoverLegacy = false) {
    return this.exclusive(async () => {
      this.lock()
      const imported = importJson === undefined ? null : this.parseBackup(importJson)
      const epoch = this.epoch
      const unlock = async () => {
        this.guard()
        if (this.epoch !== epoch) throw new Error('Password bank changed during device unlock. Try again.')
        const setting = this.bankSetting()
        if (!setting) throw new Error('Wait for Vault to verify the connected KeepKey wallet, then try again.')
        const stored = this.deps.read(setting)
        if ((create || imported || recoverLegacy) && stored) throw new Error('A password bank already exists for this KeepKey wallet')
        let legacy: string | null = null
        if (recoverLegacy && this.deps.walletScope) {
          const device = this.deps.device()
          const previousScope = await this.deps.legacyWalletScope?.()
          this.guard()
          if (this.epoch !== epoch || this.bankSetting() !== setting || this.deps.device().session !== device.session) {
            throw new Error('KeepKey wallet changed during password bank recovery. Try again.')
          }
          legacy = (previousScope ? this.deps.read(scopedBankSetting(previousScope)) : null) ?? this.deps.read(PASSWORD_BANK_SETTING)
        }
        if (!create && !stored && !imported && !legacy) {
          if (recoverLegacy) throw new Error('No previous password bank is available to restore.')
          return this.view()
        }
        const saved = stored ?? legacy
        const backup = imported ?? (saved ? this.parseBackup(saved) : null)
        const bankId = backup?.bankId || randomBytes(16).toString('hex')
        const device = this.deps.device()
        const key = await this.derive(bankId)
        try {
          const registry = backup ? this.open(backup, key) : { version: 1 as const, bankId, algorithm: PASSWORD_BANK_ALGORITHM, revision: 0, nextSlot: 0, ready: [], profiles: [] }
          if (this.bankSetting() !== setting) throw new Error('KeepKey wallet changed during password bank unlock. Try again.')
          this.saveRegistry(setting, JSON.stringify(this.seal(registry, key)), stored)
          this.registrySetting = setting
          this.key = key; this.registry = registry; this.session = device.session; this.deadline = this.now() + SESSION_MS
          return this.view()
        } catch (e) { key.fill(0); throw e }
      }
      return this.deps.withDeviceUnlock ? this.deps.withDeviceUnlock(unlock) : unlock()
    })
  }
  async generate(count: number, ttlMinutes: number) {
    return this.exclusive(async () => {
      const r = this.active()
      if (!Number.isInteger(count) || count < 1 || count > 8 || r.nextSlot + count > MAX_SLOTS) throw new Error('Generate between 1 and 8 entries (maximum 4096 slots)')
      this.ttl(ttlMinutes)
      for (let i = 0; i < count; i++) {
        // Reserve and persist before device I/O. A cancelled slot is burned.
        const next = this.copy(), slot = next.nextSlot++
        this.commit(next.version === 1 ? { ...next, version: 2, symbolFromSlot: slot } : next)
        const bytes = await this.derive(r.bankId, slot)
        try {
          const ready = this.copy(); ready.ready.push(slot); this.commit(ready)
          this.put(slot, bytes, ttlMinutes)
        } finally { bytes.fill(0) }
      }
      return this.view()
    })
  }
  private ttl(minutes: number) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > PASSWORD_CACHE_MAX_MINUTES) {
      throw new Error(`Cache duration must be 1–${PASSWORD_CACHE_MAX_MINUTES} minutes: the unlock session lasts ${PASSWORD_CACHE_MAX_MINUTES} minutes and a cached password ends with it`)
    }
  }
  private put(slot: number, entropy: Buffer, ttlMinutes: number) {
    const registry = this.active()
    const bytes = usesSymbolFormat(registry, slot)
      ? formatSymbolPassword(entropy)
      : Buffer.from(entropy.toString('base64url').slice(0, PASSWORD_LENGTH))
    this.cache.get(slot)?.bytes.fill(0)
    this.cache.set(slot, { bytes, expiresAt: Math.min(this.deadline, this.now() + ttlMinutes * 60000) })
  }
  assign(origin: string, account: string, reviewDays: number) {
    const r = this.copy()
    origin = passwordOrigin(origin)
    if (typeof account !== 'string' || !account.trim() || account.length > 200 || !Number.isInteger(reviewDays) || reviewDays < 1 || reviewDays > 3650) throw new Error('Enter an account and a review interval of 1–3650 days')
    account = account.trim()
    if (r.profiles.some(p => p.origin === origin && p.account === account)) throw new Error('This domain and account are already tracked')
    const slot = r.ready.shift()
    if (slot === undefined) throw new Error('Generate a ready password first')
    r.profiles.push({ id: randomUUID(), origin, account, slot, reviewDays, rotationState: 'active', createdAt: this.now() })
    this.commit(r)
    return this.view()
  }
  async rehydrate(id: string, pending: boolean, ttlMinutes: number) {
    return this.exclusive(async () => {
      this.ttl(ttlMinutes)
      const r = this.active(), p = this.profile(r, id), slot = pending ? p.pendingSlot : p.slot
      if (slot === undefined) throw new Error('No pending password')
      const bytes = await this.derive(r.bankId, slot)
      try { this.put(slot, bytes, ttlMinutes) } finally { bytes.fill(0) }
      return this.view()
    })
  }
  reveal(id: string, pending = false) {
    const r = this.active(), p = this.profile(r, id), slot = pending ? p.pendingSlot : p.slot
    if (pending && p.rotationState !== 'submitted') {
      throw new Error('Begin the website change before accessing the new password')
    }
    const c = slot === undefined ? undefined : this.cache.get(slot)
    if (!c) throw new Error('Password cache expired. Rehydrate this entry with KeepKey.')
    return { password: c.bytes.toString('utf8'), expiresAt: Math.min(c.expiresAt, this.now() + 30000) }
  }
  rotate(id: string, action: 'prepare' | 'submitted' | 'verify' | 'cancel', confirmed: boolean) {
    const r = this.copy(), p = this.profile(r, id)
    let retiredSlot: number | undefined
    if (action === 'prepare') {
      if (p.pendingSlot !== undefined) throw new Error('Resolve the current rotation first')
      const readyIndex = r.ready.findIndex(slot => usesSymbolFormat(r, slot))
      if (readyIndex < 0) throw new Error('Generate a new ready password first')
      const [slot] = r.ready.splice(readyIndex, 1)
      p.pendingSlot = slot; p.rotationState = 'prepared'
    } else if (action === 'submitted') {
      if (p.rotationState !== 'prepared') throw new Error('Prepare a new password first')
      p.rotationState = 'submitted'
    } else if (action === 'verify') {
      if (p.rotationState !== 'submitted' || !confirmed || p.pendingSlot === undefined) throw new Error('Confirm a successful sign-in with the new password first')
      retiredSlot = p.slot
      p.slot = p.pendingSlot; delete p.pendingSlot; p.rotationState = 'active'; p.changedAt = this.now()
    } else if (action === 'cancel') {
      if (p.rotationState !== 'prepared' || p.pendingSlot === undefined) throw new Error('A submitted change must be reconciled; it cannot be discarded')
      retiredSlot = p.pendingSlot
      delete p.pendingSlot; p.rotationState = 'active'
    } else throw new Error('Invalid rotation action')
    // Keep both locations available until the updated journal has committed.
    this.commit(r)
    if (retiredSlot !== undefined) {
      this.cache.get(retiredSlot)?.bytes.fill(0)
      this.cache.delete(retiredSlot)
    }
    return this.view()
  }
}
