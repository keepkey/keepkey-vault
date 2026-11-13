import { useState, useEffect } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { DeviceStateInfo } from '../../shared/types'
import { retainLivePortfolioSession, type LivePortfolioSession } from '../../shared/app-phase'

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
  isEmulator: false,
}

export function useDeviceState() {
  const [snapshot, setSnapshot] = useState<{ device: DeviceStateInfo; portfolio: LivePortfolioSession | null }>({ device: DEFAULT_STATE, portfolio: null })

  useEffect(() => {
    // Reduce every pushed state, even when React batches a quick replug into
    // one render. A ready device before disconnect cannot authorize browsing
    // a locked device after reconnect, even when its device id is identical.
    const receive = (device: DeviceStateInfo) => setSnapshot(previous => ({
      device, portfolio: retainLivePortfolioSession(previous.portfolio, device),
    }))
    let receivedPush = false
    // Listen for pushed device-state messages from Bun
    const unsubscribe = onRpcMessage('device-state', (payload: DeviceStateInfo) => {
      receivedPush = true
      receive(payload)
    })
    const unsubscribePurge = onRpcMessage('wallet-data-purged', () => {
      receivedPush = true
      setSnapshot(previous => ({ ...previous, portfolio: null }))
    })

    // Fetch initial state — retry until success (Windows WebView2 RPC may not be ready)
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const fetchInitial = (attempt: number) => {
      rpcRequest<DeviceStateInfo>('getDeviceState').then((state) => {
        // A late initial reply must not undo a newer push/disconnect.
        if (!cancelled && !receivedPush) receive(state)
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
    // A push sent before the webview listens is lost (Windows WebView2 at
    // launch): a KeepKey plugged in locked before launch then sat on
    // "searching" until a click. Re-sync until the first push arrives.
    // ponytail: 2s poll for 30s, bounded; a ready-handshake would replace it.
    let resyncs = 0
    const resync = setInterval(() => {
      if (cancelled || receivedPush || ++resyncs > 15) { clearInterval(resync); return }
      rpcRequest<DeviceStateInfo>('getDeviceState').then((state) => {
        if (!cancelled && !receivedPush) receive(state)
      }).catch(() => {})
    }, 2000)

    return () => {
      cancelled = true
      clearInterval(resync)
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribe()
      unsubscribePurge()
    }
  }, [])

  return { ...snapshot.device, lockedPortfolioAvailable: snapshot.device.state === 'needs_pin' && snapshot.portfolio !== null }
}
