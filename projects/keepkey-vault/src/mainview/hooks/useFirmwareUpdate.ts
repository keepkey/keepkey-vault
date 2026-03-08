import { useState, useEffect, useCallback, useRef } from 'react'
import { onRpcMessage, rpcRequest } from '../lib/rpc'
import type { FirmwareProgress } from '../../shared/types'

type UpdateState = 'idle' | 'updating' | 'complete' | 'error'

export function useFirmwareUpdate() {
  const [state, setState] = useState<UpdateState>('idle')
  const [progress, setProgress] = useState<FirmwareProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Guard: only process firmware-progress events when this hook initiated a flash
  const activeRef = useRef(false)

  // Listen for firmware-progress messages from Bun
  useEffect(() => {
    const unsubscribe = onRpcMessage('firmware-progress', (payload: FirmwareProgress) => {
      if (!activeRef.current) return // C1 fix: ignore events from other flash paths
      setProgress(payload)
      if (payload.percent >= 100) {
        activeRef.current = false
        setState('complete')
      }
    })

    return unsubscribe
  }, [])

  const startBootloaderUpdate = useCallback(async () => {
    activeRef.current = true
    setState('updating')
    setError(null)
    setProgress({ percent: 0, message: 'Starting bootloader update...' })
    try {
      await rpcRequest('startBootloaderUpdate', undefined, 0)
      activeRef.current = false
      setState('complete')
    } catch (err: any) {
      activeRef.current = false
      const msg = err?.message || 'Unknown error'
      console.error('[firmware] Bootloader update error:', msg)
      setError(msg) // C2 fix: actually set the error
      setState('error')
    }
  }, [])

  const startFirmwareUpdate = useCallback(async (_version?: string) => {
    activeRef.current = true
    setState('updating')
    setError(null)
    setProgress({ percent: 0, message: 'Starting firmware update...' })
    try {
      await rpcRequest('startFirmwareUpdate', undefined, 0)
      activeRef.current = false
      setState('complete')
    } catch (err: any) {
      activeRef.current = false
      const msg = err?.message || 'Unknown error'
      console.error('[firmware] Firmware update error:', msg)
      setError(msg) // C2 fix: actually set the error
      setState('error')
    }
  }, [])

  const reset = useCallback(() => {
    activeRef.current = false
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
