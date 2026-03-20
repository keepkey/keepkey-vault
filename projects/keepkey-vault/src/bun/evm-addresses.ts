/**
 * EvmAddressManager — manages multi-index EVM address lifecycle.
 *
 * All EVM chains share the same key at a given index (m/44'/60'/0'/0/{index}),
 * so one ethGetAddress call per index covers ETH, Arbitrum, Polygon, etc.
 *
 * Pattern mirrors BtcAccountManager: EventEmitter, init coalescing, settings persistence.
 */
import { EventEmitter } from 'events'
import { getSetting, setSetting } from './db'
import type { EvmTrackedAddress, EvmAddressSet } from '../shared/types'

/** Build an EVM derivation path for a given address index: m/44'/60'/0'/0/{index} */
export function evmAddressPath(index: number): number[] {
  return [0x8000002C, 0x8000003C, 0x80000000, 0, index]
}

const SETTINGS_KEY = 'evm_tracked_indices'

export class EvmAddressManager extends EventEmitter {
  private addresses: EvmTrackedAddress[] = []
  private selectedIndex: number = 0
  private initPromise: Promise<EvmAddressSet> | null = null

  /** Initialize with persisted indices. Concurrent calls coalesce. */
  async initialize(wallet: any): Promise<EvmAddressSet> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInitialize(wallet)
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async _doInitialize(wallet: any): Promise<EvmAddressSet> {
    this.addresses = []

    // Load persisted indices (default to [0])
    const stored = getSetting(SETTINGS_KEY)
    let indices: number[]
    try {
      indices = stored ? JSON.parse(stored) : [0]
      if (!Array.isArray(indices) || indices.length === 0) indices = [0]
    } catch {
      indices = [0]
    }

    // Derive each index
    for (const idx of indices) {
      await this.deriveIndex(wallet, idx)
    }

    // Ensure selectedIndex is valid
    if (!this.addresses.some(a => a.addressIndex === this.selectedIndex)) {
      this.selectedIndex = this.addresses[0]?.addressIndex ?? 0
    }

    const set = this.toAddressSet()
    this.emit('change', set)
    return set
  }

  /** Add a new address index. If index is omitted, uses max+1. */
  async addIndex(wallet: any, index?: number): Promise<EvmAddressSet> {
    const nextIndex = index ?? (this.addresses.length > 0
      ? Math.max(...this.addresses.map(a => a.addressIndex)) + 1
      : 0)

    // Don't add duplicates
    if (this.addresses.some(a => a.addressIndex === nextIndex)) {
      return this.toAddressSet()
    }

    await this.deriveIndex(wallet, nextIndex)
    this.persistIndices()
    const set = this.toAddressSet()
    this.emit('change', set)
    return set
  }

  /** Remove a tracked index (cannot remove index 0). */
  removeIndex(index: number): EvmAddressSet {
    if (index === 0) return this.toAddressSet() // always keep index 0
    this.addresses = this.addresses.filter(a => a.addressIndex !== index)
    if (this.selectedIndex === index) {
      this.selectedIndex = 0
    }
    this.persistIndices()
    const set = this.toAddressSet()
    this.emit('change', set)
    return set
  }

  /** Change the active index for send/receive. */
  setSelectedIndex(index: number): void {
    if (!this.addresses.some(a => a.addressIndex === index)) return
    this.selectedIndex = index
    const set = this.toAddressSet()
    this.emit('change', set)
  }

  /** Get the currently selected EvmTrackedAddress. */
  getSelectedAddress(): EvmTrackedAddress | undefined {
    return this.addresses.find(a => a.addressIndex === this.selectedIndex)
  }

  /**
   * Return all pubkey entries for Pioneer balance lookup.
   * Returns N addresses × M chains entries.
   */
  getAllPubkeyEntries(evmChains: Array<{ caip: string; id: string; symbol: string; networkId: string }>): Array<{
    caip: string; pubkey: string; chainId: string; symbol: string; networkId: string; addressIndex: number
  }> {
    const entries: Array<{ caip: string; pubkey: string; chainId: string; symbol: string; networkId: string; addressIndex: number }> = []
    for (const addr of this.addresses) {
      for (const chain of evmChains) {
        entries.push({
          caip: chain.caip,
          pubkey: addr.address,
          chainId: chain.id,
          symbol: chain.symbol,
          networkId: chain.networkId,
          addressIndex: addr.addressIndex,
        })
      }
    }
    return entries
  }

  /** Update balance for a specific address after Pioneer response. */
  updateAddressBalance(address: string, usd: number): void {
    const lower = address.toLowerCase()
    for (const a of this.addresses) {
      if (a.address.toLowerCase() === lower) {
        a.balanceUsd += usd
        break
      }
    }
  }

  /** Reset all address balances to 0 (call before portfolio refresh). */
  resetBalances(): void {
    for (const a of this.addresses) {
      a.balanceUsd = 0
    }
  }

  /**
   * Auto-discover balance-bearing addresses by scanning indices 0–maxIndex.
   * Derives each address, checks Pioneer for non-zero balance, and auto-adds any with funds.
   * Call once after initial balance fetch to expand tracked addresses.
   */
  async autoDiscover(
    wallet: any,
    pioneer: any,
    evmChains: Array<{ caip: string; id: string; symbol: string; networkId: string }>,
    maxIndex = 9,
  ): Promise<{ discovered: number[] }> {
    const discovered: number[] = []
    const existingIndices = new Set(this.addresses.map(a => a.addressIndex))

    for (let idx = 0; idx <= maxIndex; idx++) {
      if (existingIndices.has(idx)) continue

      // Derive address without persisting yet
      const path = evmAddressPath(idx)
      let address: string
      try {
        const result = await wallet.ethGetAddress({ addressNList: path, showDisplay: false, coin: 'Ethereum' })
        address = typeof result === 'string' ? result : result?.address
        if (!address) continue
      } catch { continue }

      // Check if any EVM chain has a balance for this address
      const pubkeys = evmChains.map(c => ({ caip: c.caip, pubkey: address }))
      try {
        const resp = await pioneer.GetPortfolioBalances({ pubkeys }, { forceRefresh: true })
        const balances = resp?.data?.balances || resp?.data || []
        const hasBalance = (Array.isArray(balances) ? balances : []).some(
          (b: any) => parseFloat(String(b?.balance ?? '0')) > 0 || Number(b?.valueUsd ?? 0) > 0,
        )
        if (hasBalance) {
          // Add this index permanently
          this.addresses.push({ addressIndex: idx, address, balanceUsd: 0 })
          this.addresses.sort((a, b) => a.addressIndex - b.addressIndex)
          discovered.push(idx)
        }
      } catch { continue }
    }

    if (discovered.length > 0) {
      this.persistIndices()
      const set = this.toAddressSet()
      this.emit('change', set)
    }

    return { discovered }
  }

  /** Reset session state on disconnect. Persisted indices are NOT cleared. */
  reset(): void {
    this.addresses = []
    this.selectedIndex = 0
    this.initPromise = null
  }

  get isInitialized(): boolean {
    return this.addresses.length > 0
  }

  toAddressSet(): EvmAddressSet {
    return {
      addresses: this.addresses.map(a => ({ ...a })),
      selectedIndex: this.selectedIndex,
      totalBalanceUsd: this.addresses.reduce((sum, a) => sum + a.balanceUsd, 0),
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async deriveIndex(wallet: any, index: number): Promise<void> {
    if (this.addresses.some(a => a.addressIndex === index)) return

    const path = evmAddressPath(index)
    const result = await wallet.ethGetAddress({
      addressNList: path,
      showDisplay: false,
      coin: 'Ethereum',
    })
    const address = typeof result === 'string' ? result : result?.address
    if (!address) throw new Error(`ethGetAddress returned empty for index ${index}`)

    // Re-check after await
    if (this.addresses.some(a => a.addressIndex === index)) return

    this.addresses.push({ addressIndex: index, address, balanceUsd: 0 })
    // Keep sorted by index
    this.addresses.sort((a, b) => a.addressIndex - b.addressIndex)
  }

  private persistIndices(): void {
    const indices = this.addresses.map(a => a.addressIndex)
    setSetting(SETTINGS_KEY, JSON.stringify(indices))
  }
}
