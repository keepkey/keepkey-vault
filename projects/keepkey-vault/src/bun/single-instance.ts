/**
 * One KeepKey Desktop per channel. Electrobun has no single-instance API, and
 * the REST port check ran after the window opened: a second copy showed its
 * window, then blocked in the port-in-use alert (a modal the bun thread waits
 * on), so it sat there as a UI with no backend.
 *
 * The copy that starts first takes an exclusive lock file (O_EXCL, holding its
 * pid) and listens on a unix socket beside it. A later copy of the same
 * identifier and channel asks it to bring its window to the front and quits
 * before it opens any window. Other channels (dev beside the installed app)
 * use other files and run side by side, as before.
 *
 * A copy that is quitting, or busy (a slow sync DB call, an emulator FFI call),
 * may not answer at once: the claim keeps trying until a long bound, and only
 * then reports it as not answering.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type InstanceClaim =
  | { role: 'primary'; release: () => void }
  /** Another copy answered and brought its window to the front. */
  | { role: 'focused-existing'; runningVersion: string | null }
  /** Another copy holds the instance but did not answer within the bound. */
  | { role: 'unresponsive' }

export interface ClaimOptions {
  /** This copy's version, sent to and from the other copy. */
  version: string
  /** Called in the running copy when a later one asks; gets that copy's version. */
  onFocusRequest: (version: string) => void
  /** How long a later copy keeps trying a copy that does not answer. */
  deadlineMs?: number
}

export const INSTANCE_DEADLINE_MS = 20_000
const RETRY_MS = 100
/** A live pid whose socket refuses connections this long is not a Desktop (a reused pid
 *  after a crash). A Desktop listens within milliseconds of taking the lock, and on quit
 *  drops the socket and the lock together, so a real one is never refused this long. */
const REFUSED_STALE_MS = 1_000

/** ~/.keepkey/desktop-<identifier>-<channel>.sock: one per identifier and channel,
 *  like Electrobun's app data folder. Short, for the ~104-byte socket path limit. */
export function instanceSocketPath(home: string, identifier: string, channel: string): string {
  const part = (value: string, fallback: string) => (value || fallback).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
  return join(home, '.keepkey', `desktop-${part(identifier, 'keepkey')}-${part(channel, 'unknown')}.sock`)
}

const lockPath = (socket: string) => socket.replace(/\.sock$/, '') + '.lock'

type Answer = { kind: 'answered'; version: string | null } | { kind: 'timeout' } | { kind: 'closed' } | { kind: 'refused' }

function askToFocus(path: string, version: string, timeoutMs: number): Promise<Answer> {
  return new Promise(resolve => {
    let done = false
    let reply = ''
    const finish = (answer: Answer, socket?: { end(): void }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { socket?.end() } catch { /* already closed */ }
      resolve(answer)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(1, timeoutMs))
    Bun.connect({
      unix: path,
      socket: {
        open(socket) { socket.write(`focus ${version}\n`) },
        data(socket, data) {
          reply += data.toString()
          const line = reply.split('\n')[0]
          if (reply.includes('\n') && line.startsWith('ok')) finish({ kind: 'answered', version: line.slice(3).trim() || null }, socket)
        },
        // Accepted, then closed with no answer: the copy is quitting (it stopped its socket).
        close() { finish({ kind: 'closed' }) },
        error() { finish({ kind: 'closed' }) },
        connectError() { finish({ kind: 'refused' }) },
      },
    }).catch(() => finish({ kind: 'refused' }))
  })
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

function readLockPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

/** O_EXCL: of two copies started together exactly one creates it. */
function tryLock(path: string): boolean {
  try {
    const fd = openSync(path, 'wx', 0o600)
    try { writeSync(fd, `${process.pid}\n`) } finally { closeSync(fd) }
    chmodSync(path, 0o600)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

function removeLockIf(path: string, pid: number | null) {
  // Only the lock we judged stale: a copy that has just taken it keeps it.
  if (readLockPid(path) === pid) { try { unlinkSync(path) } catch { /* gone */ } }
}

function serve(path: string, options: ClaimOptions) {
  try { unlinkSync(path) } catch { /* no stale socket */ }
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const line = data.toString().split('\n')[0]
        if (!line.startsWith('focus')) return
        try { options.onFocusRequest(line.slice(6).trim()) } catch (error) { console.warn('[instance] focus request failed:', error) }
        socket.write(`ok ${options.version}\n`)
        socket.end()
      },
    },
  })
  chmodSync(path, 0o600)
  return server
}

export async function claimSingleInstance(path: string, options: ClaimOptions): Promise<InstanceClaim> {
  const deadline = Date.now() + (options.deadlineMs ?? INSTANCE_DEADLINE_MS)
  const lock = lockPath(path)
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) } catch { /* reported by the lock below */ }
  let refusedSince: number | null = null
  for (;;) {
    let locked: boolean
    try { locked = tryLock(lock) } catch (error) {
      // No lock possible (an unwritable home): start anyway. The REST port check
      // still keeps a second Desktop from serving beside this one.
      console.warn('[instance] could not take the single-instance lock:', (error as Error)?.message)
      return { role: 'primary', release: () => {} }
    }
    if (locked) {
      let server: ReturnType<typeof serve> | null = null
      try { server = serve(path, options) } catch (error) {
        // No socket, no hand-off: drop the lock too, so a later copy doesn't wait on it.
        console.warn('[instance] could not listen on the single-instance socket:', (error as Error)?.message)
        removeLockIf(lock, process.pid)
      }
      return {
        role: 'primary',
        release: () => {
          try { server?.stop(true) } catch { /* stopped */ }
          try { unlinkSync(path) } catch { /* gone */ }
          removeLockIf(lock, process.pid)
        },
      }
    }
    // A stale lock we cannot remove (a read-only folder): no hand-off is possible, so
    // start without the lock rather than loop with no window.
    const withoutLock = (why: string): InstanceClaim => {
      console.warn(`[instance] starting without the single-instance lock: ${why}`)
      return { role: 'primary', release: () => {} }
    }
    const replaceStale = (holder: number | null): InstanceClaim | null => {
      removeLockIf(lock, holder)
      if (existsSync(lock) && readLockPid(lock) === holder) return withoutLock(`could not remove the stale lock ${lock}`)
      return Date.now() >= deadline ? withoutLock('the stale lock kept coming back until the deadline') : null
    }
    const holder = readLockPid(lock)
    if (holder === null || !pidAlive(holder)) {
      // A copy that crashed, garbage in the file, or a copy between creating the lock
      // and writing its pid (give that one a moment).
      if (holder === null) {
        await Bun.sleep(RETRY_MS)
        if (readLockPid(lock) !== null) continue
      }
      const settled = replaceStale(holder)
      if (settled) return settled
      continue
    }
    const answer = await askToFocus(path, options.version, deadline - Date.now())
    if (answer.kind === 'answered') return { role: 'focused-existing', runningVersion: answer.version }
    if (Date.now() >= deadline) return { role: 'unresponsive' }
    if (answer.kind === 'refused') {
      // Not listening yet (just started), or gone (quitting). A live pid that never
      // listens is not a Desktop: the pid was reused after a crash.
      refusedSince ??= Date.now()
      if (Date.now() - refusedSince > REFUSED_STALE_MS) {
        const settled = replaceStale(holder)
        if (settled) return settled
        refusedSince = null
        continue
      }
    } else refusedSince = null
    await Bun.sleep(RETRY_MS)
  }
}

export interface Dialog { message: string; detail: string }

export function unresponsiveDialog(deadlineMs = INSTANCE_DEADLINE_MS): Dialog {
  return {
    message: 'KeepKey Desktop is already open but has not answered',
    detail: `Another KeepKey Desktop is running and has not answered for ${Math.round(deadlineMs / 1000)} seconds. It may be busy (syncing, or talking to a device). Wait a moment and open KeepKey Desktop again. If it stays stuck, quit it (Activity Monitor on macOS) first.`,
  }
}

export function otherVersionDialog(running: string, opened: string): Dialog {
  return {
    message: `KeepKey Desktop ${running} is still running`,
    detail: `Its window was brought to the front. You opened version ${opened}: to use it, quit KeepKey Desktop ${running}, then open KeepKey Desktop again.`,
  }
}

/**
 * Runs before the main window is created. Returns the claim when this copy is
 * the instance; otherwise tells the user what happened (only when there is
 * something to tell) and exits. `exit` does not return in the app.
 */
export async function startupInstanceGate(options: ClaimOptions & {
  path: string
  showDialog: (dialog: Dialog) => Promise<unknown> | unknown
  exit: (code: number) => void
  /** A non-blocking notice (a system notification) if the running copy is slow to
   *  answer: until the bound, there is no window and no dialog to explain why. */
  notify?: (text: string) => void
  waitingNoticeMs?: number
}): Promise<Extract<InstanceClaim, { role: 'primary' }> | null> {
  const notice = setTimeout(() => {
    try { options.notify?.('Waiting for the KeepKey Desktop that is already open to answer…') } catch { /* best effort */ }
  }, options.waitingNoticeMs ?? 5000)
  const claim = await claimSingleInstance(options.path, options).finally(() => clearTimeout(notice))
  if (claim.role === 'primary') return claim
  if (claim.role === 'focused-existing') {
    console.log('[Vault] KeepKey Desktop is already running: brought its window to the front; this copy quits')
    if (claim.runningVersion && claim.runningVersion !== options.version) {
      await Promise.resolve(options.showDialog(otherVersionDialog(claim.runningVersion, options.version))).catch(() => {})
    }
    options.exit(0)
    return null
  }
  console.error('[Vault] Another KeepKey Desktop holds the instance but did not answer')
  await Promise.resolve(options.showDialog(unresponsiveDialog(options.deadlineMs))).catch(() => {})
  options.exit(1)
  return null
}
