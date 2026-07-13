import { useEffect, useState } from "react"
import { rpcRequest } from "../lib/rpc"

/** Reliable connectivity via a Bun-side reachability probe.
 *
 *  navigator.onLine is unreliable in the WebView — it stays `true` after wifi
 *  drops — so we can't trust it alone. Instead the Bun backend actually tries to
 *  reach Pioneer (pingPioneer) and reports whether the network responded.
 *
 *  `active` gates the probe: pass false when the user is in offline (airplane)
 *  mode so we never make a network call — the caller already knows it's offline.
 *  Returns true (neutral) while inactive. */
export function useOnline(active: boolean): boolean {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    if (!active) { setOnline(true); return }
    let alive = true
    const check = () => {
      rpcRequest<{ online: boolean }>("pingPioneer", {}, 6000)
        .then((r) => { if (alive) setOnline(r.online) })
        .catch(() => { if (alive) setOnline(false) })
    }
    check()
    const iv = setInterval(check, 15000)
    // navigator's own signals are a cheap fast-path on top of the poll.
    const onNavOffline = () => { if (alive) setOnline(false) }
    window.addEventListener("focus", check)
    window.addEventListener("online", check)
    window.addEventListener("offline", onNavOffline)
    return () => {
      alive = false
      clearInterval(iv)
      window.removeEventListener("focus", check)
      window.removeEventListener("online", check)
      window.removeEventListener("offline", onNavOffline)
    }
  }, [active])

  return online
}
