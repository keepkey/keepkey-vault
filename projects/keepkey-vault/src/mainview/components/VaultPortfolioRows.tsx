import { useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import type { VaultIdentity } from '../../shared/vault-identity'
import type { VaultPortfolio } from '../../shared/vault-portfolio'
import { vaultLinkColor } from '../../shared/vault-wallet-links'
import { useUiTranslation } from '../i18n/ui'
import { useFiat } from '../lib/fiat-context'

/** Shared-account rows follow the same list rhythm as wallet tokens and DeFi. */
export function VaultPortfolioRows({ portfolios, onOpen, onSetIncluded, title = 'Vaults' }: {
  portfolios: VaultPortfolio[]
  onOpen?: (vault: VaultIdentity) => void
  onSetIncluded: (vaultId: string, include: boolean) => Promise<void>
  title?: string
}) {
  const uiText = useUiTranslation()
  const { fmt, privateModeEnabled } = useFiat()
  const [pending, setPending] = useState<string[]>([])
  const [error, setError] = useState('')
  if (!portfolios.length) return null
  const setIncluded = async (vaultId: string, include: boolean) => {
    setPending(rows => [...rows, vaultId])
    setError('')
    try { await onSetIncluded(vaultId, include) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setPending(rows => rows.filter(id => id !== vaultId)) }
  }
  return <Box w="100%" mt="3" aria-label={uiText('Vault accounts')}>
    <Text fontSize="10px" color="var(--text-3)" letterSpacing="0.20em" textTransform="uppercase" mb="2" px="1">
      {uiText(title)} · {portfolios.length}
    </Text>
    <Flex direction="column" gap="1">
      {portfolios.map(row => {
        const vault = row.identity
        const color = vaultLinkColor(vault.id)
        const known = typeof row.totalUsd === 'number' && Number.isFinite(row.totalUsd)
        return <Flex key={vault.id} align="center" gap="3" borderLeft={`2px solid ${color}`} borderRadius="md"
          bg="rgba(15,15,20,0.35)" pl="2" pr="2" py="2">
          <Flex asChild align="center" gap="2.5" flex="1" minW="0" textAlign="left"
            border="0" bg="transparent" p="0" cursor={onOpen ? 'pointer' : 'default'}>
            <button type="button" onClick={() => onOpen?.(vault)} title={`${vault.networkId} · ${vault.address}`}
              aria-label={`${uiText('Open vault')} ${vault.name}`}>
            <Flex align="center" justify="center" w="32px" h="36px" flexShrink="0" color={color}>
              <svg width="28" height="30" viewBox="0 0 24 26" fill="none" aria-hidden="true">
                <path d="M12 1 2 5v8c0 5 5 9 10 12 5-3 10-7 10-12V5z" stroke="currentColor" fill="currentColor" fillOpacity=".10" />
                {vault.type === 'bitcoin-multisig'
                  ? <text x="12" y="18" textAnchor="middle" fill="currentColor" fontSize="18">₿</text>
                  : <><circle cx="12" cy="12" r="6" fill="#0052ff" /><path d="M7 12h10" stroke="white" strokeWidth="1.5" /></>}
              </svg>
            </Flex>
            <Box minW="0" flex="1">
              <Text fontSize="13px" fontWeight="600" color="var(--text-0)" truncate>{vault.name}</Text>
              <Text fontSize="10px" color="var(--text-2)" truncate>
                {vault.type === 'safe' ? 'Base' : 'Bitcoin'} · {vault.threshold} {uiText('of')} {vault.cosigners.length}
                {' · '}{vault.address.slice(0, 8)}…{vault.address.slice(-6)}
              </Text>
            </Box>
            <Box textAlign="right" flexShrink="0">
              <Text color="var(--text-0)" fontSize="13px" fontWeight="600">
                {privateModeEnabled ? '••••' : known ? fmt(row.totalUsd) : '—'}
              </Text>
              <Text fontSize="10px" color={known ? 'var(--text-3)' : 'var(--gold)'}>
                {known ? uiText('Shared account') : uiText('Balance unavailable')}
              </Text>
            </Box>
            </button>
          </Flex>
          <label title={uiText('Include this vault in portfolio totals')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 4, color: 'var(--text-2)', fontSize: 10, whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input type="checkbox" checked={row.includeInTotal} disabled={pending.includes(vault.id)}
              aria-label={`${uiText('Include in total')}: ${vault.name}`}
              onChange={event => { void setIncluded(vault.id, event.target.checked) }}
              style={{ accentColor: color, width: 15, height: 15 }} />
            {uiText('Total')}
          </label>
        </Flex>
      })}
    </Flex>
    {error && <Text role="alert" color="var(--rose)" fontSize="11px" mt="2">{error}</Text>}
  </Box>
}
