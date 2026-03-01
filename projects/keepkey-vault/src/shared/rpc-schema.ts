import type { ElectrobunRPCSchema } from 'electrobun/bun'
import type { DeviceStateInfo, FirmwareProgress, FirmwareAnalysis, PinRequest, CharacterRequest, ChainBalance, BuildTxParams, BuildTxResult, BroadcastResult, BtcAccountSet, BtcScriptType, EvmAddressSet, CustomToken, CustomChain, AppSettings, BtcGetAddressParams, EthGetAddressParams, EthSignTxParams, BtcSignTxParams, GetPublicKeysParams, UpdateInfo, UpdateStatus, TokenVisibilityStatus, PairingRequestInfo, PairedAppInfo, SigningRequestInfo, ApiLogEntry, PioneerChainInfo } from './types'

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
      startBootloaderUpdate: { params: void; response: void }
      startFirmwareUpdate: { params: void; response: void }
      flashFirmware: { params: void; response: void }
      analyzeFirmware: { params: { data: string }; response: FirmwareAnalysis }
      flashCustomFirmware: { params: { data: string }; response: void }
      resetDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      recoverDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      loadDevice: { params: { mnemonic: string; pin?: string; passphrase?: boolean; label?: string }; response: void }
      verifySeed: { params: { wordCount: 12 | 18 | 24 }; response: { success: boolean; message: string } }
      applySettings: { params: { label?: string; usePassphrase?: boolean; autoLockDelayMs?: number }; response: void }
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

      // ── Pioneer integration ─────────────────────────────────────────
      getBalances: { params: void; response: ChainBalance[] }
      getBalance: { params: { chainId: string }; response: ChainBalance }
      buildTx: { params: BuildTxParams; response: BuildTxResult }
      broadcastTx: { params: { chainId: string; signedTx: any }; response: BroadcastResult }
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

      // ── Camera / QR scanning ──────────────────────────────────────────
      startQrScan: { params: void; response: void }
      stopQrScan: { params: void; response: void }

      // ── Pairing & Signing approval ───────────────────────────────────
      approvePairing: { params: void; response: { apiKey: string } }
      rejectPairing: { params: void; response: void }
      approveSigningRequest: { params: { id: string }; response: void }
      rejectSigningRequest: { params: { id: string }; response: void }
      listPairedApps: { params: void; response: PairedAppInfo[] }
      revokePairing: { params: { apiKey: string }; response: void }

      // ── API Audit Log ──────────────────────────────────────────────────
      getApiLogs: { params: { limit?: number; offset?: number } | void; response: ApiLogEntry[] }
      clearApiLogs: { params: void; response: void }

      // ── App Settings ──────────────────────────────────────────────────
      getAppSettings: { params: void; response: AppSettings }
      setRestApiEnabled: { params: { enabled: boolean }; response: AppSettings }
      setPioneerApiBase: { params: { url: string }; response: AppSettings }

      // ── Balance cache (instant portfolio) ─────────────────────────────
      getCachedBalances: { params: void; response: { balances: ChainBalance[]; updatedAt: number } | null }

      // ── Watch-only mode ──────────────────────────────────────────────
      checkWatchOnlyCache: { params: void; response: { available: boolean; deviceLabel?: string; lastSynced?: number } }
      getWatchOnlyBalances: { params: void; response: ChainBalance[] | null }
      getWatchOnlyPubkeys: { params: void; response: Array<{ chainId: string; path: string; xpub: string; address: string }> }

      // ── Utility ───────────────────────────────────────────────────────
      openUrl: { params: { url: string }; response: void }

      // ── App Updates ────────────────────────────────────────────────────
      checkForUpdate: { params: void; response: UpdateInfo }
      downloadUpdate: { params: void; response: void }
      applyUpdate: { params: void; response: void }
      getUpdateInfo: { params: void; response: UpdateInfo | null }
      getAppVersion: { params: void; response: { version: string; channel: string } }
      // ── Window controls (custom titlebar) ──────────────────────
      windowClose: { params: void; response: void }
      windowMinimize: { params: void; response: void }
      windowMaximize: { params: void; response: void }
    }
    messages: {
      'device-state': DeviceStateInfo
      'firmware-progress': FirmwareProgress
      'pin-request': PinRequest
      'character-request': CharacterRequest
      'passphrase-request': Record<string, never>
      'recovery-error': { message: string; errorType: 'pin-mismatch' | 'invalid-mnemonic' | 'bad-words' | 'cancelled' | 'unknown' }
      'btc-accounts-update': BtcAccountSet
      'evm-addresses-update': EvmAddressSet
      'camera-frame': string
      'camera-error': string
      'update-status': UpdateStatus
      'pioneer-error': { message: string; url: string }
      'pair-request': PairingRequestInfo
      'pair-dismissed': Record<string, never>
      'signing-request': SigningRequestInfo
      'signing-dismissed': { id: string }
      'api-log': ApiLogEntry
      'walletconnect-uri': string
    }
  }
  webview: {
    requests: Record<string, never>
    messages: Record<string, never>
  }
}
