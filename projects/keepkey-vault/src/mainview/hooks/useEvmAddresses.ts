import { useState, useEffect, useCallback, useRef } from 'react'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { EvmAddressSet } from '../../shared/types'

const EMPTY: EvmAddressSet = { addresses: [], selectedIndex: 0, totalBalanceUsd: 0 }

export function useEvmAddresses(enabled = true) {
  const [evmAddresses, setEvmAddresses] = useState<EvmAddressSet>(EMPTY)
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const revision = useRef(0)
  const generation = useRef(0)
  const mounted = useRef(true)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const pending = useRef<{ generation: number; revision: number; promise: Promise<void> } | null>(null)
  const pendingAdd = useRef<object | null>(null)

  const isCurrentScope = useCallback((requestedGeneration: number, requestedRevision: number) => (
    mounted.current && enabledRef.current && generation.current === requestedGeneration && revision.current === requestedRevision
  ), [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  const refresh = useCallback((): Promise<void> => {
    if (!enabledRef.current) return Promise.resolve()
    const requestedGeneration = generation.current
    const requestedRevision = revision.current
    if (pending.current?.generation === requestedGeneration && pending.current.revision === requestedRevision) return pending.current.promise
    const read = {
      generation: requestedGeneration,
      revision: requestedRevision,
      promise: Promise.resolve() as Promise<void>,
    }
    read.promise = rpcRequest<EvmAddressSet>('getEvmAddresses')
      .then(set => {
        if (mounted.current && enabledRef.current && generation.current === requestedGeneration && revision.current === requestedRevision) {
          setEvmAddresses(set)
        }
      })
      .finally(() => {
        if (mounted.current && enabledRef.current && generation.current === requestedGeneration && revision.current === requestedRevision) setInitialLoaded(true)
        if (pending.current === read) pending.current = null
      })
    pending.current = read
    return read.promise
  }, [])

  // Listen for push updates from backend
  useEffect(() => {
    const unsub = enabled ? onRpcMessage('evm-addresses-update', (set: EvmAddressSet) => {
      revision.current++
      pendingAdd.current = null
      setLoading(false)
      setEvmAddresses(set)
      setInitialLoaded(true)
    }) : () => {}
    const purge = onRpcMessage('wallet-data-purged', () => {
      revision.current++
      pendingAdd.current = null
      setLoading(false)
      setEvmAddresses(EMPTY)
      // A purge is an explicit empty snapshot, not an initial request that
      // consumers may bridge with the previous wallet's address.
      setInitialLoaded(true)
    })
    return () => { unsub(); purge() }
  }, [enabled])

  // Disabled non-EVM screens must not compete with a foreground device read.
  // Re-enable starts a new generation so an older mount/read cannot win a race.
  useEffect(() => {
    generation.current++
    pendingAdd.current = null
    setLoading(false)
    setInitialLoaded(false)
    if (!enabled) {
      revision.current++
      setEvmAddresses(EMPTY)
    } else void refresh().catch(() => {}) // Device may not be connected yet.
    return () => { generation.current++; pending.current = null }
  }, [enabled, refresh])

  const addIndex = useCallback(async (index?: number) => {
    if (!mounted.current || !enabledRef.current) return
    const requestedGeneration = generation.current
    const requestedRevision = revision.current
    const request = {}
    pendingAdd.current = request
    setLoading(true)
    try {
      const set = await rpcRequest<EvmAddressSet>('addEvmAddressIndex', { index }, 60000)
      if (isCurrentScope(requestedGeneration, requestedRevision)) setEvmAddresses(set)
    } catch (e: any) {
      if (isCurrentScope(requestedGeneration, requestedRevision)) console.error('[useEvmAddresses] addIndex failed:', e.message)
    } finally {
      if (pendingAdd.current === request) {
        pendingAdd.current = null
        if (isCurrentScope(requestedGeneration, requestedRevision)) setLoading(false)
      }
    }
  }, [isCurrentScope])

  const removeIndex = useCallback(async (index: number) => {
    if (!mounted.current || !enabledRef.current) return
    const requestedGeneration = generation.current
    const requestedRevision = revision.current
    try {
      const set = await rpcRequest<EvmAddressSet>('removeEvmAddressIndex', { index })
      if (isCurrentScope(requestedGeneration, requestedRevision)) setEvmAddresses(set)
    } catch (e: any) {
      if (isCurrentScope(requestedGeneration, requestedRevision)) console.error('[useEvmAddresses] removeIndex failed:', e.message)
    }
  }, [isCurrentScope])

  const selectIndex = useCallback(async (index: number) => {
    if (!mounted.current || !enabledRef.current) return
    const requestedGeneration = generation.current
    const requestedRevision = revision.current
    try {
      await rpcRequest('setEvmSelectedIndex', { index })
    } catch (e: any) {
      if (isCurrentScope(requestedGeneration, requestedRevision)) console.error('[useEvmAddresses] selectIndex failed:', e.message)
    }
  }, [isCurrentScope])

  return { evmAddresses: enabled ? evmAddresses : EMPTY, initialLoaded: enabled && initialLoaded, refresh, addIndex, removeIndex, selectIndex, loading }
}
