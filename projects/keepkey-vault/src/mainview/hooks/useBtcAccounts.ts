import { useState, useEffect, useCallback, useRef } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { BtcAccountSet, BtcScriptType } from '../../shared/types'

const EMPTY: BtcAccountSet = { accounts: [], totalBalanceUsd: 0, totalBalance: '0' }

export function useBtcAccounts() {
  const [btcAccounts, setBtcAccounts] = useState<BtcAccountSet>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refreshInFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current
    setLoading(true)
    setError(null)
    const request = rpcRequest<BtcAccountSet>('getBtcAccounts')
      .then(set => {
        setBtcAccounts(set)
        setError(null)
      })
      .catch((e: any) => {
        const message = e?.message || String(e)
        console.error('[useBtcAccounts] getBtcAccounts failed:', message)
        setError(message)
      })
      .finally(() => {
        if (refreshInFlight.current === request) refreshInFlight.current = null
        setLoading(false)
      })
    refreshInFlight.current = request
    return request
  }, [])

  // Listen for push updates from backend
  useEffect(() => {
    const unsub = onRpcMessage('btc-accounts-update', (set: BtcAccountSet) => {
      setBtcAccounts(set)
      if (set.accounts.length > 0) setError(null)
    })
    return unsub
  }, [])

  // Fetch current state on mount. AssetPage can mount before the device reaches
  // ready (especially for bitcoin-only firmware), so a ready transition retries
  // instead of leaving the one failed mount request as a permanent blank slot.
  useEffect(() => {
    void refresh()
    return onRpcMessage('device-state', (state: any) => {
      if (state?.state === 'ready') void refresh()
    })
  }, [refresh])

  const addAccount = useCallback(async () => {
    setLoading(true)
    try {
      const set = await rpcRequest<BtcAccountSet>('addBtcAccount', undefined, 60000)
      setBtcAccounts(set)
      setError(null)
    } catch (e: any) {
      console.error('[useBtcAccounts] addAccount failed:', e.message)
      setError(e?.message || String(e))
    }
    setLoading(false)
  }, [])

  const selectXpub = useCallback(async (accountIndex: number, scriptType: BtcScriptType) => {
    try {
      await rpcRequest('setBtcSelectedXpub', { accountIndex, scriptType })
    } catch (e: any) {
      console.error('[useBtcAccounts] selectXpub failed:', e.message)
    }
  }, [])

  return { btcAccounts, addAccount, selectXpub, refresh, loading, error }
}
