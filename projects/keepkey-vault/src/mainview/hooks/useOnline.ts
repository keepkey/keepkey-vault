import { useEffect, useState } from 'react'
import { createConnectivityState } from '../../shared/connectivity'
import { onRpcMessage, rpcRequest } from '../lib/rpc'

/** Probe the selected API without letting a delayed UI bridge declare an outage.
 * Two independent failed probes are required; only one probe runs at a time. */
export function useOnline(active: boolean): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    if (!active) { setOnline(true); return }
    let alive = true, running = false, generation = 0
    const state = createConnectivityState()
    const check = async () => {
      if (running) return
      running = true
      const current = generation
      try {
        const result = await rpcRequest<{online: boolean}>('pingPioneer', {}, 12000)
        if (alive && current === generation) setOnline(state.observe(result.online))
      } catch {
        // RPC/renderer congestion says nothing about internet connectivity.
      } finally { running = false }
    }
    void check()
    const timer = setInterval(() => void check(), 15000)
    const networkChanged = () => { void check() }
    const off = onRpcMessage('pioneer-server-changed', () => {
      generation++; state.reset(); setOnline(true); void check()
    })
    window.addEventListener('focus', networkChanged)
    window.addEventListener('online', networkChanged)
    window.addEventListener('offline', networkChanged)
    return () => {
      alive = false; generation++; clearInterval(timer); off()
      window.removeEventListener('focus', networkChanged)
      window.removeEventListener('online', networkChanged)
      window.removeEventListener('offline', networkChanged)
    }
  }, [active])
  return online
}
