import type { ElectrobunRPCSchema } from 'electrobun/bun'
import type { DeviceStateInfo, FirmwareProgress, FirmwareAnalysis, FatalEvent, PinRequest, CharacterRequest, ChainBalance, BuildTxParams, BuildTxResult, BroadcastResult, BtcAccountSet, BtcScriptType, EvmAddressSet, CustomToken, CustomChain, AppSettings, PioneerServer, BtcGetAddressParams, EthGetAddressParams, EthSignTxParams, BtcSignTxParams, GetPublicKeysParams, UpdateInfo, UpdateStatus, TokenVisibilityStatus, PairingRequestInfo, PairedAppInfo, SigningRequestInfo, ApiLogEntry, PioneerChainInfo, ReportMeta, ReportData, AuditReport, AuditPortfolioSnapshot, AuditMode, AuditDerivedAddress, AuditInspectResult, SwapAsset, SwapQuote, SwapQuoteParams, ExecuteSwapParams, SwapResult, SwapHealth, PendingSwap, SwapStatusUpdate, SwapHistoryRecord, SwapHistoryFilter, SwapHistoryStats, SwapUiState, SwapUiCommand, RecentActivity, BuildStakingTxParams, StakingPosition, DefiPosition, NameInfo, NameQuote, BuildNameRegTxParams, ZcashTransaction, EmulatorStatus, EmulatorWalletInfo, RegisteredDevice, WcSessionInfo, AddressBookEntry, AddressBookFilter, AddressBookTx, UsbDiagnosticReport, ClearSignEvent, ClearSignSolanaSchemaArtifact, ClearSignSolanaSchemaDraft } from './types'

/**
 * RPC Schema for Bun ↔ WebView communication.
 *
 * - bun.requests: Methods the WebView can call on Bun (incoming to Bun)
 * - bun.messages: Messages Bun sends to the WebView (outgoing from Bun)
 * - webview.requests: Methods Bun can call on WebView (incoming to WebView)
 * - webview.messages: Messages WebView sends to Bun (outgoing from WebView)
 */
export type VaultRPCSchema = ElectrobunRPCSchema & {
  bun: {
    requests: {
      // ── Device lifecycle ──────────────────────────────────────────
      getDeviceState: { params: void; response: DeviceStateInfo }
      retryConnect: { params: void; response: void }
      startBootloaderUpdate: { params: void; response: void }
      startFirmwareUpdate: { params: { bitcoinOnly?: boolean }; response: void }
      flashFirmware: { params: void; response: void }
      analyzeFirmware: { params: { data: string }; response: FirmwareAnalysis }
      flashCustomFirmware: { params: { data: string }; response: void }
      resetDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      recoverDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      loadDevice: { params: { mnemonic: string; pin?: string; passphrase?: boolean; label?: string }; response: void }
      verifySeed: { params: { wordCount: 12 | 18 | 24 }; response: { success: boolean; message: string } }
      verifySeedChallenge: { params: void; response: { positions: number[]; wordCount: number } }
      verifySeedSubmit: { params: { answers: { position: number; word: string }[] }; response: { success: boolean; message: string } }
      applySettings: { params: { label?: string; usePassphrase?: boolean; autoLockDelayMs?: number }; response: void }
      applyPolicy: { params: { policyName: string; enabled: boolean }; response: void }
      changePin: { params: void; response: void }
      removePin: { params: void; response: void }
      sendPin: { params: { pin: string }; response: void }
      sendPassphrase: { params: { passphrase: string }; response: void }
      sendCharacter: { params: { character: string }; response: void }
      sendCharacterDelete: { params: void; response: void }
      sendCharacterDone: { params: void; response: void }

      // ── Wallet operations (hdwallet pass-through) ─────────────────
      getFeatures: { params: void; response: any }
      ping: { params: { msg?: string }; response: any }
      // Advanced-mode developer surface for creating and loading RAM-only
      // ClearSign identities. No endpoint persists a trust anchor.
      clearsignGetStudioStatus: { params: void; response: { advancedMode: boolean; firmwareVersion?: string } }
      clearsignAttestorGetPublicKey: { params: void; response: { publicKey: string; fingerprint: string } }
      clearsignBuildSolanaSchema: { params: ClearSignSolanaSchemaDraft; response: ClearSignSolanaSchemaArtifact }
      clearsignInspectSolanaSchema: { params: { payload: string }; response: ClearSignSolanaSchemaArtifact }
      clearsignAttestorSign: { params: { payload: string }; response: { payload: string; signature: string; publicKey: string; fingerprint: string; eventId: string } }
      clearsignLoadSessionSigner: { params: { keyId: number; publicKey: string; alias: string }; response: { ok: true; keyId: number; alias: string; fingerprint: string; eventId: string } }
      clearsignListEvents: { params: { limit?: number; outcome?: ClearSignEvent['outcome']; scope?: 'current-device' | 'all' } | void; response: ClearSignEvent[] }
      // Open a URL in the user's default browser (escapes the WebView).
      // The system WebView blocks target=_blank, so explorer/docs links
      // route through here instead. Bun shells out to the OS-native opener.
      openExternal: { params: { url: string }; response: { ok: true } }
      wipeDevice: { params: void; response: any }
      // Sends a Cancel message to the device — aborts whatever confirm/PIN/
      // passphrase prompt is on screen and frees the transport lock so the
      // user can back out of an in-flight signing flow without unplugging.
      cancelDeviceSigning: { params: void; response: { ok: boolean } }
      // Types defined in types.ts: GetPublicKeysParams, BtcGetAddressParams, EthGetAddressParams, EthSignTxParams, BtcSignTxParams
      getPublicKeys: { params: any; response: any }

      // ── Address derivation ────────────────────────────────────────
      btcGetAddress: { params: any; response: any }
      ethGetAddress: { params: any; response: any }
      cosmosGetAddress: { params: any; response: any } // TODO: type
      thorchainGetAddress: { params: any; response: any } // TODO: type
      mayachainGetAddress: { params: any; response: any } // TODO: type
      osmosisGetAddress: { params: any; response: any } // TODO: type
      xrpGetAddress: { params: any; response: any } // TODO: type
      solanaGetAddress: { params: any; response: any }
      tronGetAddress: { params: any; response: any }
      tonGetAddress: { params: any; response: any }

      // ── Transaction signing ───────────────────────────────────────
      btcSignTx: { params: any; response: any }
      ethSignTx: { params: any; response: any }
      ethSignMessage: { params: any; response: any } // TODO: type
      ethSignTypedData: { params: any; response: any } // TODO: type
      ethVerifyMessage: { params: any; response: any } // TODO: type
      cosmosSignTx: { params: any; response: any } // TODO: type
      thorchainSignTx: { params: any; response: any } // TODO: type
      mayachainSignTx: { params: any; response: any } // TODO: type
      osmosisSignTx: { params: any; response: any } // TODO: type
      xrpSignTx: { params: any; response: any } // TODO: type
      solanaSignTx: { params: any; response: any }
      solanaSignOffchainMessage: { params: any; response: any }
      tronSignTx: { params: any; response: any }
      tronSignMessage: { params: any; response: any }
      tronVerifyMessage: { params: any; response: any }
      tronSignTypedHash: { params: any; response: any }
      tonSignTx: { params: any; response: any }
      tonSignMessage: { params: any; response: any }
      hiveGetPublicKey: { params: any; response: any }
      hiveGetRoleKeys: { params: { accountIndex?: number }; response: { owner: string; active: string; posting: string; memo: string } }
      hiveGetAccount: { params: { pubkey: string }; response: { success?: boolean; noAccount?: boolean; account?: { name: string; hive: string; hbd: string; hp?: string; rcPercent?: number } } }
      hiveUsernameAvailable: { params: { name: string }; response: { success: boolean; available: boolean; reason?: string } }
      hiveCreateAccount: { params: { username: string; accountIndex?: number }; response: { status: number; success?: boolean; txid?: string; username?: string; error?: string; retryAfter?: number } }
      hiveSignTx: { params: any; response: any }

      // ── Pioneer integration ─────────────────────────────────────────
      getBalances: { params: { forceRefresh?: boolean; swapDestCaips?: string[] }; response: ChainBalance[] }
      /** forceRefresh defaults to TRUE (user-clicked refresh / tx pushes must bypass
       *  Pioneer's cache). Pass false only when Pioneer's cache is known-fresh. */
      getBalance: { params: { chainId: string; forceRefresh?: boolean }; response: ChainBalance }
      buildTx: { params: BuildTxParams; response: BuildTxResult }
      // `to`/`amount`/`symbol`/`caip`/`fromAddress` populate the Address Book
      // (R3/R4/R7). `fromAddress` is also required when broadcasting a custom
      // EVM chain so the recovered signer is checked against the signed request
      // rather than mutable UI selection.
      broadcastTx: { params: { chainId: string; signedTx: any; to?: string; amount?: string; fee?: string; symbol?: string; caip?: string; fromAddress?: string }; response: BroadcastResult }

      // ── DeFi positions (Zapper) ──────────────────────────────────────
      getDefiPositions: { params: { address: string }; response: DefiPosition[] }

      // ── Staking / delegation ─────────────────────────────────────────
      getStakingPositions: { params: { chainId: string; address: string }; response: StakingPosition[] }
      buildDelegateTx: { params: BuildStakingTxParams; response: BuildTxResult }
      buildUndelegateTx: { params: BuildStakingTxParams; response: BuildTxResult }

      // ── THORName / MAYAName registration ──────────────────────────────
      lookupName: { params: { chainId: string; name: string }; response: NameInfo }
      getNameQuote: { params: { chainId: string }; response: NameQuote }
      buildNameRegistrationTx: { params: BuildNameRegTxParams; response: BuildTxResult }

      getMarketData: { params: { caips: string[] }; response: any }
      getFees: { params: { chainId: string }; response: any }

      // ── Bitcoin multi-account ─────────────────────────────────────────
      getBtcAccounts: { params: void; response: BtcAccountSet }
      addBtcAccount: { params: void; response: BtcAccountSet }
      setBtcSelectedXpub: { params: { accountIndex: number; scriptType: BtcScriptType }; response: void }
      getBtcAddressIndices: { params: { xpub: string }; response: { receiveIndex: number; changeIndex: number } }

      // ── UTXO altcoin multi-account (LTC/DOGE/DASH/…) ───────────────────
      // Persist a discovered account's xpubs to the device-scoped pubkey cache
      // so funds beyond account 0 show + spend across reconnect. Non-BTC only
      // (Bitcoin uses the in-memory BtcAccountManager).
      addUtxoAccount: { params: { chainId: string; level: number }; response: { saved: number; account: number } }
      // Tracked account indices for a non-BTC UTXO chain: 0 plus anything
      // persisted via addUtxoAccount (asset-page "+" or audit "track").
      getUtxoAccounts: { params: { chainId: string }; response: { accounts: number[] } }

      // ── EVM multi-address ──────────────────────────────────────────────
      getEvmAddresses: { params: void; response: EvmAddressSet }
      addEvmAddressIndex: { params: { index?: number }; response: EvmAddressSet }
      removeEvmAddressIndex: { params: { index: number }; response: EvmAddressSet }
      setEvmSelectedIndex: { params: { index: number }; response: void }

      // ── Chain discovery (Pioneer catalog) ──────────────────────────────────
      browseChains: { params: { query?: string; page?: number; pageSize?: number }; response: { chains: PioneerChainInfo[]; total: number; page: number; pageSize: number } }

      // ── Custom tokens & chains ──────────────────────────────────────────
      addCustomToken: { params: { chainId: string; contractAddress: string }; response: CustomToken }
      removeCustomToken: { params: { chainId: string; contractAddress: string }; response: void }
      getCustomTokens: { params: void; response: CustomToken[] }
      setCustomTokenIcon: { params: { chainId: string; contractAddress: string; iconUrl: string }; response: CustomToken }
      addCustomChain: { params: CustomChain; response: void }
      removeCustomChain: { params: { chainId: number }; response: void }
      getCustomChains: { params: void; response: CustomChain[] }

      // ── Token visibility (spam filter) ──────────────────────────────────
      setTokenVisibility: { params: { caip: string; status: TokenVisibilityStatus }; response: void }
      removeTokenVisibility: { params: { caip: string }; response: void }
      getTokenVisibilityMap: { params: void; response: Record<string, TokenVisibilityStatus> }

      // ── Zcash Shielded (Orchard) ──────────────────────────────────────
      zcashShieldedStatus: { params: void; response: { ready: boolean; fvk_loaded: boolean; address: string | null; fvk: { ak: string; nk: string; rivk: string } | null; synced_to: number | null; keepkey_release_block: number | null; verified: boolean; synced: boolean; verifying: boolean } }
      zcashShieldedInit: { params: { account?: number }; response: { fvk: { ak: string; nk: string; rivk: string }; address: string } }
      zcashShieldedScan: { params: { startHeight?: number; fullRescan?: boolean }; response: { balance: number; notes_found: number; synced_to: number } }
      zcashShieldedBalance: { params: void; response: { confirmed: number; pending: number; synced_to?: number | null; notes_total?: number; notes_unspent?: number; keepkey_release_block?: number } }
      zcashShieldedSend: { params: { recipient: string; amount: number; memo?: string }; response: { txid: string } }
      zcashShieldZec: { params: { amount: number; account?: number }; response: { txid: string } }
      // Confirmed UTXO total at the user's first-receive t-addr — the only address
      // shieldZec sweeps. Use this (not chain-level getBalance, which sums the
      // whole xpub) to power the Shield page's Available / Max button.
      // - balanceZat = mature only (≥10 conf, what shieldZec can actually spend)
      // - pendingZat = under 10 conf, surfaced so the UI can explain a
      //   discrepancy between the chain-level balance and what's shieldable
      zcashTransparentBalance: {
        params: { account?: number } | void
        response: { address: string; balanceZat: number; pendingZat: number; matureCount: number; pendingCount: number }
      }
      zcashDeshieldZec: { params: { recipient: string; amount: number; account?: number }; response: { txid: string } }
      // Read-only diagnostic: does the cached shielded balance belong to the
      // connected device? `match: false` ⇒ stale/other-wallet, not spendable here.
      zcashVerifyDevice: { params: { account?: number } | void; response: { match: boolean; deviceAk: string; cachedAk: string | null; cachedAddress: string | null; message: string } }
      zcashGetTransactions: { params: void; response: { transactions: ZcashTransaction[] } }
      zcashBackfillMemos: { params: void; response: { backfilled: number } }
      // Ask the device to derive and display its Orchard UA for this account.
      // No host-cached UA or FVK material is sent for this display flow.
      zcashDisplayAddress: { params: { account?: number }; response: { address: string } }

      // ── Pairing & Signing approval ───────────────────────────────────
      approvePairing: { params: void; response: { apiKey: string } }
      rejectPairing: { params: void; response: void }
      approveSigningRequest: { params: { id: string; allowBlindSigning?: boolean }; response: void }
      rejectSigningRequest: { params: { id: string }; response: void }
      listPairedApps: { params: void; response: PairedAppInfo[] }
      revokePairing: { params: { apiKey: string }; response: void }

      // ── Mobile pairing (via vault.keepkey.com relay) ─────────────────
      generateMobilePairing: { params: void; response: { code: string; expiresAt: number; expiresIn: number; qrPayload: string } }

      // ── API Audit Log ──────────────────────────────────────────────────
      getApiLogs: { params: { limit?: number; offset?: number } | void; response: ApiLogEntry[] }
      clearApiLogs: { params: void; response: void }

      // ── Window Focus ──────────────────────────────────────────────────
      getWindowFocusState: { params: void; response: { refs: number; alwaysOnTop: boolean } }
      forceReleaseWindowFocus: { params: void; response: void }
      setWindowAlwaysOnTop: { params: { enabled: boolean }; response: void }

      // ── App Settings ──────────────────────────────────────────────────
      getAppSettings: { params: void; response: AppSettings }
      markPassphraseIntroShown: { params: void; response: AppSettings }
      markBtcOnboardingShown: { params: void; response: AppSettings }
      setRestApiEnabled: { params: { enabled: boolean }; response: AppSettings }
      setPioneerApiBase: { params: { url: string }; response: AppSettings }
      setFiatCurrency: { params: { currency: string }; response: AppSettings }
      setNumberLocale: { params: { locale: string }; response: AppSettings }
      setWalletConnectEnabled: { params: { enabled: boolean }; response: AppSettings }
      setOfflineMode: { params: { enabled: boolean }; response: AppSettings }
      setBtcNode: { params: { enabled: boolean; type: 'blockbook' | 'core'; url: string; rpcUser?: string; rpcPass?: string }; response: AppSettings }
      testBtcNode: { params: { type: 'blockbook' | 'core'; url: string; rpcUser?: string; rpcPass?: string }; response: { ok: boolean; error?: string; chain?: string; blocks?: number; pruned?: boolean; txindex?: boolean; inSync?: boolean; detectedType?: 'blockbook' | 'core' } }
      getBtcNodeStatus: { params: void; response: { active: boolean; kind?: 'blockbook' | 'core'; ok?: boolean; error?: string; height?: number; headers?: number; syncing?: boolean; progress?: number } }
      setBip85Enabled: { params: { enabled: boolean }; response: AppSettings }
      setZcashPrivacyEnabled: { params: { enabled: boolean }; response: AppSettings }
      setHiveEnabled: { params: { enabled: boolean }; response: AppSettings }
      setEmulatorEnabled: { params: { enabled: boolean }; response: AppSettings }
      setPreReleaseUpdates: { params: { enabled: boolean }; response: AppSettings }
      setAlphaFirmware: { params: { enabled: boolean }; response: AppSettings }
      setPrivateModeEnabled: { params: { enabled: boolean }; response: AppSettings }
      addPioneerServer: { params: { url: string; label: string }; response: AppSettings }
      removePioneerServer: { params: { url: string }; response: AppSettings }
      setActivePioneerServer: { params: { url: string }; response: AppSettings }

      // ── Accounting ledger ─────────────────────────────────────────────
      /** Current balances per ledger account (asset wallet accounts, equity, income, expenses). */
      getLedgerSummary: { params: void; response: Array<{ accountId: string; accountType: string; asset: string; chainId: string; balance: number }> }
      /** Recent journal entries with their postings. */
      getLedgerJournals: { params: { limit?: number }; response: Array<{ id: string; deviceId: string; description: string; entryType: string; createdAt: number; postings: Array<{ accountId: string; amount: number; asset: string }> }> }

      // ── Reports ──────────────────────────────────────────────────────
      generateReport: { params: void; response: ReportMeta }
      listReports: { params: void; response: ReportMeta[] }
      getReport: { params: { id: string }; response: { meta: ReportMeta; data: ReportData } | null }
      deleteReport: { params: { id: string }; response: void }
      saveReportFile: { params: { id: string; format: 'pdf' | 'csv' | 'cointracker' | 'zenledger' }; response: { filePath: string } }

      // ── Swap ──────────────────────────────────────────────────────────
      getSwappableChainIds: { params: void; response: string[] }
      getSwapAssets: { params: void; response: SwapAsset[] }
      /** Search Pioneer's full asset discovery DB — includes tokens not in swap pools.
       *  Frontend uses this as a fallback when the in-chain list returns no results. */
      searchSwapAssets: { params: { query: string }; response: SwapAsset[] }
      /** Look up an unknown token by contract address across common chains.
       *  When no chainId is provided, candidate EVM chains are queried in
       *  parallel and any with metadata are returned. The frontend uses this
       *  to auto-add a token when the user pastes a contract into the asset
       *  picker search box. */
      lookupTokenContract: {
        params: { contractAddress: string; chainId?: string }
        response: { hits: SwapAsset[]; reason?: string }
      }
      getSwapHealth: { params: void; response: SwapHealth }
      getSwapQuote: { params: SwapQuoteParams; response: SwapQuote }
      executeSwap: { params: ExecuteSwapParams; response: SwapResult }
      /** Build the unsigned swap tx(s) without signing — used to surface the
       *  hdwallet payload on the Confirm Quote screen for auditing. Returns
       *  `approveTx` only when an ERC-20 allowance bump is required. */
      previewSwapBuild: { params: ExecuteSwapParams; response: {
        approveTx?: any
        unsignedTx: any
        allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }
        balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string }
      } }
      getPendingSwaps: { params: void; response: PendingSwap[] }
      dismissSwap: { params: { txid: string }; response: void }

      // ── Swap History (SQLite-persisted) ─────────────────────────────
      getSwapByTxid: { params: { txid: string }; response: PendingSwap | null }
      /** Single on-demand Pioneer poll for one swap. Used by SwapDialog while
       *  open — there is no background polling timer (by design). */
      refreshSwap: { params: { txid: string; rescan?: boolean }; response: PendingSwap | null }
      /** Read-only diagnostic for a single swap: local state + raw Pioneer
       *  response + rescan response, with protocol divergence flagged. Used
       *  by the SwapDialog "Debug" affordance and dev-tools introspection.
       *  Returns null when called from a passphrase-wallet session, or for
       *  any txid tagged as a passphrase swap. */
      debugSwapLookup: { params: { txid: string }; response: {
        txid: string
        pioneerBaseUrl: string | undefined
        local: PendingSwap | null
        pioneer: { ok: boolean; status: number | null; raw: any; error?: string }
        pioneerRescan: { ok: boolean; status: number | null; raw: any; error?: string }
        divergence?: { vaultProtocol: string; pioneerProtocol: string }
      } | null }
      getSwapHistory: { params: SwapHistoryFilter | void; response: SwapHistoryRecord[] }
      getSwapHistoryStats: { params: void; response: SwapHistoryStats }
      exportSwapReport: { params: { fromDate?: number; toDate?: number; format: 'pdf' | 'csv' }; response: { filePath: string } }

      // ── Swap UI mirror (WebView publishes its visible state to Bun) ──
      // Fire-and-forget from the SwapDialog; Bun caches the latest snapshot
      // so REST /api/v2/swap/state can read what the user sees.
      publishSwapUiState: { params: SwapUiState; response: void }

      // ── Address Book (SQLite-persisted, unified across all wallets) ──────
      // own entries are auto-seeded from connected wallets (R2); external entries
      // are auto-created on manual sends (R4). Identity = (walletId, networkId, address).
      listAddressBook: { params: AddressBookFilter | void; response: AddressBookEntry[] }
      // Instant form-fill detection (R5): is this recipient a known own wallet or
      // saved contact? Returns the matching entry (logo/label) or null (new address).
      matchAddress: { params: { networkId: string; address: string }; response: AddressBookEntry | null }
      // Manually add (or relabel) an external contact. networkId picks the chain;
      // the address is normalized + the row scoped to the current wallet.
      addAddressBook: { params: { networkId: string; address: string; label?: string }; response: AddressBookEntry | null }
      updateAddressBook: { params: { id: string; label?: string; note?: string }; response: boolean }
      deleteAddressBook: { params: { id: string }; response: void }
      getAddressBookHistory: { params: { entryId: string }; response: AddressBookTx[] }

      // ── Recent Activity ──────────────────────────────────────────────────
      getRecentActivity: { params: { limit?: number; chainId?: string } | void; response: RecentActivity[] }
      scanChainHistory: { params: { chainId: string }; response: { count: number } }
      // True while the engine's startup/background bulk history scan is in flight,
      // so the activity UI can show "Syncing…" instead of a false "no activity".
      getActivityScanState: { params: void; response: { running: boolean } }
      dismissActivity: { params: { id: string }; response: void }
      clearRecentActivity: { params: void; response: void }

      // ── Balance cache (instant portfolio) ─────────────────────────────
      getCachedBalances: { params: void; response: { balances: ChainBalance[]; updatedAt: number; staleReasons?: string[] } | null }

      // ── Watch-only mode ──────────────────────────────────────────────
      checkWatchOnlyCache: { params: void; response: { available: boolean; deviceLabel?: string; lastSynced?: number } }
      getWatchOnlyBalances: { params: { deviceId?: string } | void; response: ChainBalance[] | null }
      refreshWatchOnlyBalances: { params: { deviceId?: string } | void; response: ChainBalance[] | null }
      getWatchOnlyPubkeys: { params: { deviceId?: string } | void; response: Array<{ chainId: string; path: string; xpub: string; address: string }> }

      // ── Registered devices (device history) ──────────────────────────
      getRegisteredDevices: { params: void; response: RegisteredDevice[] }
      forgetDevice: { params: { deviceId: string }; response: void }

      // ── Factory Reset ──────────────────────────────────────────────────
      factoryReset: { params: void; response: void }

      // ── Sweep (non-standard BTC path recovery) ──────────────────────
      sweepScan: { params: { accountRange?: [number, number]; mismatchAccounts?: number; currentMaxAccount?: number; higherAccountScanLimit?: number; gapLimitReceive?: number; gapLimitChange?: number; higherReceiveLimit?: number; streamProgress?: boolean }; response: { scanId: string } }
      sweepGetStatus: { params: { scanId: string }; response: any }
      sweepExecute: { params: { scanId: string; destinationAddress?: string; dryRun?: boolean }; response: any }

      // ── Balance Audit (multi-chain "where's my money" wizard) ───────
      auditStart: { params: { mode?: AuditMode; snapshot?: AuditPortfolioSnapshot }; response: { auditId: string } }
      auditGetStatus: { params: { auditId: string }; response: AuditReport }
      auditScanBtc: { params: { auditId: string }; response: { started: boolean } }
      auditSweep: { params: { auditId: string; destinationAddress?: string; dryRun?: boolean }; response: any }
      auditDismiss: { params: { auditId: string }; response: void }
      // Per-chain walkthrough: derive + balance-check account/index levels, and custom paths.
      auditScanLevels: { params: { chainId: string; fromLevel?: number; count?: number }; response: { results: AuditDerivedAddress[] } }
      // UTXO altcoins (DOGE/LTC/BCH/…): xpub-based per-account scan (Pioneer gap scan).
      auditScanUtxoAccounts: { params: { chainId: string; fromLevel?: number; count?: number }; response: { results: AuditDerivedAddress[] } }
      auditDeriveCustom: { params: { chainId: string; addressNList: number[]; scriptType?: string }; response: AuditDerivedAddress }
      auditScanPaths: { params: { chainId: string; paths: number[][]; scriptType?: string }; response: { results: AuditDerivedAddress[] } }
      // Sweep one funded address-level find to the chain's standard receive address (dryRun quotes first).
      auditSweepPath: { params: { chainId: string; addressNList: number[]; scriptType?: string; expectedAddress: string; destinationAddress?: string; dryRun?: boolean }; response: any }
      auditInspectPath: { params: { chainId: string; addressNList: number[]; scriptType?: string }; response: AuditInspectResult }

      // ── Emulator (macOS only — Keychain-encrypted flash) ────────────
      emulatorPair: { params: void; response: EmulatorStatus }
      emulatorInit: { params: { flashName?: string } | void; response: EmulatorStatus }
      emulatorStop: { params: void; response: EmulatorStatus }
      emulatorSave: { params: void; response: void }
      emulatorStatus: { params: void; response: EmulatorStatus }
      emulatorDeleteFlash: { params: { name: string }; response: EmulatorStatus }
      emulatorListWallets: { params: void; response: EmulatorWalletInfo[] }
      emulatorImportWallet: { params: { name: string; mnemonic: string; label?: string }; response: EmulatorStatus }
      emulatorSwitchWallet: { params: { name: string }; response: EmulatorStatus }
      /** Install a libkkemu.dylib from a base64-encoded payload into ~/.keepkey/emulator/. macOS only. */
      emulatorInstallDylib: { params: { data: string }; response: { path: string; size: number; emulatorEnabled: boolean } }
      /** Wipes the active flash and loads a freshly generated mnemonic. */
      emulatorCreateWallet: { params: { wordCount?: 12 | 18 | 24 }; response: { seedDisplayed: true } }
      emulatorGetMnemonic: { params: void; response: string | null }
      /** Emulator-only: read the saved mnemonic for the active flash, for backup display. */
      emulatorRevealSeed: { params: void; response: { mnemonic: string; flashName: string } }
      /** Emulator-only: capture the current OLED frame as a PNG on disk (visual proof for automated test drivers). */
      emulatorCaptureFrame: { params: { label?: string; dir?: string } | void; response: { path: string } }

      // ── WalletConnect (native v2) ────────────────────────────────────
      wcPair: { params: { uri: string }; response: void }
      wcGetSessions: { params: void; response: WcSessionInfo[] }
      wcDisconnectSession: { params: { topic: string }; response: void }
      // User responses to a pending pair-approval prompt. id is the proposal id.
      wcApprovePair: { params: { id: string }; response: void }
      wcRejectPair: { params: { id: string }; response: void }

      // ── Utility ───────────────────────────────────────────────────────
      openUrl: { params: { url: string }; response: void }
      getPendingDeepLink: { params: void; response: string | null }
      consumePendingDeepLink: { params: void; response: void }

      // ── Linux: udev rules auto-fix ───────────────────────────────
      // Writes /etc/udev/rules.d/51-keepkey.rules via pkexec so the user
      // can talk to the device without re-running the app as root.
      installLinuxUdevRules: { params: void; response: { success: boolean; error?: string } }

      // ── Windows USB troubleshooter (read-only diagnostic) ────────────
      // Runs read-only PowerShell + libusb checks to explain why a connected
      // KeepKey isn't detected on Windows. Collects no wallet data. See
      // src/bun/windows-usb-probe.ts.
      runUsbDiagnostic: { params: void; response: UsbDiagnosticReport }

      // ── App Updates ────────────────────────────────────────────────────
      checkForUpdate: { params: void; response: UpdateInfo }
      downloadUpdate: { params: void; response: void }
      applyUpdate: { params: void; response: void }
      getUpdateInfo: { params: void; response: UpdateInfo | null }
      getAppVersion: { params: void; response: { version: string; channel: string } }
      pingPioneer: { params: void; response: { online: boolean } }
      // ── REST API UI-active gate ────────────────────────────────
      // Frontend signals whether the Vault UI window is open so the REST API
      // (port 1646) won't serve pubkeys/addresses to 3rd-party apps unless
      // the user's UI is present. `viewDeviceId` scopes serving to the device
      // the user currently has open (incl. watch-only views).
      uiSetActive: { params: { active: boolean; viewDeviceId?: string | null }; response: void }
      uiHeartbeat: { params: { viewDeviceId?: string | null } | void; response: void }

      // ── Window controls (custom titlebar) ──────────────────────
      windowClose: { params: void; response: void }
      windowMinimize: { params: void; response: void }
      windowMaximize: { params: void; response: void }
      windowGetFrame: { params: void; response: { x: number; y: number; width: number; height: number } }
      windowSetPosition: { params: { x: number; y: number }; response: void }
      windowSetFrame: { params: { x: number; y: number; width: number; height: number }; response: void }
    }
    messages: {
      'device-state': DeviceStateInfo
      'firmware-progress': FirmwareProgress
      'pin-request': PinRequest
      'character-request': CharacterRequest
      'passphrase-request': Record<string, never>
      'pin-error': Record<string, never>
      'recovery-error': { message: string; errorType: 'pin-mismatch' | 'invalid-mnemonic' | 'bad-words' | 'word-not-found' | 'cancelled' | 'unknown'; autoRetrying?: boolean }
      'btc-accounts-update': BtcAccountSet
      'evm-addresses-update': EvmAddressSet
'update-status': UpdateStatus
      // severity defaults to 'error' (hard failure — server unreachable). 'warning'
      // carries soft fault info (some chains degraded/stale, data still shown);
      // 'none' clears any soft-fault banner after a clean fetch.
      'pioneer-error': {
        message: string
        url: string
        severity?: 'error' | 'warning' | 'none'
        degradedChains?: string[]
        staleChains?: string[]
        staleMinutes?: number
        // chainId-granular fault info for the Audit wizard (symbols above are for
        // the banner). Symbols collide across chains, so the audit matches by id.
        degradedChainIds?: string[]
        staleChainIds?: string[]
        unresolvedFaultCount?: number
      }
      'pair-request': PairingRequestInfo
      'pair-dismissed': Record<string, never>
      'signing-request': SigningRequestInfo
      'signing-dismissed': { id: string }
      'api-log': ApiLogEntry
      'report-progress': { id: string; message: string; percent: number }
      // Live per-path progress for the audit "unusual paths" (sweep) scan, so the
      // panel can stream what it's checking. scanId scopes it to one scan.
      'audit-sweep-progress': {
        scanId: string
        phase: 'deriving' | 'found'
        current?: number
        total?: number
        pathStr: string
        scriptType: string
        category?: string
        address?: string
        balanceSats?: number
      }
      'walletconnect-uri': string
      'wc-sessions': WcSessionInfo[]
      'wc-pair-request': { id: string; peerName: string; peerUrl: string; peerIcon: string; chains: string[]; methods: string[] }
      'wc-pair-dismiss': { id: string }
      // Warm-path deep link: backend hands the URI to the frontend so the panel
      // can mount *before* the WC session_proposal arrives. The pair-approval
      // modal lives inside WalletConnectPanel.
      'wc-deep-link-pair': { uri: string }
      'swap-update': SwapStatusUpdate
      'swap-complete': PendingSwap
      /** Finer-grained substage during executeSwap. The coarse `phase` enum
       *  (approving/signing/broadcasting) is too narrow for ERC-20 flows that
       *  go approve-sign → approve-broadcast → wait-receipt → swap-sign →
       *  swap-broadcast. Without this signal the UI shows "Approving token…
       *  1/2 Waiting on KeepKey" for the entire flow including the swap step.
       *  Stages match the SwapSubStage type in src/bun/swap.ts. */
      'swap-substage': { stage: 'approve-signing' | 'approve-broadcasting' | 'approve-waiting-receipt' | 'swap-signing' | 'swap-broadcasting' }
      /** REST → SwapDialog command. Lets external clients drive the dialog
       *  the same way a user click would: open it, set a field, request a
       *  re-quote, or close it. Signing/broadcast are NEVER triggered this
       *  way — the user must press Sign in the dialog. */
      'swap-cmd': SwapUiCommand
      'scan-progress': { percent: number; scannedHeight: number; tipHeight: number; blocksPerSec: number; etaSeconds: number }
      'balance-updated': ChainBalance
      /** A scheduled post-tx Orchard rescan finished (shield/deshield/z2z).
       *  Frontend should re-pull the zcash chain balance so the dashboard
       *  reconciles spent notes / new outputs without user action. */
      'zcash-rescan-complete': { syncedTo: number | null; notesFound: number }
      /** The engine's background history scan (fired on every device-ready)
       *  finished. The activity UI refetches on this so freshly-indexed txs
       *  replace the "No indexed activity yet" placeholder without a manual
       *  navigate-away. inserted/chains are for logging/telemetry only. */
      'activity-scan-complete': { inserted: number; chains: number }
      /** Seed-staleness purge: the backend detected the in-memory wallet data
       *  belonged to a DIFFERENT seed than the device (passphrase toggle,
       *  hidden↔standard transition, cached-passphrase reconnect) and dropped
       *  it. Frontend must clear displayed balances immediately (showing the
       *  wrong wallet's funds is the bug) and force-refresh from the device. */
      'wallet-data-purged': { reason: string }
      /** Audit-specific staleness push (only AuditDialog consumes it) for events
       *  that must invalidate an open wizard WITHOUT the dashboard-wide
       *  wallet-data-purged churn — e.g. needs_passphrase, which fires on every
       *  passphrase-protected unlock incl. the standard empty-passphrase wallet.
       *  markAuditsStale alone is invisible to a COMPLETED audit (status stays
       *  'complete' and the dialog has stopped polling), so the UI needs this. */
      'audit-stale': { reason: string }
      /** Pioneer push notification: a transaction arrived on a watched address.
       *  Frontend resyncs the affected chain (matched by networkId) regardless of
       *  direction, and shows a toast only for inbound payments (type === 'incoming').
       *  `chain` is CAIP-19, `networkId` is CAIP-2 — networkId is the reliable key. */
      'tx-push-received': { chain?: string; networkId?: string; address?: string; txid?: string; type?: 'incoming' | 'outgoing' | 'confirmed' }
      /** SSE event-stream connection status. 'connected' = watching addresses; 'disconnected' = no stream. */
      'stream-status': { connected: boolean; watching: number; sessionId?: string }
      'token-visibility-changed': { caip: string; status: 'visible' | 'hidden' | null }
      // Address Book mutated (own-sync inserted rows, or a send created/updated a
      // recipient) — frontend re-fetches the list.
      'addressbook-changed': Record<string, never>
      'sweep-progress': { scanId: string; current: number; total: number; phase: string; foundCount: number; foundSats: number }
      'shield-progress': { step: string; detail?: string }
      'deshield-progress': { step: string; detail?: string }
      'send-progress': { step: string; detail?: string }
      // Fires whenever the device emits a ButtonRequest (any flow). UI flows
      // that are mid-signing use this to switch from "device computing" to
      // "press the button on your KeepKey".
      'device-button-request': {}
      'emulator-status': EmulatorStatus
      /** Bun hit an uncaught error. App process stays alive (handlers are non-exit);
       *  UI should surface a recovery prompt and let the user reload / reconnect. */
      'fatal': FatalEvent
      'window-focus-changed': { refs: number; alwaysOnTop: boolean }
    }
  }
  webview: {
    requests: Record<string, never>
    messages: Record<string, never>
  }
}
