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
  isOob: false,
}

export function useDeviceState() {
  const [deviceState, setDeviceState] = useState<DeviceStateInfo>(DEFAULT_STATE)

  useEffect(() => {
    // Listen for pushed device-state messages from Bun
    const unsubscribe = onRpcMessage('device-state', (payload: DeviceStateInfo) => {
      setDeviceState(payload)
    })

    // Fetch initial state
    rpcRequest<DeviceStateInfo>('getDeviceState').then((state) => {
      setDeviceState(state)
    }).catch((err) => {
      console.warn('Failed to get initial device state:', err)
    })

    return unsubscribe
  }, [])

  return deviceState
}
