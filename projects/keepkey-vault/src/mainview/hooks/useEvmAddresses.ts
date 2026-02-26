import { useState, useEffect, useCallback } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { EvmAddressSet } from '../../shared/types'

const EMPTY: EvmAddressSet = { addresses: [], selectedIndex: 0, totalBalanceUsd: 0 }

export function useEvmAddresses() {
  const [evmAddresses, setEvmAddresses] = useState<EvmAddressSet>(EMPTY)
  const [loading, setLoading] = useState(false)

  // Listen for push updates from backend
  useEffect(() => {
    const unsub = onRpcMessage('evm-addresses-update', (set: EvmAddressSet) => {
      setEvmAddresses(set)
    })
    return unsub
  }, [])

  // Fetch current state on mount
  useEffect(() => {
    rpcRequest<EvmAddressSet>('getEvmAddresses')
      .then(setEvmAddresses)
      .catch(() => {}) // Device may not be connected yet
  }, [])

  const addIndex = useCallback(async (index?: number) => {
    setLoading(true)
    try {
      const set = await rpcRequest<EvmAddressSet>('addEvmAddressIndex', { index }, 60000)
      setEvmAddresses(set)
    } catch (e: any) {
      console.error('[useEvmAddresses] addIndex failed:', e.message)
    }
    setLoading(false)
  }, [])

  const removeIndex = useCallback(async (index: number) => {
    try {
      const set = await rpcRequest<EvmAddressSet>('removeEvmAddressIndex', { index })
      setEvmAddresses(set)
    } catch (e: any) {
      console.error('[useEvmAddresses] removeIndex failed:', e.message)
    }
  }, [])

  const selectIndex = useCallback(async (index: number) => {
    try {
      await rpcRequest('setEvmSelectedIndex', { index })
    } catch (e: any) {
      console.error('[useEvmAddresses] selectIndex failed:', e.message)
    }
  }, [])

  return { evmAddresses, addIndex, removeIndex, selectIndex, loading }
}
