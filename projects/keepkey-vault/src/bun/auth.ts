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

const KEY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_KEYS = 20

export class AuthStore {
  private keys = new Map<string, PairedClient>()
  private accounts = new Map<string, number[]>()
  private pendingPair: { info: PairingInfo; resolve: (apiKey: string) => void; reject: (err: Error) => void } | null = null
  private pendingSigningRequests = new Map<string, { resolve: (ok: boolean) => void; timer: Timer }>()

  /** Queue a pairing request — must be approved via approvePairing() */
  requestPair(info: PairingInfo): Promise<string> {
    if (this.pendingPair) throw { status: 429, message: 'A pairing request is already pending' }
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
    this.keys.set(apiKey, { apiKey, info: { ...info, addedOn: Date.now() } })
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
    this.keys.set(apiKey, { apiKey, info: { ...info, addedOn: Date.now() } })
    return apiKey
  }

  revoke(apiKey: string): boolean {
    return this.keys.delete(apiKey)
  }

  validate(apiKey: string): PairedClient | null {
    const entry = this.keys.get(apiKey)
    if (!entry) return null
    // Expire keys older than TTL
    if (entry.info.addedOn && Date.now() - entry.info.addedOn > KEY_TTL_MS) {
      this.keys.delete(apiKey)
      return null
    }
    return entry
  }

  /** Evict oldest key when at capacity */
  private evictIfFull() {
    if (this.keys.size < MAX_KEYS) return
    // Map iterates in insertion order — first key is oldest
    const oldest = this.keys.keys().next().value
    if (oldest) this.keys.delete(oldest)
  }

  /** Queue a signing request — must be approved/rejected by the user */
  requestSigningApproval(id: string, timeoutMs = 120000): Promise<boolean> {
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
    if (!token) throw { status: 403, message: 'Unauthorized' }
    const entry = this.validate(token)
    if (!entry) throw { status: 403, message: 'Unauthorized' }
    return entry
  }

  saveAccount(address: string, addressNList: number[]): void {
    this.accounts.set(address.toLowerCase(), addressNList)
  }

  getAccount(address: string): { addressNList: number[] } {
    const addressNList = this.accounts.get(address.toLowerCase())
    if (!addressNList) throw { status: 400, message: `Unrecognized address: ${address}` }
    return { addressNList }
  }
}
