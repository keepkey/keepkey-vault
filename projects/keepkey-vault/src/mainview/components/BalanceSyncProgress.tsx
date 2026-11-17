import { useEffect, useState } from 'react'
import { Box, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import type { SyncProgress } from '../../shared/sync-progress'
import { onRpcMessage, rpcRequest } from '../lib/rpc'

/** Percentages count settled work within the named stage, not estimated time
 * or a claim that all provider balances have been verified. */
export function BalanceSyncProgress({ loading }: { loading: boolean }) {
  const { t } = useTranslation('dashboard')
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  useEffect(() => {
    let alive = true, revision = 0
    const off = onRpcMessage('balance-sync-progress', value => {
      revision++
      if (alive) setProgress(value as SyncProgress)
    })
    const before = revision
    void rpcRequest<{balanceSync?: SyncProgress | null}>('getSyncDiagnostics').then(value => {
      if (alive && revision === before && value?.balanceSync) setProgress(value.balanceSync)
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [])
  if (!loading || !progress || progress.status !== 'running') return null
  const stage = t(`syncStage_${progress.stage}`)
  const seconds = Math.floor(progress.elapsedMs / 1000)
  return <Box mb="3" px="3" py="2" border="1px solid" borderColor="kk.border" borderRadius="md" role="status" aria-live="polite">
    <Flex justify="space-between" gap="3" wrap="wrap">
      <Text fontSize="xs" color="kk.textSecondary">{stage}</Text>
      <Text fontSize="xs" fontFamily="mono" color="kk.gold">{progress.total > 0
        ? t('syncProgressCounts', { completed: progress.completed, total: progress.total, percent: progress.percent ?? 0, seconds })
        : t('syncProgressElapsed', { seconds })}</Text>
    </Flex>
    {progress.total > 0 && <Box mt="2" h="3px" bg="whiteAlpha.100" borderRadius="full" overflow="hidden"
      role="progressbar" aria-label={stage} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}>
      <Box h="full" bg="kk.gold" width={`${progress.percent ?? 0}%`} transition="width 0.2s" />
    </Box>}
    {progress.failed > 0 && <Text mt="1" fontSize="xs" color="orange.300">{t('syncFailedChecks', { failed: progress.failed })}</Text>}
  </Box>
}
