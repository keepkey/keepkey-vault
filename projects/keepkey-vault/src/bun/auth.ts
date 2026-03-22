import { getStoredPairings, storePairing, removePairing, clearPairings } from './db'
import type { PairedAppInfo } from '../shared/types'

/** HTTP-aware error with status code — caught by rest-api error handler */
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface PairingInfo {
  name: string
  url: string
  imageUrl: string
  addedOn?: number
}

interface PairedClient {
  apiKey: string
  info: PairingInfo
}

const MAX_KEYS = 20
/** API key TTL: 30 days in milliseconds */
const KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class AuthStore {
  private keys = new Map<string, PairedClient>()
  private accounts = new Map<string, number[]>()
  private pendingPair: { info: PairingInfo; resolve: (apiKey: string) => void; reject: (err: Error) => void } | null = null
  private pendingSigningRequests = new Map<string, { resolve: (ok: boolean) => void; timer: Timer }>()

  constructor() {
    this.reloadPairings()
  }

  /** Reload persisted pairings from DB. Safe to call multiple times. */
  reloadPairings() {
    try {
      const stored = getStoredPairings()
      for (const row of stored) {
        if (!this.keys.has(row.apiKey)) {
          this.keys.set(row.apiKey, {
            apiKey: row.apiKey,
            info: { name: row.name, url: row.url, imageUrl: row.imageUrl, addedOn: row.addedOn },
          })
        }
      }
      if (stored.length) console.log(`[auth] Loaded ${stored.length} persisted pairings`)
    } catch {
      // Expected before DB init — silent
    }
  }

  /** Queue a pairing request — must be approved via approvePairing() */
  requestPair(info: PairingInfo): Promise<string> {
    if (this.pendingPair) throw new HttpError(429, 'A pairing request is already pending')
    return new Promise((resolve, reject) => {
      this.pendingPair = { info, resolve, reject }
      // Auto-reject after 60s if not approved
      setTimeout(() => {
        if (this.pendingPair?.info === info) {
          this.pendingPair = null
          reject(new Error('Pairing request timed out'))
        }
      }, 60000)
    })
  }

  getPendingPair(): PairingInfo | null {
    return this.pendingPair?.info ?? null
  }

  approvePairing(): string | null {
    if (!this.pendingPair) return null
    this.evictIfFull()
    const apiKey = crypto.randomUUID()
    const { info, resolve } = this.pendingPair
    const enriched = { ...info, addedOn: Date.now() }
    this.keys.set(apiKey, { apiKey, info: enriched })
    storePairing(apiKey, { name: enriched.name, url: enriched.url, imageUrl: enriched.imageUrl, addedOn: enriched.addedOn! })
    this.pendingPair = null
    resolve(apiKey)
    return apiKey
  }

  rejectPairing(): void {
    if (!this.pendingPair) return
    this.pendingPair.reject(new Error('Pairing rejected by user'))
    this.pendingPair = null
  }

  /** Direct pair — only for internal/trusted callers (NOT exposed via REST) */
  pair(info: PairingInfo): string {
    this.evictIfFull()
    const apiKey = crypto.randomUUID()
    const enriched = { ...info, addedOn: Date.now() }
    this.keys.set(apiKey, { apiKey, info: enriched })
    storePairing(apiKey, { name: enriched.name, url: enriched.url, imageUrl: enriched.imageUrl, addedOn: enriched.addedOn! })
    return apiKey
  }

  revoke(apiKey: string): boolean {
    const deleted = this.keys.delete(apiKey)
    if (deleted) removePairing(apiKey)
    return deleted
  }

  revokeAll(): void {
    this.keys.clear()
    clearPairings()
  }

  validate(apiKey: string): PairedClient | null {
    // Constant-time scan: iterate all keys to prevent timing-based key guessing.
    // Map.get() would return faster for misses, leaking whether a prefix matches.
    let found: PairedClient | null = null
    for (const [storedKey, entry] of this.keys) {
      if (storedKey.length === apiKey.length && this.timingSafeEqual(storedKey, apiKey)) {
        found = entry
      }
    }
    if (!found) return null
    // Check TTL — expire keys older than 30 days.
    // Legacy pairings without addedOn are treated as expired (fail-closed)
    // to prevent permanently grandfathered trust.
    const addedOn = found.info.addedOn
    if (!addedOn || Date.now() - addedOn > KEY_TTL_MS) {
      this.keys.delete(apiKey)
      removePairing(apiKey)
      return null
    }
    return found
  }

  /** Constant-time string comparison to prevent timing attacks */
  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    // Use Bun's crypto.timingSafeEqual (Node-compatible)
    try {
      return require('crypto').timingSafeEqual(bufA, bufB)
    } catch {
      // Fallback: constant-time XOR comparison
      let result = 0
      for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i]
      return result === 0
    }
  }

  /** Evict oldest key when at capacity */
  private evictIfFull() {
    if (this.keys.size < MAX_KEYS) return
    // Map iterates in insertion order — first key is oldest
    const oldest = this.keys.keys().next().value
    if (oldest) {
      this.keys.delete(oldest)
      removePairing(oldest)
    }
  }

  /** Queue a signing request — must be approved/rejected by the user */
  requestSigningApproval(id: string, timeoutMs = 120000): Promise<boolean> {
    // Cap pending requests to prevent memory exhaustion
    if (this.pendingSigningRequests.size >= 50) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSigningRequests.delete(id)
        resolve(false)
      }, timeoutMs)
      this.pendingSigningRequests.set(id, { resolve, timer })
    })
  }

  approveSigningRequest(id: string): boolean {
    const entry = this.pendingSigningRequests.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pendingSigningRequests.delete(id)
    entry.resolve(true)
    return true
  }

  rejectSigningRequest(id: string): boolean {
    const entry = this.pendingSigningRequests.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pendingSigningRequests.delete(id)
    entry.resolve(false)
    return true
  }

  extractBearerToken(req: Request): string | null {
    const header = req.headers.get('Authorization')
    if (!header) return null
    const match = header.match(/^Bearer\s+(.+)$/i)
    return match ? match[1] : null
  }

  requireAuth(req: Request): PairedClient {
    const token = this.extractBearerToken(req)
    if (!token) throw new HttpError(401, 'No bearer token — pair first via POST /auth/pair')
    const entry = this.validate(token)
    if (!entry) throw new HttpError(401, 'Invalid or expired API key — re-pair via POST /auth/pair')
    return entry
  }

  /** List all currently paired apps with their API keys */
  listPairedApps(): PairedAppInfo[] {
    const result: PairedAppInfo[] = []
    for (const [apiKey, entry] of this.keys) {
      result.push({
        apiKey,
        name: entry.info.name,
        url: entry.info.url,
        imageUrl: entry.info.imageUrl,
        addedOn: entry.info.addedOn || 0,
      })
    }
    return result
  }

  /** Resolve imageUrl for a bearer token (returns empty string if not paired) */
  resolveImageUrl(req: Request): string {
    const token = this.extractBearerToken(req)
    if (!token) return ''
    const entry = this.validate(token)
    return entry?.info?.imageUrl || ''
  }

  saveAccount(address: string, addressNList: number[]): void {
    this.accounts.set(address.toLowerCase(), addressNList)
  }

  getAccount(address: string): { addressNList: number[] } {
    const addressNList = this.accounts.get(address.toLowerCase())
    if (!addressNList) throw new HttpError(400, `Unrecognized address: ${address}`)
    return { addressNList }
  }
}
