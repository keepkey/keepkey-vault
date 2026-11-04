type Dependencies = {
  defaultBase: string
  getBase: () => string
  save: (url: string) => void
  begin: () => void
  retire: () => Promise<void>
  reset: () => Promise<void>
  end: () => void
}

/** Settings own the endpoint. Retire old connections before committing a new
 * selection; a failed remote cleanup keeps the previous selection available. */
export function createPioneerServerSwitch(deps: Dependencies) {
  let changing = false
  return async (value: string): Promise<void> => {
    const trimmed = value.trim()
    if (trimmed && !/^https?:\/\//i.test(trimmed)) throw new Error('URL must start with http:// or https://')
    if (trimmed) { try { new URL(trimmed) } catch { throw new Error('A valid API server URL is required') } }
    const url = trimmed.replace(/\/+$/, '')
    const selected = url === deps.defaultBase ? '' : url
    const next = selected || deps.defaultBase
    if (changing) throw new Error('A server change is already in progress. Try again shortly.')
    if (next === deps.getBase()) { deps.save(selected); return }
    changing = true
    try {
      deps.begin()
      await deps.retire()
      deps.save(selected)
      if (deps.getBase() !== next) throw new Error('The selected API server could not be saved')
      await deps.reset()
    } finally {
      changing = false
      deps.end()
    }
  }
}
