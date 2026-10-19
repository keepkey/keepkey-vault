import { looksLikeMultisigPolicy, MULTISIG_POLICY_EVENT } from '../../shared/multisig-policy'
import { useState, useEffect, useRef, useCallback } from 'react'
import { hex } from '@scure/base'
import { BitcoinQrDecoder } from '../../shared/bitcoin-qr'
import { QrScannerOverlay } from './QrScannerOverlay'

export const BITCOIN_QR_SCAN_EVENT = 'keepkey-bitcoin-qr-scan'

/** One global QR entry works with no device or wallet. Backend parsers perform
 * the same validation/review as file imports. Completion never signs or sends. */
export function BitcoinQrImport() {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(0)
  const [images, setImages] = useState<File[] | undefined>()
  const [status, setStatus] = useState('Scan a PSBT, signed transaction or public wallet QR')
  const decoder = useRef(new BitcoinQrDecoder())
  const reset = useCallback(() => { decoder.current = new BitcoinQrDecoder(); setStatus('Scan a PSBT, signed transaction or public wallet QR') }, [])
  useEffect(() => {
    const onOpen = (event: Event) => {
      reset()
      setSession(n => n + 1)
      setImages((event as CustomEvent<File[] | undefined>).detail)
      setOpen(true)
    }
    window.addEventListener(BITCOIN_QR_SCAN_EVENT, onOpen)
    return () => window.removeEventListener(BITCOIN_QR_SCAN_EVENT, onOpen)
  }, [reset])
  const receive = useCallback((frame: string) => {
    const progress = decoder.current.receive(frame)
    if (!progress.result) {
      setStatus(`${Math.round(progress.progress * 100)}% · ${progress.received} of ${progress.total} parts · Keep scanning`)
      return false
    }
    const { bytes, kind } = progress.result
    const file = new File([kind === 'transaction' ? hex.encode(bytes) : new Uint8Array(bytes)], kind === 'psbt' ? 'scanned.psbt' : kind === 'wallet' ? 'scanned-public-wallet.json' : 'scanned-transaction.txn')
    // Event strings avoid circular imports between the global dialogs.
    window.dispatchEvent(new CustomEvent(kind === 'psbt' ? 'keepkey-psbt-drop' : kind === 'wallet' ? (looksLikeMultisigPolicy(new TextDecoder().decode(bytes)) ? MULTISIG_POLICY_EVENT : 'keepkey-watch-only-import') : 'keepkey-btc-broadcast', { detail: file }))
    setOpen(false)
    return true
  }, [])
  if (!open) return null
  return <QrScannerOverlay key={session} title="Scan Bitcoin QR" onFrame={receive} onScan={() => {}} onClose={() => setOpen(false)} onReset={reset} status={status} initialImages={images} />
}
