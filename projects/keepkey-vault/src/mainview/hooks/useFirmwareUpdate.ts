import { useState, useEffect, useCallback } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { FirmwareProgress } from '../../shared/types'

type UpdateState = 'idle' | 'updating' | 'complete' | 'error'

export function useFirmwareUpdate() {
  const [state, setState] = useState<UpdateState>('idle')
  const [progress, setProgress] = useState<FirmwareProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Listen for firmware-progress messages from Bun
  useEffect(() => {
    const unsubscribe = onRpcMessage('firmware-progress', (payload: FirmwareProgress) => {
      setProgress(payload)
      if (payload.percent >= 100) {
        setState('complete')
      }
    })

    return unsubscribe
  }, [])

  const startBootloaderUpdate = useCallback(async () => {
    setState('updating')
    setError(null)
    setProgress({ percent: 0, message: 'Starting bootloader update...' })
    try {
      await rpcRequest('startBootloaderUpdate', undefined, 0)
      setState('complete')
    } catch (err: any) {
      setState('error')
      setError(err?.message || 'Bootloader update failed')
    }
  }, [])

  const startFirmwareUpdate = useCallback(async (_version?: string) => {
    setState('updating')
    setError(null)
    setProgress({ percent: 0, message: 'Starting firmware update...' })
    try {
      await rpcRequest('startFirmwareUpdate', undefined, 0)
      setState('complete')
    } catch (err: any) {
      setState('error')
      setError(err?.message || 'Firmware update failed')
    }
  }, [])

  const reset = useCallback(() => {
    setState('idle')
    setProgress(null)
    setError(null)
  }, [])

  return {
    state,
    progress,
    error,
    startBootloaderUpdate,
    startFirmwareUpdate,
    reset,
  }
}
