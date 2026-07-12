import { useEffect, useState } from "react"
import { rpcRequest } from "../lib/rpc"

export type BtcNodeStatus = {
  active: boolean; kind?: "blockbook" | "core"; ok?: boolean; error?: string
  height?: number; syncing?: boolean; progress?: number
}

/** Polls the active self-host node's status for the bottom status bar. Only runs
 *  when `enabled` (a node is configured) and not offline — no point probing a node
 *  in airplane mode. */
export function useBtcNodeStatus(enabled: boolean): BtcNodeStatus | null {
  const [status, setStatus] = useState<BtcNodeStatus | null>(null)
  useEffect(() => {
    if (!enabled) { setStatus(null); return }
    let alive = true
    const check = () => {
      rpcRequest<BtcNodeStatus>("getBtcNodeStatus", undefined, 15000)
        .then((s) => { if (alive) setStatus(s) })
        .catch(() => { if (alive) setStatus({ active: true, ok: false, error: "unreachable" }) })
    }
    check()
    const iv = setInterval(check, 12000)
    return () => { alive = false; clearInterval(iv) }
  }, [enabled])
  return status
}
