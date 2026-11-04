/**
 * SwapRpcMount — top-level listener for `swap-cmd:open` messages.
 *
 * SwapDialog is normally mounted by AssetPage (per-chain swap button) or
 * ActivityTracker (resume from history). When neither owns it but a REST
 * caller wants to open the swap flow via /api/v2/swap/open, this mount
 * provides a third entry point. While the dialog is up, the dialog itself
 * listens for the rest of the swap-cmd kinds (set, requote, close).
 */
import { useEffect, useState, lazy, Suspense } from "react"
import { onRpcMessage, dispatchLocalRpcMessage } from "../lib/rpc"
import type { SwapUiCommand } from "../../shared/types"

const SwapDialog = lazy(() => import("./SwapDialog").then(m => ({ default: m.SwapDialog })))

// This effect belongs inside Suspense's primary tree. It cannot commit while
// the lazy dialog is still loading, so its command listener exists when the
// seed is delivered (a parent effect outside Suspense ran during fallback).
function SeededSwapDialog({ seed, onClose }: { seed: SwapUiCommand | null; onClose: () => void }) {
  useEffect(() => {
    if (seed?.kind !== 'open') return
    const { kind: _kind, ...fields } = seed
    dispatchLocalRpcMessage('swap-cmd', { kind: 'set', ...fields } as SwapUiCommand)
  }, [seed])
  return <SwapDialog open onClose={onClose} />
}

export function SwapRpcMount() {
  const [open, setOpen] = useState(false)
  const [pendingSeed, setPendingSeed] = useState<SwapUiCommand | null>(null)

  useEffect(() => {
    return onRpcMessage('swap-cmd', (cmd: SwapUiCommand) => {
      if (cmd.kind !== 'open') return
      setPendingSeed(cmd)
      setOpen(true)
    })
  }, [])

  if (!open) return null

  return (
    <Suspense fallback={null}>
      <SeededSwapDialog seed={pendingSeed} onClose={() => setOpen(false)} />
    </Suspense>
  )
}
