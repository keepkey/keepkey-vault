import type { ElectrobunRPCSchema } from 'electrobun/bun'
import type { DeviceStateInfo, FirmwareProgress, PinRequest } from './types'

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
      getDeviceState: { params: void; response: DeviceStateInfo }
      startBootloaderUpdate: { params: void; response: void }
      startFirmwareUpdate: { params: void; response: void }
      flashFirmware: { params: void; response: void }
      resetDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      recoverDevice: { params: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }; response: void }
      applySettings: { params: { label?: string }; response: void }
      sendPin: { params: { pin: string }; response: void }
      sendPassphrase: { params: { passphrase: string }; response: void }
    }
    messages: {
      'device-state': DeviceStateInfo
      'firmware-progress': FirmwareProgress
      'pin-request': PinRequest
    }
  }
  webview: {
    requests: Record<string, never>
    messages: Record<string, never>
  }
}
