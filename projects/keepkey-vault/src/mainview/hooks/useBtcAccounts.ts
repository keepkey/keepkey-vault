import { useState, useEffect, useCallback } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { BtcAccountSet, BtcScriptType } from '../../shared/types'

const EMPTY: BtcAccountSet = { accounts: [], totalBalanceUsd: 0, totalBalance: '0' }

export function useBtcAccounts() {
  const [btcAccounts, setBtcAccounts] = useState<BtcAccountSet>(EMPTY)
  const [loading, setLoading] = useState(false)

  // Listen for push updates from backend
  useEffect(() => {
    const unsub = onRpcMessage('btc-accounts-update', (set: BtcAccountSet) => {
      setBtcAccounts(set)
    })
    return unsub
  }, [])

  // Fetch current state on mount
  useEffect(() => {
    rpcRequest<BtcAccountSet>('getBtcAccounts')
      .then(setBtcAccounts)
      .catch(() => {}) // Device may not be connected yet
  }, [])

  const addAccount = useCallback(async () => {
    setLoading(true)
    try {
      const set = await rpcRequest<BtcAccountSet>('addBtcAccount', undefined, 60000)
      setBtcAccounts(set)
    } catch (e: any) {
      console.error('[useBtcAccounts] addAccount failed:', e.message)
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

  return { btcAccounts, addAccount, selectXpub, loading }
}
