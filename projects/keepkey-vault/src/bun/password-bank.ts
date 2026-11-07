import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { PASSWORD_BANK_ALGORITHM, passwordOrigin, type PasswordBankBackup, type PasswordBankView, type PasswordProfile, type PasswordRiskKind } from '../shared/password-bank'

export const PASSWORD_BANK_SETTING = 'password_bank_v1'
export const PASSWORD_BANK_FLAG = 'password_manager_enabled'
const MAX_SLOTS = 4096
const MAX_CACHE_MS = 24 * 60 * 60 * 1000
const SESSION_MS = 15 * 60 * 1000
interface Registry {
  version: 1
  bankId: string
  algorithm: typeof PASSWORD_BANK_ALGORITHM
  revision: number
  backedUpRevision: number
  nextSlot: number
  ready: number[]
  profiles: PasswordProfile[]
}
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
  now?: () => number
}
type Cache = { bytes: Buffer; expiresAt: number }

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
  private cache = new Map<number, Cache>()
  private now: () => number
  constructor(private deps: Dependencies) { this.now = deps.now || Date.now }

  get enabled() { return this.deps.read(PASSWORD_BANK_FLAG) === '1' }
  capture() {
    this.active()
    const epoch = this.epoch
    return () => { this.active(); if (this.epoch !== epoch) throw new Error('Password session changed. Review the fill again.') }
  }
  setEnabled(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    this.save(PASSWORD_BANK_FLAG, enabled ? '1' : '0')
    this.lock()
  }
  private save(key: string, value: string) {
    this.deps.write(key, value)
    if (this.deps.read(key) !== value) throw new Error('Could not save the password bank')
  }
  private saveRegistry(value: string, expected = this.persisted) {
    const saved = this.deps.replace
      ? this.deps.replace(PASSWORD_BANK_SETTING, value, expected)
      : this.deps.read(PASSWORD_BANK_SETTING) === expected
    if (!saved) { this.lock(); throw new Error('Password bank changed in another window. Unlock and review it again.') }
    if (!this.deps.replace) this.save(PASSWORD_BANK_SETTING, value)
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
    for (const c of this.cache.values()) c.bytes.fill(0)
    this.cache.clear()
  }
  private guard() {
    if (!this.enabled) { this.lock(); throw new Error('Password manager is disabled') }
  }
  private active() {
    this.guard()
    if (!this.registry || !this.key) throw new Error('Unlock the password bank with KeepKey first')
    if (this.deps.read(PASSWORD_BANK_SETTING) !== this.persisted) {
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
    cipher.setAAD(new TextEncoder().encode(`keepkey-password-bank/1/${registry.bankId}`))
    const plaintext = Buffer.from(JSON.stringify(registry))
    try {
      const ciphertext = Buffer.concat([new Uint8Array(cipher.update(new Uint8Array(plaintext))), new Uint8Array(cipher.final())])
      return { format: 'keepkey-password-bank', version: 1, bankId: registry.bankId, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
    } finally { plaintext.fill(0) }
  }
  private parseBackup(value: string): PasswordBankBackup {
    if (typeof value !== 'string' || value.length > 2_000_000) throw new Error('Invalid or oversized backup')
    const b = JSON.parse(value)
    if (b?.format !== 'keepkey-password-bank' || b.version !== 1 || !/^[a-f0-9]{32}$/.test(b.bankId)) throw new Error('Unsupported password-bank backup')
    for (const field of ['iv', 'ciphertext', 'tag']) if (typeof b[field] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b[field])) throw new Error('Invalid encrypted backup')
    if (Buffer.from(b.iv, 'base64').length !== 12 || Buffer.from(b.tag, 'base64').length !== 16) throw new Error('Invalid encrypted backup')
    return b
  }
  private open(b: PasswordBankBackup, key: Buffer): Registry {
    const decipher = createDecipheriv('aes-256-gcm', new Uint8Array(key), new Uint8Array(Buffer.from(b.iv, 'base64')))
    decipher.setAAD(new TextEncoder().encode(`keepkey-password-bank/1/${b.bankId}`))
    decipher.setAuthTag(new Uint8Array(Buffer.from(b.tag, 'base64')))
    let plain: Buffer
    try { plain = Buffer.concat([new Uint8Array(decipher.update(new Uint8Array(Buffer.from(b.ciphertext, 'base64')))), new Uint8Array(decipher.final())]) }
    catch { throw new Error('Backup could not be opened. Use the same seed and wallet passphrase; check the backup for damage.') }
    try {
      const r = JSON.parse(plain.toString('utf8')) as Registry
      if (r.version !== 1 || r.bankId !== b.bankId || r.algorithm !== PASSWORD_BANK_ALGORITHM || !Number.isSafeInteger(r.revision) || r.revision < 0 || !Number.isSafeInteger(r.backedUpRevision) || r.backedUpRevision > r.revision || !Number.isSafeInteger(r.nextSlot) || r.nextSlot < 0 || r.nextSlot > MAX_SLOTS || !Array.isArray(r.profiles) || !Array.isArray(r.ready) || r.profiles.length > MAX_SLOTS) throw new Error('Invalid password-bank registry')
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
        if (p.riskFindings !== undefined) {
          if (!Array.isArray(p.riskFindings) || p.riskFindings.length > 100) throw new Error('Invalid risk history')
          for (const f of p.riskFindings) if (!['compromised', 'reused', 'weak'].includes(f.kind) || !['user', 'chrome-password-checkup'].includes(f.source) || f.mode !== 'user-reported' || !Number.isFinite(f.observedAt) || (f.resolvedAt !== undefined && !Number.isFinite(f.resolvedAt)) || (f.slot !== null && (!Number.isSafeInteger(f.slot) || f.slot < 0 || f.slot >= r.nextSlot))) throw new Error('Invalid risk finding')
        }
        if (p.pendingSlot !== undefined) use(p.pendingSlot)
        if ((p.rotationState === 'active') !== (p.pendingSlot === undefined)) throw new Error('Invalid rotation journal')
      }
      return r
    } finally { plain.fill(0) }
  }
  private commit(next: Registry) {
    this.active()
    next.revision++
    this.saveRegistry(JSON.stringify(this.seal(next)))
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
      profiles: r.profiles.map(p => ({ ...p, cachedUntil: this.cache.get(p.slot)?.expiresAt, pendingCachedUntil: p.pendingSlot === undefined ? undefined : this.cache.get(p.pendingSlot)?.expiresAt, due: !p.changedAt || this.now() >= p.changedAt + p.reviewDays * 86400000 })),
      readySlots: r.ready.map(slot => ({ slot, cachedUntil: this.cache.get(slot)?.expiresAt })),
      backupRequired: r.backedUpRevision !== r.revision, revision: r.revision,
    }
  }
  private empty(enabled: boolean): PasswordBankView {
    return { enabled, exists: enabled && !!this.deps.read(PASSWORD_BANK_SETTING), unlocked: false, algorithm: PASSWORD_BANK_ALGORITHM, profiles: [], readySlots: [], backupRequired: false, revision: 0 }
  }
  async unlock(create = false, importJson?: string) {
    return this.exclusive(async () => {
      this.lock()
      const stored = this.deps.read(PASSWORD_BANK_SETTING)
      if (importJson !== undefined && stored) throw new Error('A password bank already exists. Import into a fresh Vault installation to avoid overwriting current locations.')
      if (create && stored) throw new Error('A password bank already exists')
      if (!create && !stored && importJson === undefined) throw new Error('Create a bank or import an encrypted backup first')
      const backup = importJson !== undefined ? this.parseBackup(importJson) : stored ? this.parseBackup(stored) : null
      const bankId = backup?.bankId || randomBytes(16).toString('hex')
      const device = this.deps.device()
      const key = await this.derive(bankId)
      try {
        const registry = backup ? this.open(backup, key) : { version: 1 as const, bankId, algorithm: PASSWORD_BANK_ALGORITHM, revision: 0, backedUpRevision: -1, nextSlot: 0, ready: [], profiles: [] }
        this.saveRegistry(JSON.stringify(this.seal(registry, key)), stored)
        this.key = key; this.registry = registry; this.session = device.session; this.deadline = this.now() + SESSION_MS
        return this.view()
      } catch (e) { key.fill(0); throw e }
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
        this.commit(next)
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
    if (!Number.isInteger(minutes) || minutes < 1 || minutes * 60000 > MAX_CACHE_MS) throw new Error('Cache duration must be 1–1440 minutes')
  }
  private put(slot: number, entropy: Buffer, ttlMinutes: number) {
    this.active()
    this.cache.get(slot)?.bytes.fill(0)
    this.cache.set(slot, { bytes: Buffer.from(entropy.toString('base64url').slice(0, 24)), expiresAt: Math.min(this.deadline, this.now() + ttlMinutes * 60000) })
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
    const c = slot === undefined ? undefined : this.cache.get(slot)
    if (!c) throw new Error('Password cache expired. Rehydrate this entry with KeepKey.')
    return { password: c.bytes.toString('utf8'), expiresAt: Math.min(c.expiresAt, this.now() + 30000) }
  }
  rotate(id: string, action: 'prepare' | 'submitted' | 'verify' | 'cancel', confirmed: boolean) {
    const r = this.copy(), p = this.profile(r, id)
    if (action === 'prepare') {
      if (p.pendingSlot !== undefined) throw new Error('Resolve the current rotation first')
      const slot = r.ready.shift()
      if (slot === undefined) throw new Error('Generate a ready password first')
      p.pendingSlot = slot; p.rotationState = 'prepared'
    } else if (action === 'submitted') {
      if (p.rotationState !== 'prepared') throw new Error('Prepare a new password first')
      if (r.backedUpRevision !== r.revision) throw new Error('Export the latest recovery backup before changing the website password')
      p.rotationState = 'submitted'
    } else if (action === 'verify') {
      if (p.rotationState !== 'submitted' || !confirmed || p.pendingSlot === undefined) throw new Error('Confirm a successful sign-in with the new password first')
      this.cache.get(p.slot)?.bytes.fill(0); this.cache.delete(p.slot)
      for (const finding of p.riskFindings || []) if (!finding.resolvedAt && (finding.slot === p.slot || finding.slot === null)) finding.resolvedAt = this.now()
      p.slot = p.pendingSlot; delete p.pendingSlot; p.rotationState = 'active'; p.changedAt = this.now()
    } else if (action === 'cancel') {
      if (p.rotationState !== 'prepared' || p.pendingSlot === undefined) throw new Error('A submitted change must be reconciled; it cannot be discarded')
      this.cache.get(p.pendingSlot)?.bytes.fill(0); this.cache.delete(p.pendingSlot)
      delete p.pendingSlot; p.rotationState = 'active'
    } else throw new Error('Invalid rotation action')
    this.commit(r)
    return this.view()
  }
  reportRisk(id: string, kind: PasswordRiskKind, source: 'user' | 'chrome-password-checkup') {
    if (!['compromised', 'reused', 'weak'].includes(kind) || !['user', 'chrome-password-checkup'].includes(source)) throw new Error('Invalid risk finding')
    const r = this.copy(), p = this.profile(r, id)
    const slot = p.changedAt ? p.slot : null
    const findings = p.riskFindings || []
    if (!findings.some(f => f.kind === kind && f.source === source && f.slot === slot && !f.resolvedAt)) findings.push({ kind, source, slot, mode: 'user-reported', observedAt: this.now() })
    if (findings.length > 100) throw new Error('Risk history is full')
    p.riskFindings = findings
    this.commit(r)
    return this.view()
  }
  exportBackup() {
    const next = this.copy()
    next.backedUpRevision = next.revision
    const json = JSON.stringify(this.seal(next), null, 2)
    // Generating a backup is not proof it was saved. Acknowledge after writing.
    return { json, revision: next.revision }
  }
  acknowledgeBackup(revision: number) {
    const next = this.copy()
    if (revision !== next.revision) throw new Error('The bank changed. Export the latest backup again.')
    next.backedUpRevision = revision
    this.saveRegistry(JSON.stringify(this.seal(next)))
    this.registry = next
    return this.view()
  }
}
