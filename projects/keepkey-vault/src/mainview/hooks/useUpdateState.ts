import { useState, useEffect, useCallback } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { UpdateInfo, UpdateStatus } from '../../shared/types'

export type UpdatePhaseUI = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'applying' | 'warning' | 'error'

export interface UpdateState {
  phase: UpdatePhaseUI
  info: UpdateInfo | null
  progress: number | undefined
  message: string
  error: string | undefined
}

/** Map Electrobun's granular status strings to 7 UI phases */
function statusToPhase(status: string): UpdatePhaseUI {
  switch (status) {
    case 'checking-for-update':
      return 'checking'
    case 'update-available':
    case 'update-available-full':
    case 'update-available-delta':
      return 'available'
    case 'downloading-full-update':
    case 'downloading-delta-update':
    case 'downloading-update':
    case 'download-progress':
      return 'downloading'
    case 'download-complete':
    case 'update-ready':
    case 'update-staged':
    case 'delta-applied':
      return 'ready'
    case 'applying-update':
    case 'replacing-app':
    case 'relaunching':
      return 'applying'
    case 'no-update-available':
    case 'up-to-date':
      return 'idle'
    case 'error':
    case 'download-error':
      return 'warning'  // transient — network/download failures
    case 'update-error':
    case 'delta-error':
      return 'error'    // critical — update application/patching failures
    default:
      return 'idle'
  }
}

const DEFAULT_STATE: UpdateState = {
  phase: 'idle',
  info: null,
  progress: undefined,
  message: '',
  error: undefined,
}

export function useUpdateState() {
  const [state, setState] = useState<UpdateState>(DEFAULT_STATE)

  // Subscribe to update-status messages from Bun
  useEffect(() => {
    const unsubscribe = onRpcMessage('update-status', (payload: UpdateStatus) => {
      setState(prev => ({
        ...prev,
        phase: statusToPhase(payload.status),
        progress: payload.progress,
        message: payload.message || '',
        error: payload.errorMessage,
      }))
    })
    return unsubscribe
  }, [])

  // Fetch initial update info on mount
  useEffect(() => {
    rpcRequest<UpdateInfo | null>('getUpdateInfo').then(info => {
      if (info) {
        setState(prev => ({
          ...prev,
          info,
          phase: info.updateReady ? 'ready' : info.updateAvailable ? 'available' : 'idle',
        }))
      }
    }).catch(() => {})
  }, [])

  const checkForUpdate = useCallback(async () => {
    setState(prev => ({ ...prev, phase: 'checking', error: undefined }))
    try {
      const info = await rpcRequest<UpdateInfo>('checkForUpdate', undefined, 30000)
      setState(prev => ({
        ...prev,
        info,
        phase: info.updateAvailable ? 'available' : 'idle',
        message: info.updateAvailable ? `Version ${info.version} available` : 'You are on the latest version',
        error: info.error || undefined,
      }))
      return info
    } catch (e: any) {
      setState(prev => ({ ...prev, phase: 'warning', error: e.message }))
      throw e
    }
  }, [])

  const downloadUpdate = useCallback(async () => {
    setState(prev => ({ ...prev, phase: 'downloading', progress: 0, error: undefined }))
    try {
      await rpcRequest('downloadUpdate', undefined, 0)
    } catch (e: any) {
      setState(prev => ({ ...prev, phase: 'error', error: e.message }))
    }
  }, [])

  const applyUpdate = useCallback(async () => {
    setState(prev => ({ ...prev, phase: 'applying', error: undefined }))
    try {
      await rpcRequest('applyUpdate', undefined, 60000)
    } catch (e: any) {
      setState(prev => ({ ...prev, phase: 'error', error: e.message }))
    }
  }, [])

  return { ...state, checkForUpdate, downloadUpdate, applyUpdate }
}
