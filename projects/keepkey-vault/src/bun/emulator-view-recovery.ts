/** Retry lost initial HTML loads, never a ready or replaced window. */
export function recoverEmulatorView(deps: {
  needsLoad: () => boolean
  reload: () => void
  onError: () => void
  schedule?: (run: () => void, delay: number) => () => void
}) {
  const schedule = deps.schedule || ((run, delay) => { const timer = setTimeout(run, delay); return () => clearTimeout(timer) })
  const cancel = [750, 2000, 5000, 10000].map(delay => schedule(() => {
    if (!deps.needsLoad()) return
    try { deps.reload() } catch { deps.onError() }
  }, delay))
  return () => cancel.forEach(stop => stop())
}
