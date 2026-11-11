import { useState, useEffect, useCallback, useRef } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { BtcAccountSet, BtcScriptType } from '../../shared/types'

const EMPTY: BtcAccountSet = { accounts: [], totalBalanceUsd: 0, totalBalance: '0' }

export function useBtcAccounts(enabled = true) {
  const [btcAccounts, setBtcAccounts] = useState<BtcAccountSet>(EMPTY)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const refreshInFlight = useRef<Promise<void> | null>(null)
  const generation = useRef(0)
  const revision = useRef(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const refresh = useCallback((): Promise<void> => {
    if (!enabledRef.current) return Promise.resolve()
    if (refreshInFlight.current) return refreshInFlight.current
    const requestedGeneration = generation.current
    const requestedRevision = revision.current
    const current = () => enabledRef.current && generation.current === requestedGeneration
    setLoading(true)
    setError(null)
    const request = rpcRequest<BtcAccountSet>('getBtcAccounts')
      .then(set => {
        if (!current() || revision.current !== requestedRevision) return
        setBtcAccounts(set)
        setError(null)
      })
      .catch((e: any) => {
        if (!current() || revision.current !== requestedRevision) return
        const message = e?.message || String(e)
        console.error('[useBtcAccounts] getBtcAccounts failed:', message)
        setError(message)
      })
      .finally(() => {
        if (refreshInFlight.current === request) {
          refreshInFlight.current = null
          if (current()) setLoading(false)
        }
      })
    refreshInFlight.current = request
    return request
  }, [])

  // Listen for push updates from backend
  useEffect(() => {
    if (!enabled) return
    const unsub = onRpcMessage('btc-accounts-update', (set: BtcAccountSet) => {
      revision.current++
      setBtcAccounts(set)
      if (set.accounts.length > 0) setError(null)
    })
    const purge = onRpcMessage('wallet-data-purged', () => {
      generation.current++
      revision.current++
      refreshInFlight.current = null
      setBtcAccounts(EMPTY)
      setLoading(false)
      setError(null)
    })
    return () => { unsub(); purge() }
  }, [enabled])

  // Fetch current state on mount. AssetPage can mount before the device reaches
  // ready (especially for bitcoin-only firmware), so a ready transition retries
  // instead of leaving the one failed mount request as a permanent blank slot.
  useEffect(() => {
    generation.current++
    if (!enabled) {
      refreshInFlight.current = null
      setBtcAccounts(EMPTY)
      setLoading(false)
      setError(null)
      return
    }
    void refresh()
    const unsubscribe = onRpcMessage('device-state', (state: any) => {
      if (state?.state === 'ready') void refresh()
    })
    return () => { generation.current++; refreshInFlight.current = null; unsubscribe() }
  }, [refresh, enabled])

  const addAccount = useCallback(async () => {
    if (!enabledRef.current) return
    const requestedGeneration = generation.current
    const current = () => enabledRef.current && generation.current === requestedGeneration
    setLoading(true)
    try {
      const set = await rpcRequest<BtcAccountSet>('addBtcAccount', undefined, 60000)
      if (!current()) return
      setBtcAccounts(set)
      setError(null)
    } catch (e: any) {
      if (!current()) return
      console.error('[useBtcAccounts] addAccount failed:', e.message)
      setError(e?.message || String(e))
    }
    if (current()) setLoading(false)
  }, [])

  const selectXpub = useCallback(async (accountIndex: number, scriptType: BtcScriptType) => {
    if (!enabledRef.current) return
    try {
      await rpcRequest('setBtcSelectedXpub', { accountIndex, scriptType })
    } catch (e: any) {
      console.error('[useBtcAccounts] selectXpub failed:', e.message)
    }
  }, [])

  return { btcAccounts: enabled ? btcAccounts : EMPTY, addAccount, selectXpub, refresh, loading: enabled && loading, error: enabled ? error : null }
}
