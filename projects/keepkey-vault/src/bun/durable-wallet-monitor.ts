import type { AddressEntry } from './event-stream'
import type { BalanceRefreshScope } from './post-tx-balance'

export interface DurableMonitorSession {
  scope: BalanceRefreshScope
  walletScope: string
  base: string
  queryKey: string
}
export type DurableMonitorOwner = Pick<DurableMonitorSession, 'walletScope' | 'base' | 'queryKey'>
/** Opaque database cursors are meaningful only within this provider/key queue. */
export function monitorCursorContext(session: DurableMonitorSession): string {
  const base = new URL(session.base)
  base.hash = ''; base.search = ''; base.pathname = base.pathname.replace(/\/+$/, '')
  return JSON.stringify([base.toString().replace(/\/$/, ''), session.queryKey, session.walletScope])
}
type Deps = {
  isCurrent: (session: DurableMonitorSession) => boolean
  readCursor: (walletScope: string) => string | undefined
  writeCursor: (walletScope: string, cursor: string) => void
  deliver: (event: { type: string; data: any }) => boolean
  flush: () => Promise<boolean>
  fetch?: typeof fetch
  onError?: (error: unknown) => void
  onRegistered?: (watchCount: number) => void
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}
type Registration = { session: DurableMonitorSession; key: string; controller: AbortController; addresses: AddressEntry[]; registered?: boolean; replaying?: Promise<void> }

/** Standard-wallet registrations outlive this client. Stop only closes local
 * requests; explicit suspend is a separate server-side monitoring decision. */
export function createDurableWalletMonitor(deps: Deps) {
  const fetcher = deps.fetch || fetch
  let active: Registration | undefined, revision = 0
  const current = (registration: Registration) => active === registration && !registration.controller.signal.aborted && deps.isCurrent(registration.session)
  const nextRevision = () => revision = Math.max((deps.now || Date.now)(), revision + 1)
  const wait = deps.wait || ((milliseconds: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, milliseconds)
    if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true })
  }))
  async function request(registration: { session: DurableMonitorOwner; controller: AbortController }, path: string, body?: unknown, detached = false): Promise<any> {
    const response = await fetcher(`${registration.session.base.replace(/\/$/, '')}/api/v1/events/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': registration.session.queryKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: detached ? AbortSignal.timeout(10_000) : AbortSignal.any([registration.controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw new Error(`Wallet monitoring ${path.split('?')[0]} HTTP ${response.status}`)
    if (response.status === 204) return {}
    const text = await response.text()
    return text ? JSON.parse(text) : {}
  }
  function replay(): Promise<void> {
    const registration = active
    if (!registration || !registration.registered || !current(registration)) return Promise.resolve()
    if (registration.replaying) return registration.replaying
    let continuation = false
    registration.replaying = (async () => {
      const cursorContext = monitorCursorContext(registration.session)
      let cursor = deps.readCursor(cursorContext)
      for (let page = 0; page < 10 && current(registration); page++) {
        const path = `replay?walletScope=${encodeURIComponent(registration.session.walletScope)}&limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`
        const result = await request(registration, path)
        if (!current(registration)) return
        const events = Array.isArray(result.events) ? result.events : []
        if (!events.length) return
        let accepted = true
        for (const event of events) {
          if (!current(registration)) return
          if (typeof event.eventName !== 'string' || !event.payload || typeof event.payload !== 'object'
            || !deps.deliver({ type: event.eventName, data: event.payload })) accepted = false
        }
        if (!await deps.flush() || !current(registration) || !accepted) return
        const next = result.cursor == null ? undefined : String(result.cursor)
        if (!next || next === cursor) return
        await request(registration, 'ack', { walletScope: registration.session.walletScope, cursor: next,
          eventIds: events.map((event: any) => event.eventId || event.id).filter((id: unknown) => typeof id === 'string') })
        if (!current(registration)) return
        deps.writeCursor(cursorContext, next)
        cursor = next
        if (events.length < 100) return
        if (page === 9) continuation = true
      }
    })().catch(error => { if (current(registration)) deps.onError?.(error) }).finally(() => {
      registration.replaying = undefined
      if (continuation && current(registration)) void wait(0, registration.controller.signal).then(() => { if (current(registration)) void replay() })
    })
    return registration.replaying
  }
  function stop() { const previous = active; active = undefined; previous?.controller.abort() }
  async function revoke(owner: DurableMonitorOwner) {
    // A newer tombstone wins over an older registration request still in flight.
    await request({ session: owner, controller: new AbortController() }, 'watches', { walletScope: owner.walletScope, addresses: [], enabled: false, revision: nextRevision() }, true)
    if (active && active.session.walletScope === owner.walletScope && active.session.base === owner.base && active.session.queryKey === owner.queryKey) stop()
  }
  return {
    replace(session: DurableMonitorSession, addresses: AddressEntry[]) {
      if (!deps.isCurrent(session)) return
      const key = JSON.stringify([session.walletScope, session.base, session.queryKey, addresses])
      if (active?.key === key) return
      stop()
      const registration: Registration = { session, addresses, key, controller: new AbortController() }
      active = registration
      const registrationRevision = nextRevision()
      void (async () => {
        for (let attempt = 0; current(registration); attempt++) {
          const delay = [0, 2_000, 10_000, 30_000, 60_000][Math.min(attempt, 4)]!
          if (delay) await wait(delay, registration.controller.signal)
          if (!current(registration)) return
          try {
            await request(registration, 'watches', { walletScope: session.walletScope, addresses, enabled: addresses.length > 0, revision: registrationRevision })
            if (current(registration)) { registration.registered = true; deps.onRegistered?.(addresses.length); if (addresses.length) await replay() }
            return
          } catch (error) {
            if (current(registration) && attempt >= 2) deps.onError?.(error)
          }
        }
      })()
    },
    replay,
    async acknowledge(eventIds: string[]) {
      const registration = active
      if (!registration || !registration.registered || !current(registration) || !eventIds.length) return
      await request(registration, 'ack', { walletScope: registration.session.walletScope, eventIds })
    },
    stop,
    revoke,
    async suspend() {
      const registration = active
      if (!registration) return
      try {
        await revoke(registration.session)
      } catch (error) {
        deps.onError?.(error)
        throw new Error('Could not disable background wallet monitoring. Offline mode was not enabled. Check your connection and try again.')
      }
    },
  }
}
