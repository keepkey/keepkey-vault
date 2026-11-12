/** Serializes intentional device work without turning device lock into API unavailability.
 * A cancelled waiter never dispatches work. An unlock that is already on the wire
 * must drain before another owner is admitted, even when its HTTP caller leaves. */
import { AsyncLocalStorage } from 'node:async_hooks'

/** A Desktop action may await network/build work before its next device call.
 * Fence each new wire exchange, while allowing an admitted exchange to drain. */
export const deviceOperationContext = new AsyncLocalStorage<{
  assertCurrent: () => void
  admitted?: boolean
}>()

/** Reads nobody asked for (wallet watch, post-tx refresh, passive views). One that finds
 * the device auto-locked must not open the PIN prompt: the device stays quietly locked
 * until an action the user starts needs it, as in release 1.6.7. */
export const backgroundDeviceRead = new AsyncLocalStorage<true>()

export interface DeviceOperationSnapshot {
  wallet: unknown | null
  deviceId?: string
  seedAddress: string | null
  state: string
  blocked?: string | null
}

export interface DeviceOperationOptions {
  signal?: AbortSignal
  /** Explicit foreground intent. Omitted/false never asks for a PIN. */
  unlock?: boolean
  /** Interactive Desktop actions must not turn into invisible delayed jobs. */
  rejectIfBusy?: boolean
  origin?: 'desktop'
}

export class DeviceOperationError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

interface Entry {
  identity: DeviceOperationSnapshot
  generation: number
  options: DeviceOperationOptions
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  abort: AbortController
  settled: boolean
  leased: boolean
  cleanup: () => void
}

export class DeviceOperationCoordinator {
  private queue: Entry[] = []
  private active: Entry | null = null
  private generation = 0

  get busy(): boolean { return this.active !== null || this.queue.length > 0 }

  constructor(private readonly dependencies: {
    snapshot: () => DeviceOperationSnapshot
    /** Fresh PIN-free metadata. Passive leases must reject a newly detected lock. */
    prepare?: (signal: AbortSignal) => Promise<void>
    unlock: (signal: AbortSignal) => Promise<unknown>
    maxPending?: number
    waitMs?: number
  }) {}

  acquire(options: DeviceOperationOptions = {}): Promise<() => void> {
    try {
      if (options.signal?.aborted) throw this.cancelled()
      if (options.rejectIfBusy && this.busy) {
        throw new DeviceOperationError(409, 'KeepKey is busy with another request. Wait for it to finish, then try again.')
      }
      const identity = this.dependencies.snapshot()
      this.assertAvailable(identity, options.unlock === true)
      if (this.queue.length >= (this.dependencies.maxPending ?? 20)) {
        throw new DeviceOperationError(429, 'Too many pending KeepKey requests. Wait for the current request to finish.')
      }
      return new Promise((resolve, reject) => {
        const entry: Entry = {
          identity: { ...identity }, generation: this.generation, options, resolve, reject,
          abort: new AbortController(), settled: false, leased: false, cleanup: () => {},
        }
        const cancel = (error: DeviceOperationError) => {
          if (entry.leased) return // The caller's finally owns an operation already dispatched.
          const index = this.queue.indexOf(entry)
          if (index !== -1) this.queue.splice(index, 1)
          this.reject(entry, error)
          entry.abort.abort(error)
        }
        const onAbort = () => cancel(this.cancelled())
        const timer = setTimeout(() => cancel(new DeviceOperationError(504, 'Timed out waiting for the KeepKey request. Try again.')),
          this.dependencies.waitMs ?? 15 * 60_000)
        entry.cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort) }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        this.queue.push(entry)
        // Abort can occur between the first check and listener installation.
        if (options.signal?.aborted) onAbort()
        this.pump()
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Called when the actual connection/session is retired. Never releases work on the wire. */
  invalidate(message = 'The KeepKey wallet changed. Start the request again with the current wallet.'): void {
    this.generation++
    const error = new DeviceOperationError(409, message)
    for (const entry of this.queue.splice(0)) {
      this.reject(entry, error)
      entry.abort.abort(error)
    }
    if (this.active && !this.active.leased) {
      this.reject(this.active, error)
      this.active.abort.abort(error)
    }
  }

  /** A passphrase prompt may be part of the active unlock, but older queued
   * requests must not silently follow it into a different wallet. */
  invalidateQueued(message = 'The wallet is requesting a passphrase. Start the request again after choosing the wallet.'): void {
    const error = new DeviceOperationError(409, message)
    for (const entry of this.queue.splice(0)) {
      this.reject(entry, error)
      entry.abort.abort(error)
    }
  }

  private cancelled(): DeviceOperationError {
    return new DeviceOperationError(499, 'KeepKey request cancelled. No new device operation was started.')
  }

  private reject(entry: Entry, error: Error): void {
    if (entry.settled) return
    entry.settled = true
    entry.cleanup()
    entry.reject(error)
  }

  private assertAvailable(snapshot: DeviceOperationSnapshot, allowUnlock: boolean): void {
    if (!snapshot.wallet) throw new DeviceOperationError(503, 'No device connected')
    if (snapshot.blocked) throw new DeviceOperationError(409, snapshot.blocked)
    if (!['ready', 'needs_pin', 'needs_passphrase'].includes(snapshot.state)) {
      throw new DeviceOperationError(409, 'KeepKey is not ready for wallet operations. Finish device setup or reconnect it.')
    }
    if (snapshot.state !== 'ready' && !allowUnlock) {
      throw new DeviceOperationError(423, 'KeepKey is locked. Unlock it before requesting new device data.')
    }
  }

  private assertIdentity(entry: Entry, snapshot: DeviceOperationSnapshot, afterUnlock = false): void {
    const identity = entry.identity
    if (entry.generation !== this.generation || identity.wallet !== snapshot.wallet
      || (identity.deviceId && identity.deviceId !== snapshot.deviceId)
      || (identity.seedAddress && identity.seedAddress.toLowerCase() !== snapshot.seedAddress?.toLowerCase())) {
      throw new DeviceOperationError(409, 'The KeepKey wallet changed. Start the request again with the current wallet.')
    }
    if (entry.options.signal?.aborted || entry.abort.signal.aborted) throw this.cancelled()
    this.assertAvailable(snapshot, !afterUnlock && entry.options.unlock === true)
  }

  private pump(): void {
    if (this.active) return
    const entry = this.queue.shift()
    if (!entry) return
    this.active = entry
    void (async () => {
      try {
        let snapshot = this.dependencies.snapshot()
        this.assertIdentity(entry, snapshot)
        if (this.dependencies.prepare) {
          await this.dependencies.prepare(entry.abort.signal)
          snapshot = this.dependencies.snapshot()
          this.assertIdentity(entry, snapshot)
        }
        if (snapshot.state !== 'ready') {
          // The dependency owns cancellation of its unlock only. A manual unlock
          // that this request merely joined must never be cancelled by its signal.
          await this.dependencies.unlock(entry.abort.signal)
          snapshot = this.dependencies.snapshot()
        }
        this.assertIdentity(entry, snapshot, true)
        if (entry.settled) return
        entry.leased = true
        entry.settled = true
        entry.cleanup()
        let released = false
        entry.resolve(() => {
          if (released) return
          released = true
          if (this.active === entry) this.active = null
          this.pump()
        })
      } catch (error) {
        this.reject(entry, error instanceof Error ? error : new Error(String(error)))
      } finally {
        // A granted lease stays owned until the caller's finally. A cancelled
        // unlock is held until its real promise settles; no request overtakes it.
        if (!entry.leased && this.active === entry) {
          this.active = null
          this.pump()
        }
      }
    })()
  }
}
