import { useState, useEffect, useCallback, useRef } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { EvmAddressSet } from '../../shared/types'

const EMPTY: EvmAddressSet = { addresses: [], selectedIndex: 0, totalBalanceUsd: 0 }

export function useEvmAddresses() {
  const [evmAddresses, setEvmAddresses] = useState<EvmAddressSet>(EMPTY)
  const [loading, setLoading] = useState(false)
  const revision = useRef(0)

  // Listen for push updates from backend
  useEffect(() => {
    const unsub = onRpcMessage('evm-addresses-update', (set: EvmAddressSet) => {
      revision.current++
      setEvmAddresses(set)
    })
    const purge = onRpcMessage('wallet-data-purged', () => {
      revision.current++
      setEvmAddresses(EMPTY)
    })
    return () => { unsub(); purge() }
  }, [])

  // Fetch current state on mount
  useEffect(() => {
    let active = true
    const requested = revision.current
    rpcRequest<EvmAddressSet>('getEvmAddresses')
      .then(set => { if (active && revision.current === requested) setEvmAddresses(set) })
      .catch(() => {}) // Device may not be connected yet
    return () => { active = false }
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
