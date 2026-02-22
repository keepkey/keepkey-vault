import type { ElectrobunRPCSchema } from 'electrobun/bun'
import type { DeviceStateInfo, FirmwareProgress, PinRequest, CharacterRequest, ChainBalance, BuildTxParams, BuildTxResult, BroadcastResult, BtcAccountSet, BtcScriptType, CustomToken, CustomChain } from './types'

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
      resetDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      recoverDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      verifySeed: { params: { wordCount: 12 | 18 | 24 }; response: { success: boolean; message: string } }
      applySettings: { params: { label?: string }; response: void }
      sendPin: { params: { pin: string }; response: void }
      sendPassphrase: { params: { passphrase: string }; response: void }
      sendCharacter: { params: { character: string }; response: void }
      sendCharacterDelete: { params: void; response: void }
      sendCharacterDone: { params: void; response: void }

      // ── Wallet operations (hdwallet pass-through) ─────────────────
      getFeatures: { params: void; response: any }
      ping: { params: { msg?: string }; response: any }
      wipeDevice: { params: void; response: any }
      getPublicKeys: { params: { paths: any[] }; response: any }

      // ── Address derivation ────────────────────────────────────────
      btcGetAddress: { params: any; response: any }
      ethGetAddress: { params: any; response: any }
      cosmosGetAddress: { params: any; response: any }
      thorchainGetAddress: { params: any; response: any }
      mayachainGetAddress: { params: any; response: any }
      osmosisGetAddress: { params: any; response: any }
      binanceGetAddress: { params: any; response: any }
      xrpGetAddress: { params: any; response: any }

      // ── Transaction signing ───────────────────────────────────────
      btcSignTx: { params: any; response: any }
      ethSignTx: { params: any; response: any }
      ethSignMessage: { params: any; response: any }
      ethSignTypedData: { params: any; response: any }
      ethVerifyMessage: { params: any; response: any }
      cosmosSignTx: { params: any; response: any }
      thorchainSignTx: { params: any; response: any }
      mayachainSignTx: { params: any; response: any }
      osmosisSignTx: { params: any; response: any }
      binanceSignTx: { params: any; response: any }
      xrpSignTx: { params: any; response: any }

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

      // ── Custom tokens & chains ──────────────────────────────────────────
      addCustomToken: { params: { chainId: string; contractAddress: string }; response: CustomToken }
      removeCustomToken: { params: { chainId: string; contractAddress: string }; response: void }
      getCustomTokens: { params: void; response: CustomToken[] }
      addCustomChain: { params: CustomChain; response: void }
      removeCustomChain: { params: { chainId: number }; response: void }
      getCustomChains: { params: void; response: CustomChain[] }

      // ── Camera / QR scanning ──────────────────────────────────────────
      startQrScan: { params: void; response: void }
      stopQrScan: { params: void; response: void }

      // ── Utility ───────────────────────────────────────────────────────
      openUrl: { params: { url: string }; response: void }
    }
    messages: {
      'device-state': DeviceStateInfo
      'firmware-progress': FirmwareProgress
      'pin-request': PinRequest
      'character-request': CharacterRequest
      'recovery-error': { message: string; errorType: 'pin-mismatch' | 'invalid-mnemonic' | 'bad-words' | 'cancelled' | 'unknown' }
      'btc-accounts-update': BtcAccountSet
      'camera-frame': string
      'camera-error': string
    }
  }
  webview: {
    requests: Record<string, never>
    messages: Record<string, never>
  }
}
