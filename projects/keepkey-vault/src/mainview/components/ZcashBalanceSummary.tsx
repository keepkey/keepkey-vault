import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import { formatBalance } from '../lib/formatting'
import { zcashShieldedAmounts, type ZcashShieldedBalance, type ZcashPrivacyPage } from '../../shared/zcash-privacy'
import { DocsLink } from './DocsLink'
import { DOCS_LINKS, watch } from '../../shared/docs-links'

export type ZcashPrivacyAction = ZcashPrivacyPage | 'unshield'
interface Props {
  transparent?: string
  enabled: boolean
  supported: boolean
  watchOnly?: boolean
  refreshNonce: number
  onNavigate: (action: ZcashPrivacyAction) => void
}
type PrivacyStatus = { ready: boolean; fvk_loaded: boolean; verified: boolean; verifying: boolean; synced_to: number | null }

/** Reads the shielded wallet separately; never treats a transparent refresh as
 * a privacy scan, or a missing private balance as zero. No key initialization. */
export function ZcashBalanceSummary({ transparent, enabled, supported, watchOnly, refreshNonce, onNavigate }: Props) {
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
  const amounts = zcashShieldedAmounts(balance)
  const hint = watchOnly ? t('zcashConnectForPrivacy')
    : !enabled ? t('zcashEnablePrivacy')
    : !supported ? t('zcashPrivacyFirmware')
    : failed ? t('zcashPrivateUnavailable')
    : scanActive || status?.verifying ? t('zcashPrivateScanning')
    : status?.synced_to != null ? t('zcashLastScanned', { height: status.synced_to.toLocaleString() })
    : t('zcashPrivateScanNeeded')
  return (
    <Box mb="4" border="1px solid" borderColor="var(--line)" borderRadius="12px" p="4" role="region" aria-label={t('zcashBalances')}>
      <Flex gap="5" wrap="wrap">
        <Box flex="1" minW="210px">
          <Text fontSize="12px" fontWeight="600" color="var(--text-1)">{t('zcashTransparentPublic')}</Text>
          <Text fontFamily="mono" fontSize="18px" color="var(--text-0)">{transparent == null ? '—' : formatBalance(transparent)} ZEC</Text>
          <Text fontSize="12px" color="var(--text-2)" mt="1">{t('zcashTransparentUse')}</Text>
          <Button mt="2" size="xs" variant="outline" disabled={!canOpen} onClick={() => onNavigate('shield')}>{t('zcashShieldAction')}</Button>
        </Box>
        <Box flex="1" minW="210px">
          <Text fontSize="12px" fontWeight="600" color="var(--text-1)">{t('zcashShieldedPrivate')}</Text>
          <Text fontFamily="mono" fontSize="18px" color="var(--text-0)">{amounts ? formatBalance(String(amounts.available / 1e8)) : '—'} ZEC</Text>
          <Text fontSize="12px" color={failed || !amounts ? 'var(--gold)' : 'var(--text-2)'} mt="1" aria-live="polite">{hint}</Text>
          {amounts && amounts.pending > 0 && <Text fontSize="11px" color="var(--gold)">{t('zcashPrivatePending', { amount: formatBalance(String(amounts.pending / 1e8)) })}</Text>}
          <Flex gap="2" mt="2" wrap="wrap">
            <Button size="xs" variant="outline" disabled={!canOpen} onClick={() => onNavigate('scan')}>{t('zcashSyncShielded')}</Button>
            <Button size="xs" variant="outline" disabled={!canOpen} onClick={() => onNavigate('unshield')}>{t('zcashUnshieldAction')}</Button>
          </Flex>
        </Box>
      </Flex>
      <Flex mt="3" gap="3" wrap="wrap" align="center">
        <Text fontSize="11px" color="var(--text-2)">{t('zcashSeparateSync')}</Text>
        <DocsLink href={watch('zec-04-shield-sync')} label={t('zcashShieldGuide')} />
        {!enabled && <DocsLink href={DOCS_LINKS.settingsFeatureFlags} label={t('zcashPrivacySettings')} />}
      </Flex>
    </Box>
  )
}
