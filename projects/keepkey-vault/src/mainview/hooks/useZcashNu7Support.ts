import { useCallback, useEffect, useRef, useState } from 'react'
import { onRpcMessage, rpcRequest } from '../lib/rpc'

interface SupportSnapshot {
  scope: string
  revision: number
  pending: boolean
  available: boolean
}

/** Read host-computed readiness only; never query the device from this hook. */
export function useZcashNu7Support(enabled: boolean, ownerScope: string) {
  const scope = enabled ? ownerScope : ''
  const revision = useRef(0)
  const sessionEpoch = useRef(0)
  const previouslyGranted = useRef(false)
  const acceptedSession = useRef<string | null>(null)
  const authority = useRef({ scope, available: false })
  const [snapshot, setSnapshot] = useState<SupportSnapshot>({ scope: '', revision: 0, pending: true, available: false })
  if (authority.current.scope !== scope) {
    authority.current = { scope, available: false }
    revision.current++
    sessionEpoch.current++
    previouslyGranted.current = false
    acceptedSession.current = null
  }

  useEffect(() => {
    if (!enabled) return
    let active = true
    const refresh = () => {
      const request = ++revision.current
      authority.current = { scope, available: false }
      setSnapshot({ scope, revision: request, pending: true, available: false })
      void rpcRequest<{ available: boolean; requiredFirmware: string; emulatorOnly: boolean; alphaOnly: boolean; sessionId: string }>('getZcashNu7Support', undefined, 5_000)
        .then(status => {
          if (!active || authority.current.scope !== scope || request !== revision.current) return
          const available = status?.available === true && status.requiredFirmware === '7.17.0'
            && status.emulatorOnly === true && status.alphaOnly === true
            && typeof status.sessionId === 'string' && status.sessionId.length > 0 && status.sessionId.length <= 256
          if (available) {
            if (acceptedSession.current !== null && acceptedSession.current !== status.sessionId) sessionEpoch.current++
            acceptedSession.current = status.sessionId
          }
          if (!available && previouslyGranted.current) sessionEpoch.current++
          previouslyGranted.current = available
          authority.current.available = available
          setSnapshot({ scope, revision: request, pending: false, available })
        })
        .catch(() => {
          if (!active || authority.current.scope !== scope || request !== revision.current) return
          if (previouslyGranted.current) sessionEpoch.current++
          previouslyGranted.current = false
          authority.current.available = false
          setSnapshot({ scope, revision: request, pending: false, available: false })
        })
    }
    refresh()
    let deviceIdentity: string | undefined
    const retire = () => { sessionEpoch.current++; previouslyGranted.current = false }
    const offDevice = onRpcMessage('device-state', (device: any) => {
      const identity = JSON.stringify([device?.activeTransport, device?.deviceId, device?.firmwareVersion,
        device?.firmwareHash, device?.isEmulator, device?.isHiddenWallet, !!device?.bootloaderMode])
      if ((deviceIdentity !== undefined && deviceIdentity !== identity)
        || device?.state === 'disconnected' || device?.bootloaderMode === true) retire()
      deviceIdentity = identity
      refresh()
    })
    const offEmulator = onRpcMessage('emulator-status', (status: any) => {
      if (status?.state !== 'running') retire()
      refresh()
    })
    const offPurge = onRpcMessage('wallet-data-purged', () => { retire(); refresh() })
    window.addEventListener('keepkey-settings-changed', refresh)
    return () => {
      active = false
      revision.current++
      authority.current.available = false
      offDevice()
      offEmulator()
      offPurge()
      window.removeEventListener('keepkey-settings-changed', refresh)
    }
  }, [enabled, scope])

  // Event handlers can run before React commits its next render. Revoke the
  // old handler immediately when a device/settings event starts a new check.
  const renderEpoch = sessionEpoch.current
  const canSend = useCallback(() => !enabled || (authority.current.scope === scope && authority.current.available
    && renderEpoch === sessionEpoch.current), [enabled, scope, renderEpoch])
  const currentSnapshot = snapshot.scope === scope && snapshot.revision === revision.current
  return {
    available: !enabled || (currentSnapshot && snapshot.available && authority.current.available),
    pending: enabled && (!currentSnapshot || snapshot.pending),
    sessionEpoch: enabled ? sessionEpoch.current : 0,
    canSend,
  }
}
