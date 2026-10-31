import type { RestApiServer } from './rest-api'

/** Why Desktop could not take its REST port. */
export type RestPortConflict = 'answers-like-desktop' | 'held-by-another-program'

export interface RestPortDialog {
  message: string
  detail: string
  buttons: string[]
}

export interface RestApiStartDeps {
  /** Binds the REST API; throws if an address is already held. */
  start: () => RestApiServer
  /** True if something already on the port answers Desktop's health route. */
  answersLikeDesktop: () => Promise<boolean>
  showError: (dialog: RestPortDialog) => Promise<unknown>
  exit: (code: number) => void
}

/** True if 127.0.0.1 or ::1 on `port` answers /api/v1/health/fast the way
 *  Desktop does. Any program can answer this way, so it never proves Desktop. */
export async function portAnswersLikeDesktop(port: number): Promise<boolean> {
  const probe = async (host: string) => {
    try {
      const res = await fetch(`http://${host}:${port}/api/v1/health/fast`, { signal: AbortSignal.timeout(2000) })
      return res.ok && (await res.json())?.status === 'ok'
    } catch {
      return false
    }
  }
  return (await Promise.all(['127.0.0.1', '[::1]'].map(probe))).some(Boolean)
}

export function restPortDialog(port: number, conflict: RestPortConflict, when: 'startup' | 'settings'): RestPortDialog {
  const message = when === 'startup'
    ? `KeepKey Desktop can't start: port ${port} is in use`
    : `The REST API could not be turned on: port ${port} is in use`
  const why = conflict === 'answers-like-desktop'
    ? `Something on this computer is already answering on port ${port} the way KeepKey Desktop does. If KeepKey Desktop is already open, use that window. If it is not, another program is pretending to be KeepKey Desktop: quit it before you use the KeepKey browser extension or apps, because it would receive their requests.`
    : `Another program on this computer is using port ${port}. The KeepKey browser extension and apps talk to KeepKey Desktop on that port, so Desktop will not share it. Quit that program first.`
  return when === 'startup'
    ? { message, detail: `${why} Then open KeepKey Desktop again.`, buttons: ['Quit'] }
    : { message, detail: `${why} The REST API stays off.`, buttons: ['OK'] }
}

/** Takes the REST port, or tells the user why not; never fails silently.
 *  'startup': Desktop does not run without its port, so a second Desktop quits.
 *  'settings': the user just turned the REST API on; Desktop keeps running and
 *  the REST API stays off. Returns null when the port was not taken. */
export async function startRestApiOrReport(port: number, when: 'startup' | 'settings', deps: RestApiStartDeps): Promise<RestApiServer | null> {
  let conflict: RestPortConflict
  // Ask first: a Desktop older than this check listens on the wildcard, and
  // macOS lets 127.0.0.1 and ::1 be bound next to it, so the bind alone would
  // start a second Desktop.
  if (await deps.answersLikeDesktop()) {
    conflict = 'answers-like-desktop'
  } else {
    try {
      return deps.start()
    } catch (err) {
      console.error(`[Vault] Failed to bind REST API on port ${port}:`, err)
      conflict = 'held-by-another-program'
    }
  }
  console.error(`[Vault] REST API port ${port} is in use (${conflict})`)
  const dialog = restPortDialog(port, conflict, when)
  const shown = deps.showError(dialog).catch(err => console.error('[Vault] Could not show the port-in-use dialog:', err))
  if (when === 'startup') {
    await shown
    deps.exit(1)
  }
  // 'settings' does not wait for the dialog: the Settings call would time out.
  return null
}
