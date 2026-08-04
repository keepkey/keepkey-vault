/**
 * BtcAccountManager — manages multi-account BTC xpub lifecycle.
 *
 * Each "account" contains the 3 established xpubs, plus BIP86 when the
 * connected firmware explicitly advertises Taproot support.
 * The user can add accounts (0, 1, 2, …) and select which xpub to use for receive/send.
 */
import { EventEmitter } from 'events'
import { supportedBtcScriptTypes, btcAccountPath, btcScriptTypes } from '../shared/chains'
import type { BtcScriptType, BtcXpub, BtcAccount, BtcAccountSet } from '../shared/types'

export class BtcAccountManager extends EventEmitter {
  private accounts: BtcAccount[] = []
  private selectedXpub: { accountIndex: number; scriptType: BtcScriptType } = { accountIndex: 0, scriptType: 'p2wpkh' }
  private initPromise: Promise<BtcAccountSet> | null = null
  /** Set after getBalances calls updateXpubBalance — prevents getBtcAccounts from stomping live data with stale DB rows. */
  pioneerFetched = false

  /** Initialize account 0 with the device-supported BTC account types. */
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

  /** Fetch supported xpubs for a given account index in a single batch device call. */
  private async fetchAccount(wallet: any, accountIndex: number): Promise<void> {
    // Safety: skip if this account index already exists (prevents race-condition duplicates)
    if (this.accounts.some(a => a.accountIndex === accountIndex)) return

    let scriptTypes = await supportedBtcScriptTypes(wallet)
    const buildPaths = () => scriptTypes.map(st => ({
      addressNList: btcAccountPath(st.purpose, accountIndex),
      coin: 'Bitcoin',
      scriptType: st.scriptType,
      curve: 'secp256k1',
    }))

    let results
    try {
      results = await wallet.getPublicKeys(buildPaths())
    } catch (error: any) {
      const errorCode = error?.code ?? error?.message?.code
      const errorMessage = typeof error?.message === 'string'
        ? error.message
        : error?.message?.message || ''
      const taprootRejected = scriptTypes.some(st => st.scriptType === 'p2tr') &&
        (errorCode === 9 || /invalid combination|script_type/i.test(errorMessage))
      if (!taprootRejected) throw error

      console.warn('[btc-accounts] Firmware rejected Taproot xpub derivation; continuing with established BTC accounts')
      scriptTypes = btcScriptTypes(false)
      results = await wallet.getPublicKeys(buildPaths())
    }

    // Re-check after await (another call may have added it while we were waiting)
    if (this.accounts.some(a => a.accountIndex === accountIndex)) return

    const xpubs: BtcXpub[] = scriptTypes.map((st, i) => ({
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
  getAllPubkeyEntries(btcCaip: string): Array<{ caip: string; pubkey: string; scriptType: BtcScriptType }> {
    const entries: Array<{ caip: string; pubkey: string; scriptType: BtcScriptType }> = []
    for (const account of this.accounts) {
      for (const xp of account.xpubs) {
        if (xp.xpub) entries.push({ caip: btcCaip, pubkey: xp.xpub, scriptType: xp.scriptType })
      }
    }
    return entries
  }

  /** Mark that Pioneer has responded at least once — blocks stale DB re-hydration in getBtcAccounts. */
  markPioneerFetched(): void {
    this.pioneerFetched = true
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

  /** Get ALL xpubs with non-zero balance (for UTXO aggregation in sends/swaps). */
  getFundedXpubs(): Array<{ xpub: string; scriptType: string; accountPath: number[] }> {
    const result: Array<{ xpub: string; scriptType: string; accountPath: number[] }> = []
    for (const account of this.accounts) {
      for (const xp of account.xpubs) {
        if (xp.xpub && parseFloat(xp.balance) > 0) {
          result.push({ xpub: xp.xpub, scriptType: xp.scriptType, accountPath: xp.path })
        }
      }
    }
    const all = this.accounts.flatMap(a => a.xpubs).filter(x => x.xpub)
    console.log(`[btc-accounts] getFundedXpubs: ${result.length}/${all.length} funded — ${all.map(x => `${x.scriptType}=${x.balance}`).join(', ')}`)
    return result
  }

  /** All xpubs across all accounts with derivation metadata — used to seed
   *  own-wallet Address Book entries (R2). Unlike getFundedXpubs() this includes
   *  unfunded xpubs so a fresh wallet still appears in the book. */
  getAllXpubMeta(): Array<{ xpub: string; scriptType: BtcScriptType; accountIndex: number; path: number[] }> {
    const out: Array<{ xpub: string; scriptType: BtcScriptType; accountIndex: number; path: number[] }> = []
    for (const account of this.accounts) {
      for (const xp of account.xpubs) {
        if (xp.xpub) out.push({ xpub: xp.xpub, scriptType: xp.scriptType, accountIndex: account.accountIndex, path: xp.path })
      }
    }
    return out
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
    this.pioneerFetched = false
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
