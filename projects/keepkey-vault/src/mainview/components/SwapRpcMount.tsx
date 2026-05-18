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

  // After the dialog mounts (child useEffects run before this parent
  // useEffect), re-emit the open seed as a 'set' command so the dialog's
  // listener — registered during its own mount effect — applies the fields.
  useEffect(() => {
    if (!open || !pendingSeed || pendingSeed.kind !== 'open') return
    const { kind: _kind, ...rest } = pendingSeed
    void _kind
    dispatchLocalRpcMessage('swap-cmd', { kind: 'set', ...rest } as SwapUiCommand)
    setPendingSeed(null)
  }, [open, pendingSeed])

  if (!open) return null

  return (
    <Suspense fallback={null}>
      <SwapDialog open={open} onClose={() => setOpen(false)} />
    </Suspense>
  )
}
