/**
 * BtcAccountManager — manages multi-account BTC xpub lifecycle.
 *
 * Each "account" contains 3 xpubs (Legacy/SegWit/NativeSegWit).
 * The user can add accounts (0, 1, 2, …) and select which xpub to use for receive/send.
 */
import { EventEmitter } from 'events'
import { BTC_SCRIPT_TYPES, btcAccountPath } from '../shared/chains'
import type { BtcScriptType, BtcXpub, BtcAccount, BtcAccountSet } from '../shared/types'

export class BtcAccountManager extends EventEmitter {
  private accounts: BtcAccount[] = []
  private selectedXpub: { accountIndex: number; scriptType: BtcScriptType } = { accountIndex: 0, scriptType: 'p2wpkh' }
  private initPromise: Promise<BtcAccountSet> | null = null

  /** Initialize account 0 with 3 xpubs from the device. Concurrent calls coalesce into one. */
  async initialize(wallet: any): Promise<BtcAccountSet> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInitialize(wallet)
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async _doInitialize(wallet: any): Promise<BtcAccountSet> {
    this.accounts = []
    this.selectedXpub = { accountIndex: 0, scriptType: 'p2wpkh' }
    await this.fetchAccount(wallet, 0)
    const set = this.toAccountSet()
    this.emit('change', set)
    return set
  }

  /** Add the next account (N+1). */
  async addAccount(wallet: any): Promise<BtcAccountSet> {
    const nextIndex = this.accounts.length
    await this.fetchAccount(wallet, nextIndex)
    const set = this.toAccountSet()
    this.emit('change', set)
    return set
  }

  /** Fetch 3 xpubs for a given account index in a single batch device call. */
  private async fetchAccount(wallet: any, accountIndex: number): Promise<void> {
    // Safety: skip if this account index already exists (prevents race-condition duplicates)
    if (this.accounts.some(a => a.accountIndex === accountIndex)) return

    const paths = BTC_SCRIPT_TYPES.map(st => ({
      addressNList: btcAccountPath(st.purpose, accountIndex),
      coin: 'Bitcoin',
      scriptType: st.scriptType,
      curve: 'secp256k1',
    }))

    const results = await wallet.getPublicKeys(paths)

    // Re-check after await (another call may have added it while we were waiting)
    if (this.accounts.some(a => a.accountIndex === accountIndex)) return

    const xpubs: BtcXpub[] = BTC_SCRIPT_TYPES.map((st, i) => ({
      scriptType: st.scriptType,
      purpose: st.purpose,
      path: btcAccountPath(st.purpose, accountIndex),
      xpub: results?.[i]?.xpub || '',
      xpubPrefix: st.xpubPrefix,
      balance: '0',
      balanceUsd: 0,
    }))

    this.accounts.push({
      accountIndex,
      xpubs,
      totalBalanceUsd: 0,
    })
  }

  /** Return all pubkey entries for Pioneer balance lookup (all xpubs across all accounts). */
  getAllPubkeyEntries(btcCaip: string): Array<{ caip: string; pubkey: string }> {
    const entries: Array<{ caip: string; pubkey: string }> = []
    for (const account of this.accounts) {
      for (const xp of account.xpubs) {
        if (xp.xpub) entries.push({ caip: btcCaip, pubkey: xp.xpub })
      }
    }
    return entries
  }

  /** Update a specific xpub's balance after Pioneer response. */
  updateXpubBalance(xpubStr: string, balance: string, balanceUsd: number): void {
    for (const account of this.accounts) {
      for (const xp of account.xpubs) {
        if (xp.xpub === xpubStr) {
          xp.balance = balance
          xp.balanceUsd = balanceUsd
          break
        }
      }
      // Recalculate account total
      account.totalBalanceUsd = account.xpubs.reduce((sum, x) => sum + x.balanceUsd, 0)
    }
  }

  /** Get the currently selected BtcXpub object. */
  getSelectedXpub(): BtcXpub | undefined {
    const account = this.accounts.find(a => a.accountIndex === this.selectedXpub.accountIndex)
    return account?.xpubs.find(x => x.scriptType === this.selectedXpub.scriptType)
  }

  /** Change the selected xpub. */
  setSelectedXpub(accountIndex: number, scriptType: BtcScriptType): void {
    this.selectedXpub = { accountIndex, scriptType }
    const set = this.toAccountSet()
    this.emit('change', set)
  }

  /** Reset on device disconnect. */
  reset(): void {
    this.accounts = []
    this.selectedXpub = { accountIndex: 0, scriptType: 'p2wpkh' }
    this.initPromise = null
  }

  /** Whether accounts have been initialized. */
  get isInitialized(): boolean {
    return this.accounts.length > 0
  }

  /** Build the full BtcAccountSet snapshot. */
  toAccountSet(): BtcAccountSet {
    const totalBalanceUsd = this.accounts.reduce((sum, a) => sum + a.totalBalanceUsd, 0)
    // Sum all xpub balances (as strings) into a total BTC balance
    let totalSats = 0
    for (const account of this.accounts) {
      for (const xp of account.xpubs) {
        totalSats += parseFloat(xp.balance) || 0
      }
    }
    return {
      accounts: this.accounts,
      totalBalanceUsd,
      totalBalance: totalSats > 0 ? totalSats.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '0',
      selectedXpub: { ...this.selectedXpub },
    }
  }
}
