import { useState, useEffect } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { DeviceStateInfo } from '../../shared/types'

const DEFAULT_STATE: DeviceStateInfo = {
  state: 'disconnected',
  activeTransport: null,
  updatePhase: 'idle',
  bootloaderMode: false,
  needsBootloaderUpdate: false,
  needsFirmwareUpdate: false,
  needsInit: false, // L8 fix: default false prevents brief wizard flash before features arrive
  initialized: false,
  passphraseProtection: false,
  isOob: false,
}

export function useDeviceState() {
  const [deviceState, setDeviceState] = useState<DeviceStateInfo>(DEFAULT_STATE)

  useEffect(() => {
    // Listen for pushed device-state messages from Bun
    const unsubscribe = onRpcMessage('device-state', (payload: DeviceStateInfo) => {
      setDeviceState(payload)
    })

    // Fetch initial state — retry if RPC isn't ready yet (Windows WebView2 timing)
    let cancelled = false
    const fetchInitial = (attempt: number) => {
      rpcRequest<DeviceStateInfo>('getDeviceState').then((state) => {
        if (!cancelled) setDeviceState(state)
      }).catch((err) => {
        console.warn(`[useDeviceState] fetch attempt ${attempt} failed:`, err?.message)
        if (!cancelled && attempt < 5) {
          setTimeout(() => fetchInitial(attempt + 1), 500 * attempt)
        }
      })
    }
    fetchInitial(1)

    return () => { cancelled = true; unsubscribe() }
  }, [])

  return deviceState
}
