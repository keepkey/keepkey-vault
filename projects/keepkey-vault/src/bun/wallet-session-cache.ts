/** REST derivation results belong to a wallet session, not just its hardware ID. */
export interface WalletCacheSource {
  wallet: unknown
  readonly currentSeedEthAddress: string | null
  getDeviceState(): { deviceId?: string; state: string }
  on(event: string, listener: (...args: any[]) => void): unknown
}

export class WalletSessionChangedError extends Error {
  readonly status = 409
  constructor() {
    super('Wallet changed during request. Retry with the current wallet.')
  }
}

export class WalletCacheSession {
  private generation = 0
  private source: WalletCacheSource | null = null
  private identity: { wallet: unknown; deviceId?: string; seed: string | null } | null = null
  private caches = new Set<Map<string, unknown>>()
  private onInvalidate = () => {}

  bind(source: WalletCacheSource, onInvalidate = () => {}): void {
    this.source = source
    this.onInvalidate = onInvalidate
    this.identity = null
    this.invalidate()
    this.syncIdentity()
    let lastState = source.getDeviceState().state
    source.on('state-change', (state: { state: string }) => {
      if (this.source !== source) return
      if (state.state !== lastState && ['disconnected', 'needs_passphrase', 'needs_init'].includes(state.state)) {
        this.invalidate()
      }
      lastState = state.state
      this.syncIdentity()
    })
    // Hidden -> standard wallets can keep the hardware ID and do not always
    // emit seed-changed. Scope-ready reports both standard and hidden wallets.
    for (const event of ['wallet-scope-ready', 'seed-changed']) {
      source.on(event, () => {
        if (this.source === source) this.syncIdentity()
      })
    }
  }

  register(cache: Map<string, unknown>): void { this.caches.add(cache) }

  invalidate(): void {
    this.generation++
    for (const cache of this.caches) cache.clear()
    this.onInvalidate()
  }

  private syncIdentity(): void {
    if (!this.source) return
    const next = {
      wallet: this.source.wallet,
      deviceId: this.source.getDeviceState().deviceId,
      seed: this.source.currentSeedEthAddress?.toLowerCase() || null,
    }
    if (!this.identity || next.wallet !== this.identity.wallet || next.deviceId !== this.identity.deviceId || next.seed !== this.identity.seed) {
      this.identity = next
      this.invalidate()
    }
  }

  key(prefix: string, body: unknown): string {
    this.syncIdentity()
    return `${this.generation}:${prefix}:${JSON.stringify(body)}`
  }

  assertCurrent(key: string): void {
    // Check the live identity too: a derivation can complete between engine
    // state updates, and must never refill a cache invalidated while it awaited.
    this.syncIdentity()
    if (!key.startsWith(`${this.generation}:`)) throw new WalletSessionChangedError()
  }
}

export class WalletSessionMap<T> extends Map<string, T> {
  constructor(private readonly session: WalletCacheSession, private readonly limit = 500) {
    super()
    session.register(this)
  }

  override get(key: string): T | undefined {
    this.session.assertCurrent(key)
    return super.get(key)
  }

  override set(key: string, value: T): this {
    this.session.assertCurrent(key)
    // Check the epoch before evicting too: a late old-wallet result must not
    // remove entries belonging to the current wallet from a full cache.
    if (!super.has(key) && this.size >= this.limit) {
      let remaining = Math.ceil(this.limit * 0.2)
      for (const oldest of this.keys()) {
        this.delete(oldest)
        if (--remaining <= 0) break
      }
    }
    return super.set(key, value)
  }
}
