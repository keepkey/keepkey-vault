/**
 * One KeepKey Desktop per user. Electrobun has no single-instance API, and the
 * REST port check ran only after the window opened (and only with the REST API
 * on): a second copy showed its window, then blocked in the port-in-use alert
 * (a modal the bun thread waits on), so it sat there as a UI with no backend.
 *
 * The first copy listens on a unix socket. A later copy connects, asks it to
 * bring its window to the front, and quits before it opens any window.
 */
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export type InstanceClaim =
  | { role: 'primary'; release: () => void }
  /** Another copy answered and brought its window to the front. */
  | { role: 'focused-existing' }
  /** Another copy holds the socket but did not answer in time. */
  | { role: 'unresponsive' }

const FOCUS = 'focus\n'
const ACK = 'ok\n'

function askToFocus(path: string, timeoutMs: number): Promise<'answered' | 'silent' | 'absent'> {
  return new Promise(resolve => {
    let done = false
    const finish = (result: 'answered' | 'silent' | 'absent', socket?: { end(): void }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket?.end() } catch { /* already closed */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish('silent'), timeoutMs)
    Bun.connect({
      unix: path,
      socket: {
        open(socket) { socket.write(FOCUS) },
        data(socket, data) { if (data.toString().includes(ACK.trim())) finish('answered', socket) },
        close() { finish('silent') },
        error() { finish('silent') },
        connectError() { finish('absent') },
      },
    }).catch(() => finish('absent'))
  })
}

function listen(path: string, onFocusRequest: () => void) {
  return Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        if (!data.toString().includes(FOCUS.trim())) return
        try { onFocusRequest() } catch (error) { console.warn('[instance] focus request failed:', error) }
        socket.write(ACK)
        socket.end()
      },
    },
  })
}

/**
 * Claim `path` for this copy, or hand off to the copy that already has it.
 * Ask first: Bun.listen replaces an existing socket file, so binding first
 * would take the socket from a running copy. A file left by a copy that
 * crashed refuses the connection and is replaced. Two copies started in the
 * same instant can both get here; the REST port check still stops the second.
 */
export async function claimSingleInstance(path: string, onFocusRequest: () => void, timeoutMs = 2000): Promise<InstanceClaim> {
  const answer = await askToFocus(path, timeoutMs)
  if (answer === 'answered') return { role: 'focused-existing' }
  if (answer === 'silent') return { role: 'unresponsive' }
  try { unlinkSync(path) } catch { /* no stale file */ }
  let server: ReturnType<typeof listen>
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    server = listen(path, onFocusRequest)
  } catch (error) {
    // No lock (a platform without unix sockets, an unwritable home): start anyway.
    // The REST port check still keeps a second Desktop from serving beside this one.
    console.warn('[instance] could not claim the single-instance socket:', (error as Error)?.message)
    return { role: 'primary', release: () => {} }
  }
  return { role: 'primary', release: () => { try { server.stop(true) } catch { /* stopped */ } try { unlinkSync(path) } catch { /* gone */ } } }
}

export const SECOND_INSTANCE_UNRESPONSIVE = {
  message: 'KeepKey Desktop is already open but not responding',
  detail: 'Another KeepKey Desktop is running and did not answer. Quit it (Activity Monitor on macOS), then open KeepKey Desktop again.',
  buttons: ['Quit'],
}
