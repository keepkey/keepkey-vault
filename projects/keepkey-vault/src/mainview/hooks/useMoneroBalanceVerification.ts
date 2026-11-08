import { useCallback, useEffect, useRef, useState } from 'react'
import type { MoneroClient } from '../lib/monero-client'
import { verifyMoneroBalance } from '../lib/monero-flow'
import type { MoneroStatusState } from './useMoneroStatus'

/** Check spent outputs when XMR opens; a declined prompt waits for an explicit retry. */
export function useMoneroBalanceVerification(monero: MoneroStatusState, client: MoneroClient) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attempted = useRef('')
  const mounted = useRef(true)
  const status = monero.status
  const currentAddress = useRef(status?.address)
  const operationAddress = useRef(status?.address)
  currentAddress.current = status?.address
  const fingerprint = status
    ? `${status.address}:${status.connection?.activeNode ?? ""}:${status.connection?.sessionId ?? 0}:${status.balanceAtomic}:${status.transactions.map(tx => `${tx.txid}:${tx.type ?? ''}:${tx.locked}`).join(',')}` : ''

  const currentFingerprint = useRef(fingerprint)
  currentFingerprint.current = fingerprint
  const declined = !!error && operationAddress.current === status?.address && /declin|reject|cancel/i.test(error)

  const verify = useCallback(async () => {
    attempted.current = currentFingerprint.current
    const address = currentAddress.current
    operationAddress.current = address
    setBusy(true)
    setError(null)
    try {
      const next = await verifyMoneroBalance(client)
      if (!mounted.current || currentAddress.current !== address) return
      if (next.address !== address) throw new Error('The wallet changed. Try verifying the balance again.')
      monero.setStatus(next)
    } catch (error) {
      if (mounted.current && currentAddress.current === address) {
        setError(error instanceof Error ? error.message : 'Unable to verify the balance. Try again.')
      }
    } finally {
      if (mounted.current && currentAddress.current === address) setBusy(false)
    }
  }, [client, monero.setStatus])

  useEffect(() => {
    mounted.current = true
    // Verifying spent outputs is independent of whether this build can sign a send.
    if (!declined && status?.available && status.monitorReady
        && (!status.spendStateKnown || !status.keyImagesSynced || status.keyImagesStale)
        && status.balanceAtomic !== '0' && attempted.current !== fingerprint) {
      attempted.current = fingerprint
      void verify()
    }
    return () => { mounted.current = false }
  }, [fingerprint, declined, status?.available, status?.monitorReady, status?.spendStateKnown, status?.keyImagesSynced, status?.keyImagesStale, verify])

  const sameWallet = operationAddress.current === status?.address
  return { busy: sameWallet && busy, error: sameWallet ? error : null, retry: verify }
}
