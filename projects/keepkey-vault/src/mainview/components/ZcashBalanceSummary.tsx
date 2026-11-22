import { getNumberLocale } from "../lib/number-locale"
import { useCallback, useEffect, useState } from 'react'
import { Flex, Text, chakra } from '@chakra-ui/react'
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
  /** The shielded panel below owns scan status and the Sync button; show only real problems here. */
  hideScanHint?: boolean
}
type PrivacyStatus = { ready: boolean; fvk_loaded: boolean; verified: boolean; verifying: boolean; synced_to: number | null }

/** Reads the shielded wallet separately; never treats a transparent refresh as
 * a privacy scan, or a missing private balance as zero. No key initialization. */
export function ZcashBalanceSummary({ transparent, enabled, supported, watchOnly, refreshNonce, pool, onSelectPool, hideScanHint }: Props) {
  const { t } = useTranslation('asset')
  const [status, setStatus] = useState<PrivacyStatus | null>(null)
  const [balance, setBalance] = useState<ZcashShieldedBalance | null>(null)
  const [scanActive, setScanActive] = useState(false)
  const [failed, setFailed] = useState(false)
  const [transparentPendingZat, setTransparentPendingZat] = useState(0)
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
    setStatus(null); setBalance(null); setFailed(false); setTransparentPendingZat(0)
    if (!canOpen) return
    // Public funds still maturing (e.g. a fresh unshield) are not in the confirmed balance.
    void rpcRequest<{ pendingZat: number }>('zcashTransparentBalance', undefined, 20000)
      .then(r => { if (!cancelled && Number.isFinite(r.pendingZat)) setTransparentPendingZat(r.pendingZat) }).catch(() => {})
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
  const fullHint = watchOnly ? t('zcashConnectForPrivacy')
    : !enabled ? t('zcashEnablePrivacy')
    : !supported ? t('zcashPrivacyFirmware')
    : failed ? t('zcashPrivateUnavailable')
    : scanActive || status?.verifying ? t('zcashPrivateScanning')
    : status?.synced_to != null ? t('zcashLastScanned', { height: status.synced_to.toLocaleString(getNumberLocale()) })
    : t('zcashPrivateScanNeeded')
  const hint = hideScanHint && !failed ? '' : fullHint
  // Public = orange (visible on chain), Private = teal (hidden); the selected pool gets a tinted fill.
  const PUBLIC = '#f0883e', PRIVATE = 'var(--teal)'
  const tile = (selected: boolean, disabled: boolean, color: string, tint: string) => ({
    type: 'button' as const, textAlign: 'left' as const, px: '3.5', py: '2', borderRadius: '12px', minW: '150px',
    border: '1px solid', borderColor: selected ? color : 'var(--line)', borderLeftWidth: '3px', borderLeftColor: color,
    bg: selected ? tint : 'transparent', opacity: disabled ? 0.5 : selected ? 1 : 0.8, cursor: disabled ? 'not-allowed' : 'pointer',
    _hover: disabled ? {} : { opacity: 1, bg: tint }, _focusVisible: { outline: `2px solid ${color}`, outlineOffset: '2px' },
  })
  const label = (text: string, color: string, selected: boolean) => (
    <Text fontSize="11px" fontWeight="600" letterSpacing="0.04em" textTransform="uppercase" color={color}>{text}{selected ? ' ✓' : ''}</Text>
  )
  // Header: both pools side by side, each one a selector.
  return (
    <Flex direction="column" align="flex-end" gap="1.5" role="group" aria-label={t('zcashBalances')} css={{ fontVariantNumeric: 'tabular-nums' }}>
      <Flex gap="2">
        <chakra.button {...tile(pool === 'transparent', false, PUBLIC, 'rgba(240,136,62,0.10)')} aria-pressed={pool === 'transparent'} aria-label={t('zcashTransparentPublic')}
          onClick={() => onSelectPool('transparent')}>
          {label(t('zcashTransparentPublic'), PUBLIC, pool === 'transparent')}
          <Text fontFamily="mono" fontSize="18px" fontWeight="600" color="var(--text-0)" whiteSpace="nowrap">{transparent == null ? '—' : formatBalance(transparent)} ZEC</Text>
          {transparentPendingZat > 0 && <Text fontSize="11px" color={PUBLIC}>{t('zcashPrivatePending', { amount: formatBalance(String(transparentPendingZat / 1e8)) })}</Text>}
        </chakra.button>
        <chakra.button {...tile(pool === 'shielded', !canOpen, PRIVATE, 'rgba(45,212,191,0.10)')} aria-pressed={pool === 'shielded'} aria-label={t('zcashShieldedPrivate')} disabled={!canOpen}
          onClick={() => onSelectPool('shielded')}>
          {label(t('zcashShieldedPrivate'), PRIVATE, pool === 'shielded')}
          <Text fontFamily="mono" fontSize="18px" fontWeight="600" color="var(--text-0)" whiteSpace="nowrap">{amounts ? formatBalance(String(amounts.available / 1e8)) : '—'} ZEC</Text>
          {amounts && amounts.pending > 0 && <Text fontSize="11px" color={PRIVATE}>{t('zcashPrivatePending', { amount: formatBalance(String(amounts.pending / 1e8)) })}</Text>}
        </chakra.button>
      </Flex>
      {hint && <Text fontSize="11px" color={failed || !amounts ? 'var(--gold)' : 'var(--text-2)'} aria-live="polite">{hint}</Text>}
    </Flex>
  )
}
