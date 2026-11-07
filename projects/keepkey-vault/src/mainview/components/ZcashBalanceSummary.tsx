import { getNumberLocale } from "../lib/number-locale"
import { useCallback, useEffect, useState } from 'react'
import { Box, Flex, Text, chakra } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import { formatBalance } from '../lib/formatting'
import { zcashShieldedAmounts, type ZcashShieldedBalance, type ZcashPool } from '../../shared/zcash-privacy'

interface Props {
  transparent?: string
  enabled: boolean
  supported: boolean
  watchOnly?: boolean
  refreshNonce: number
  pool: ZcashPool
  onSelectPool: (pool: ZcashPool) => void
}
type PrivacyStatus = { ready: boolean; fvk_loaded: boolean; verified: boolean; verifying: boolean; synced_to: number | null }

/** Reads the shielded wallet separately; never treats a transparent refresh as
 * a privacy scan, or a missing private balance as zero. No key initialization. */
export function ZcashBalanceSummary({ transparent, enabled, supported, watchOnly, refreshNonce, pool, onSelectPool }: Props) {
  const { t } = useTranslation('asset')
  const [status, setStatus] = useState<PrivacyStatus | null>(null)
  const [balance, setBalance] = useState<ZcashShieldedBalance | null>(null)
  const [scanActive, setScanActive] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const canOpen = enabled && supported && !watchOnly
  const refresh = useCallback(() => setRevision(n => n + 1), [])
  useEffect(() => onRpcMessage('zcash-rescan-complete', refresh), [refresh])
  useEffect(() => onRpcMessage('scan-progress', (progress: { percent: number }) => {
    setScanActive(progress.percent < 100)
    if (progress.percent >= 100) refresh()
  }), [refresh])
  useEffect(() => {
    let cancelled = false
    setStatus(null); setBalance(null); setFailed(false)
    if (!canOpen) return
    void (async () => {
      try {
        const next = await rpcRequest<PrivacyStatus>('zcashShieldedStatus', undefined, 10000)
        if (cancelled) return
        setStatus(next)
        if (!next.ready || !next.fvk_loaded || !next.verified) return
        const snapshot = await rpcRequest<ZcashShieldedBalance>('zcashShieldedBalance', undefined, 10000)
        if (!cancelled) setBalance(snapshot)
      } catch { if (!cancelled) setFailed(true) }
    })()
    return () => { cancelled = true }
  }, [canOpen, refreshNonce, revision])
  const amounts = canOpen ? zcashShieldedAmounts(balance) : null
  const hint = watchOnly ? t('zcashConnectForPrivacy')
    : !enabled ? t('zcashEnablePrivacy')
    : !supported ? t('zcashPrivacyFirmware')
    : failed ? t('zcashPrivateUnavailable')
    : scanActive || status?.verifying ? t('zcashPrivateScanning')
    : status?.synced_to != null ? t('zcashLastScanned', { height: status.synced_to.toLocaleString(getNumberLocale()) })
    : t('zcashPrivateScanNeeded')
  return (
    <Box mb="4" role="group" aria-label={t('zcashBalances')}>
      <Flex gap="2" wrap="wrap">
        <chakra.button type="button" flex="1" minW="200px" textAlign="left" p="3.5" borderRadius="12px"
          aria-pressed={pool === 'transparent'} aria-label={t('zcashTransparentPublic')}
          border="1px solid" borderColor={pool === 'transparent' ? 'var(--gold)' : 'var(--line)'}
          bg={pool === 'transparent' ? 'rgba(233,196,106,0.05)' : 'transparent'} cursor="pointer"
          _hover={{ borderColor: 'var(--line-2)' }} _focusVisible={{ outline: '2px solid var(--gold)', outlineOffset: '2px' }}
          onClick={() => onSelectPool('transparent')}>
          <Text fontSize="12px" fontWeight="600" color="var(--text-1)">{t('zcashTransparentPublic')}{pool === 'transparent' ? ' · ✓' : ''}</Text>
          <Text fontFamily="mono" fontSize="18px" color="var(--text-0)">{transparent == null ? '—' : formatBalance(transparent)} ZEC</Text>
        </chakra.button>
        <chakra.button type="button" flex="1" minW="200px" textAlign="left" p="3.5" borderRadius="12px"
          aria-pressed={pool === 'shielded'} aria-label={t('zcashShieldedPrivate')} disabled={!canOpen}
          border="1px solid" borderColor={pool === 'shielded' ? 'var(--gold)' : 'var(--line)'}
          bg={pool === 'shielded' ? 'rgba(233,196,106,0.05)' : 'transparent'} cursor={canOpen ? 'pointer' : 'not-allowed'}
          _hover={canOpen ? { borderColor: 'var(--line-2)' } : {}} _focusVisible={{ outline: '2px solid var(--gold)', outlineOffset: '2px' }}
          onClick={() => onSelectPool('shielded')}>
          <Text fontSize="12px" fontWeight="600" color="var(--text-1)">{t('zcashShieldedPrivate')}{pool === 'shielded' ? ' · ✓' : ''}</Text>
          <Text fontFamily="mono" fontSize="18px" color="var(--text-0)">{amounts ? formatBalance(String(amounts.available / 1e8)) : '—'} ZEC</Text>
          {amounts && amounts.pending > 0 && <Text fontSize="11px" color="var(--gold)">{t('zcashPrivatePending', { amount: formatBalance(String(amounts.pending / 1e8)) })}</Text>}
        </chakra.button>
      </Flex>
      <Text fontSize="11px" color={failed || !amounts ? 'var(--gold)' : 'var(--text-2)'} mt="2" aria-live="polite">{hint}</Text>
    </Box>
  )
}
