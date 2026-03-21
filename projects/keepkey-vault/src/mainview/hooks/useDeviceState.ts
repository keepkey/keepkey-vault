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

    // Fetch initial state — retry until success (Windows WebView2 RPC may not be ready)
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const fetchInitial = (attempt: number) => {
      rpcRequest<DeviceStateInfo>('getDeviceState').then((state) => {
        if (!cancelled) setDeviceState(state)
      }).catch((err) => {
        if (attempt <= 3) console.warn(`[useDeviceState] fetch attempt ${attempt} failed:`, err?.message)
        if (!cancelled) {
          // Backoff: 500ms, 1s, 1.5s, 2s, then cap at 3s
          const delay = Math.min(500 * attempt, 3000)
          retryTimer = setTimeout(() => fetchInitial(attempt + 1), delay)
        }
      })
    }
    fetchInitial(1)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribe()
    }
  }, [])

  return deviceState
}
