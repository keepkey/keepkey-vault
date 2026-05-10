import type { ElectrobunRPCSchema } from 'electrobun/bun'
import type { DeviceStateInfo, FirmwareProgress, FirmwareAnalysis, FatalEvent, PinRequest, CharacterRequest, ChainBalance, BuildTxParams, BuildTxResult, BroadcastResult, BtcAccountSet, BtcScriptType, EvmAddressSet, CustomToken, CustomChain, AppSettings, PioneerServer, BtcGetAddressParams, EthGetAddressParams, EthSignTxParams, BtcSignTxParams, GetPublicKeysParams, UpdateInfo, UpdateStatus, TokenVisibilityStatus, PairingRequestInfo, PairedAppInfo, SigningRequestInfo, ApiLogEntry, PioneerChainInfo, ReportMeta, ReportData, SwapAsset, SwapQuote, SwapQuoteParams, ExecuteSwapParams, SwapResult, PendingSwap, SwapStatusUpdate, SwapHistoryRecord, SwapHistoryFilter, SwapHistoryStats, SwapUiState, SwapUiCommand, RecentActivity, BuildStakingTxParams, StakingPosition, ZcashTransaction, EmulatorStatus, EmulatorWalletInfo, RegisteredDevice, WcSessionInfo } from './types'

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
      startFirmwareUpdate: { params: void; response: void }
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
      // Open a URL in the user's default browser (escapes the WebView).
      // The system WebView blocks target=_blank, so explorer/docs links
      // route through here instead. Bun shells out to the OS-native opener.
      openExternal: { params: { url: string }; response: { ok: true } }
      wipeDevice: { params: void; response: any }
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

      // ── Pioneer integration ─────────────────────────────────────────
      getBalances: { params: void; response: ChainBalance[] }
      getBalance: { params: { chainId: string }; response: ChainBalance }
      buildTx: { params: BuildTxParams; response: BuildTxResult }
      broadcastTx: { params: { chainId: string; signedTx: any }; response: BroadcastResult }

      // ── Staking / delegation ─────────────────────────────────────────
      getStakingPositions: { params: { chainId: string; address: string }; response: StakingPosition[] }
      buildDelegateTx: { params: BuildStakingTxParams; response: BuildTxResult }
      buildUndelegateTx: { params: BuildStakingTxParams; response: BuildTxResult }

      getMarketData: { params: { caips: string[] }; response: any }
      getFees: { params: { chainId: string }; response: any }

      // ── Bitcoin multi-account ─────────────────────────────────────────
      getBtcAccounts: { params: void; response: BtcAccountSet }
      addBtcAccount: { params: void; response: BtcAccountSet }
      setBtcSelectedXpub: { params: { accountIndex: number; scriptType: BtcScriptType }; response: void }
      getBtcAddressIndices: { params: { xpub: string }; response: { receiveIndex: number; changeIndex: number } }

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
      addCustomChain: { params: CustomChain; response: void }
      removeCustomChain: { params: { chainId: number }; response: void }
      getCustomChains: { params: void; response: CustomChain[] }

      // ── Token visibility (spam filter) ──────────────────────────────────
      setTokenVisibility: { params: { caip: string; status: TokenVisibilityStatus }; response: void }
      removeTokenVisibility: { params: { caip: string }; response: void }
      getTokenVisibilityMap: { params: void; response: Record<string, TokenVisibilityStatus> }

      // ── Zcash Shielded (Orchard) ──────────────────────────────────────
      zcashShieldedStatus: { params: void; response: { ready: boolean; fvk_loaded: boolean; address: string | null; fvk: { ak: string; nk: string; rivk: string } | null; synced_to: number | null; keepkey_release_block: number | null } }
      zcashShieldedInit: { params: { account?: number }; response: { fvk: { ak: string; nk: string; rivk: string }; address: string } }
      zcashShieldedScan: { params: { startHeight?: number; fullRescan?: boolean }; response: { balance: number; notes_found: number; synced_to: number } }
      zcashShieldedBalance: { params: void; response: { confirmed: number; pending: number; synced_to?: number | null; notes_total?: number; notes_unspent?: number; keepkey_release_block?: number } }
      zcashShieldedSend: { params: { recipient: string; amount: number; memo?: string }; response: { txid: string } }
      zcashShieldZec: { params: { amount: number; account?: number }; response: { txid: string } }
      // Confirmed UTXO total at the user's first-receive t-addr — the only address
      // shieldZec sweeps. Use this (not chain-level getBalance, which sums the
      // whole xpub) to power the Shield page's Available / Max button.
      zcashTransparentBalance: { params: { account?: number } | void; response: { address: string; balanceZat: number } }
      zcashDeshieldZec: { params: { recipient: string; amount: number; account?: number }; response: { txid: string } }
      zcashGetTransactions: { params: void; response: { transactions: ZcashTransaction[] } }
      zcashBackfillMemos: { params: void; response: { backfilled: number } }
      // Ask the device to derive and display its Orchard UA for this account.
      // No host-cached UA or FVK material is sent for this display flow.
      zcashDisplayAddress: { params: { account?: number }; response: { address: string } }

      // ── Pairing & Signing approval ───────────────────────────────────
      approvePairing: { params: void; response: { apiKey: string } }
      rejectPairing: { params: void; response: void }
      approveSigningRequest: { params: { id: string }; response: void }
      rejectSigningRequest: { params: { id: string }; response: void }
      listPairedApps: { params: void; response: PairedAppInfo[] }
      revokePairing: { params: { apiKey: string }; response: void }

      // ── Mobile pairing (via vault.keepkey.com relay) ─────────────────
      generateMobilePairing: { params: void; response: { code: string; expiresAt: number; expiresIn: number; qrPayload: string } }

      // ── API Audit Log ──────────────────────────────────────────────────
      getApiLogs: { params: { limit?: number; offset?: number } | void; response: ApiLogEntry[] }
      clearApiLogs: { params: void; response: void }

      // ── App Settings ──────────────────────────────────────────────────
      getAppSettings: { params: void; response: AppSettings }
      setRestApiEnabled: { params: { enabled: boolean }; response: AppSettings }
      setPioneerApiBase: { params: { url: string }; response: AppSettings }
      setFiatCurrency: { params: { currency: string }; response: AppSettings }
      setNumberLocale: { params: { locale: string }; response: AppSettings }
      setWalletConnectEnabled: { params: { enabled: boolean }; response: AppSettings }
      setSwapsEnabled: { params: { enabled: boolean }; response: AppSettings }
      setBip85Enabled: { params: { enabled: boolean }; response: AppSettings }
      setZcashPrivacyEnabled: { params: { enabled: boolean }; response: AppSettings }
      setEmulatorEnabled: { params: { enabled: boolean }; response: AppSettings }
      setPreReleaseUpdates: { params: { enabled: boolean }; response: AppSettings }
      setAlphaFirmware: { params: { enabled: boolean }; response: AppSettings }
      addPioneerServer: { params: { url: string; label: string }; response: AppSettings }
      removePioneerServer: { params: { url: string }; response: AppSettings }
      setActivePioneerServer: { params: { url: string }; response: AppSettings }

      // ── Reports ──────────────────────────────────────────────────────
      generateReport: { params: void; response: ReportMeta }
      listReports: { params: void; response: ReportMeta[] }
      getReport: { params: { id: string }; response: { meta: ReportMeta; data: ReportData } | null }
      deleteReport: { params: { id: string }; response: void }
      saveReportFile: { params: { id: string; format: 'pdf' | 'csv' | 'cointracker' | 'zenledger' }; response: { filePath: string } }

      // ── Swap ──────────────────────────────────────────────────────────
      getSwappableChainIds: { params: void; response: string[] }
      getSwapAssets: { params: void; response: SwapAsset[] }
      /** Look up an unknown token by contract address across common chains.
       *  When no chainId is provided, candidate EVM chains are queried in
       *  parallel and any with metadata are returned. The frontend uses this
       *  to auto-add a token when the user pastes a contract into the asset
       *  picker search box. */
      lookupTokenContract: {
        params: { contractAddress: string; chainId?: string }
        response: { hits: SwapAsset[]; reason?: string }
      }
      getSwapQuote: { params: SwapQuoteParams; response: SwapQuote }
      executeSwap: { params: ExecuteSwapParams; response: SwapResult }
      /** Build the unsigned swap tx(s) without signing — used to surface the
       *  hdwallet payload on the Confirm Quote screen for auditing. Returns
       *  `approveTx` only when an ERC-20 allowance bump is required. */
      previewSwapBuild: { params: ExecuteSwapParams; response: { approveTx?: any; unsignedTx: any } }
      getPendingSwaps: { params: void; response: PendingSwap[] }
      dismissSwap: { params: { txid: string }; response: void }

      // ── Swap History (SQLite-persisted) ─────────────────────────────
      getSwapByTxid: { params: { txid: string }; response: PendingSwap | null }
      /** Single on-demand Pioneer poll for one swap. Used by SwapDialog while
       *  open — there is no background polling timer (by design). */
      refreshSwap: { params: { txid: string }; response: PendingSwap | null }
      getSwapHistory: { params: SwapHistoryFilter | void; response: SwapHistoryRecord[] }
      getSwapHistoryStats: { params: void; response: SwapHistoryStats }
      exportSwapReport: { params: { fromDate?: number; toDate?: number; format: 'pdf' | 'csv' }; response: { filePath: string } }

      // ── Swap UI mirror (WebView publishes its visible state to Bun) ──
      // Fire-and-forget from the SwapDialog; Bun caches the latest snapshot
      // so REST /api/v2/swap/state can read what the user sees.
      publishSwapUiState: { params: SwapUiState; response: void }

      // ── Recent Activity ──────────────────────────────────────────────────
      getRecentActivity: { params: { limit?: number; chainId?: string } | void; response: RecentActivity[] }
      scanChainHistory: { params: { chainId: string }; response: { count: number } }
      dismissActivity: { params: { id: string }; response: void }
      clearRecentActivity: { params: void; response: void }

      // ── Balance cache (instant portfolio) ─────────────────────────────
      getCachedBalances: { params: void; response: { balances: ChainBalance[]; updatedAt: number; staleReasons?: string[] } | null }

      // ── Watch-only mode ──────────────────────────────────────────────
      checkWatchOnlyCache: { params: void; response: { available: boolean; deviceLabel?: string; lastSynced?: number } }
      getWatchOnlyBalances: { params: { deviceId?: string } | void; response: ChainBalance[] | null }
      getWatchOnlyPubkeys: { params: { deviceId?: string } | void; response: Array<{ chainId: string; path: string; xpub: string; address: string }> }

      // ── Registered devices (device history) ──────────────────────────
      getRegisteredDevices: { params: void; response: RegisteredDevice[] }
      forgetDevice: { params: { deviceId: string }; response: void }

      // ── Factory Reset ──────────────────────────────────────────────────
      factoryReset: { params: void; response: void }

      // ── Sweep (non-standard BTC path recovery) ──────────────────────
      sweepScan: { params: { accountRange?: [number, number]; mismatchAccounts?: number; currentMaxAccount?: number; higherAccountScanLimit?: number }; response: { scanId: string } }
      sweepGetStatus: { params: { scanId: string }; response: any }
      sweepExecute: { params: { scanId: string; destinationAddress?: string; dryRun?: boolean }; response: any }

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

      // ── WalletConnect (native v2) ────────────────────────────────────
      wcPair: { params: { uri: string }; response: void }
      wcGetSessions: { params: void; response: WcSessionInfo[] }
      wcDisconnectSession: { params: { topic: string }; response: void }
      // Capture a screen region (macOS interactive selection) and return the PNG.
      // Returns null when the user cancels the selection. Frontend decodes the
      // QR with jsqr and submits the URI to wcPair.
      wcScanScreen: { params: void; response: { pngBase64: string } | null }
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

      // ── App Updates ────────────────────────────────────────────────────
      checkForUpdate: { params: void; response: UpdateInfo }
      downloadUpdate: { params: void; response: void }
      applyUpdate: { params: void; response: void }
      getUpdateInfo: { params: void; response: UpdateInfo | null }
      getAppVersion: { params: void; response: { version: string; channel: string } }
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
      'pioneer-error': { message: string; url: string }
      'pair-request': PairingRequestInfo
      'pair-dismissed': Record<string, never>
      'signing-request': SigningRequestInfo
      'signing-dismissed': { id: string }
      'api-log': ApiLogEntry
      'report-progress': { id: string; message: string; percent: number }
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
      'token-visibility-changed': { caip: string; status: 'visible' | 'hidden' | null }
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
    }
  }
  webview: {
    requests: Record<string, never>
    messages: Record<string, never>
  }
}
