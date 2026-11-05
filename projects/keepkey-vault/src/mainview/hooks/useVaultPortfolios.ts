import { useCallback, useEffect, useRef, useState } from 'react'
import { assertVaultPortfolioResponse, type VaultPortfolio } from '../../shared/vault-portfolio'
import { onRpcMessage, rpcRequest } from '../lib/rpc'

export const VAULT_PORTFOLIO_CHANGED = 'vault-portfolio-changed'

/** Vault balances have their own account scope. Never merge them into a
 * connected device's address or spendable balance cache. */
export function useVaultPortfolios({ enabled = true, bitcoinOnly = false }: {
  enabled?: boolean
  bitcoinOnly?: boolean
} = {}) {
  const [portfolios, setPortfolios] = useState<VaultPortfolio[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const scope = useRef(0)
  const mounted = useRef(true)

  const reload = useCallback(async (refresh = false) => {
    if (!enabled) return
    const request = ++generation.current
    setLoading(true)
    try {
      const result = await rpcRequest<VaultPortfolio[]>('getVaultPortfolios', { refresh }, 60_000)
      if (!mounted.current || request !== generation.current) return
      for (const row of result) assertVaultPortfolioResponse(row.identity, row)
      setPortfolios(result.filter(p => !bitcoinOnly || p.identity.type === 'bitcoin-multisig'))
      setError('')
    } catch (err) {
      if (mounted.current && request === generation.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false)
    }
  }, [enabled, bitcoinOnly])

  useEffect(() => {
    scope.current++
    mounted.current = true
    if (!enabled) {
      setPortfolios([])
      setLoading(false)
      return
    }
    void reload()
    const changed = () => { void reload() }
    const purge = () => {
      scope.current++
      generation.current++
      setPortfolios([])
      setError('')
      void reload()
    }
    const off = onRpcMessage('vaults-changed', changed)
    const offPurge = onRpcMessage('wallet-data-purged', purge)
    const preferences = (event: Event) => {
      const value = (event as CustomEvent<{ vaultId: string; include: boolean }>).detail
      if (value) setPortfolios(rows => rows.map(row => row.identity.id === value.vaultId
        ? { ...row, includeInTotal: value.include } : row))
      void reload()
    }
    window.addEventListener(VAULT_PORTFOLIO_CHANGED, preferences)
    return () => {
      scope.current++
      mounted.current = false
      generation.current++
      off()
      offPurge()
      window.removeEventListener(VAULT_PORTFOLIO_CHANGED, preferences)
    }
  }, [enabled, reload])

  const setIncluded = useCallback(async (vaultId: string, include: boolean) => {
    const currentScope = scope.current
    await rpcRequest('setVaultTotalInclusion', { vaultId, include }, 10_000)
    if (!mounted.current || currentScope !== scope.current) return
    setPortfolios(rows => rows.map(row => row.identity.id === vaultId
      ? { ...row, includeInTotal: include } : row))
    window.dispatchEvent(new CustomEvent(VAULT_PORTFOLIO_CHANGED, { detail: { vaultId, include } }))
  }, [])

  return { portfolios, loading, error, reload, setIncluded }
}
