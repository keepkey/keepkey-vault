import { describe, expect, test } from 'bun:test'
import { DeviceOperationCoordinator, type DeviceOperationSnapshot } from '../src/bun/device-operation'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => Bun.sleep(0)
function fixture(options: { maxPending?: number; waitMs?: number } = {}) {
  const snapshot: DeviceOperationSnapshot = { wallet: {}, deviceId: 'one', seedAddress: '0xseed', state: 'ready' }
  const unlock = deferred()
  let unlocks = 0, cancellations = 0
  const coordinator = new DeviceOperationCoordinator({ ...options, snapshot: () => snapshot,
    unlock: signal => {
      unlocks++
      signal.addEventListener('abort', () => { cancellations++ }, { once: true })
      return unlock.promise
    },
  })
  return { snapshot, unlock, coordinator, unlocks: () => unlocks, cancellations: () => cancellations }
}

describe('intentional device operations', () => {
  test('an operation holds the device until its idempotent release', async () => {
    const f = fixture()
    const release = await f.coordinator.acquire()
    let admitted = false
    const next = f.coordinator.acquire().then(release => { admitted = true; return release })
    await tick()
    expect(admitted).toBe(false)
    release(); release()
    const releaseNext = await next
    expect(admitted).toBe(true)
    releaseNext()
    expect(f.unlocks()).toBe(0)
  })

  test('a locked background read never creates an unlock', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    await expect(f.coordinator.acquire()).rejects.toMatchObject({ status: 423 })
    expect(f.unlocks()).toBe(0)
  })

  test('two foreground requests share one unlock and remain serialized afterward', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    const first = f.coordinator.acquire({ unlock: true })
    let nextAdmitted = false
    const second = f.coordinator.acquire({ unlock: true }).then(release => { nextAdmitted = true; return release })
    await tick(); expect(f.unlocks()).toBe(1)
    f.snapshot.state = 'ready'; f.unlock.resolve()
    const release = await first
    await tick(); expect(nextAdmitted).toBe(false)
    release()
    ;(await second)()
    expect(f.unlocks()).toBe(1)
  })

  test('unlocking a different known seed rejects the original request', async () => {
    const f = fixture(); f.snapshot.state = 'needs_passphrase'
    const first = f.coordinator.acquire({ unlock: true })
    f.snapshot.state = 'ready'; f.snapshot.seedAddress = '0xother'; f.unlock.resolve()
    await expect(first).rejects.toMatchObject({ status: 409 })
  })

  test('first unlock may establish a previously unknown identity', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'; f.snapshot.seedAddress = null
    const first = f.coordinator.acquire({ unlock: true })
    f.snapshot.state = 'ready'; f.snapshot.seedAddress = '0xfirst'; f.unlock.resolve()
    ;(await first)()
  })

  test('a queued request rechecks the wallet handle, device and known seed', async () => {
    for (const change of [
      (s: DeviceOperationSnapshot) => { s.wallet = {} },
      (s: DeviceOperationSnapshot) => { s.deviceId = 'other' },
      (s: DeviceOperationSnapshot) => { s.seedAddress = '0xother' },
      (s: DeviceOperationSnapshot) => { s.seedAddress = null },
    ]) {
      const f = fixture(), release = await f.coordinator.acquire()
      const next = f.coordinator.acquire(); next.catch(() => {})
      change(f.snapshot); release()
      await expect(next).rejects.toMatchObject({ status: 409 })
    }
  })

  test('abort removes a queued request without cancelling another owner', async () => {
    const f = fixture(), release = await f.coordinator.acquire()
    const abort = new AbortController()
    const next = f.coordinator.acquire({ signal: abort.signal })
    abort.abort()
    await expect(next).rejects.toMatchObject({ status: 499 })
    release()
    expect(f.cancellations()).toBe(0)
  })

  test('aborting an unlock rejects promptly but holds the queue until the wire request drains', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    const abort = new AbortController()
    const first = f.coordinator.acquire({ signal: abort.signal, unlock: true })
    abort.abort()
    await expect(first).rejects.toMatchObject({ status: 499 })
    expect(f.cancellations()).toBe(1)
    f.snapshot.state = 'ready'
    let admitted = false
    const next = f.coordinator.acquire().then(release => { admitted = true; return release })
    await tick(); expect(admitted).toBe(false)
    f.unlock.reject(new Error('PIN cancelled'))
    ;(await next)()
    expect(f.unlocks()).toBe(1)
  })

  test('disconnect retires queued operations without admitting work on the replacement', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    const first = f.coordinator.acquire({ unlock: true }); first.catch(() => {})
    const queued = f.coordinator.acquire({ unlock: true }); queued.catch(() => {})
    f.coordinator.invalidate()
    await expect(first).rejects.toMatchObject({ status: 409 })
    await expect(queued).rejects.toMatchObject({ status: 409 })
    f.snapshot.wallet = {}; f.snapshot.state = 'ready'
    let admitted = false
    const replacement = f.coordinator.acquire().then(release => { admitted = true; return release })
    await tick(); expect(admitted).toBe(false)
    f.unlock.reject(new Error('Disconnected'))
    ;(await replacement)()
  })

  test('an abort cannot release an operation already dispatched', async () => {
    const f = fixture(), abort = new AbortController()
    const release = await f.coordinator.acquire({ signal: abort.signal })
    abort.abort()
    let admitted = false
    const next = f.coordinator.acquire().then(release => { admitted = true; return release })
    await tick(); expect(admitted).toBe(false)
    release(); (await next)()
  })

  test('the waiting queue is bounded', async () => {
    const f = fixture({ maxPending: 1 }), release = await f.coordinator.acquire()
    const next = f.coordinator.acquire()
    await expect(f.coordinator.acquire()).rejects.toMatchObject({ status: 429 })
    release(); (await next)()
  })

  test('interactive Desktop actions reject a busy device instead of becoming delayed jobs', async () => {
    for (const state of ['ready', 'needs_pin']) {
      const f = fixture(); f.snapshot.state = state
      const owner = f.coordinator.acquire({ unlock: true })
      expect(f.coordinator.busy).toBe(true)
      await expect(f.coordinator.acquire({ origin: 'desktop', unlock: true, rejectIfBusy: true })).rejects.toMatchObject({ status: 409 })
      f.snapshot.state = 'ready'; f.unlock.resolve()
      ;(await owner)()
      await tick()
      expect(f.coordinator.busy).toBe(false)
      expect(f.unlocks()).toBe(state === 'needs_pin' ? 1 : 0)
    }
  })

  test('a waiting deadline expires without dispatching that request', async () => {
    const f = fixture({ waitMs: 10 }), release = await f.coordinator.acquire()
    const next = f.coordinator.acquire()
    await expect(next).rejects.toMatchObject({ status: 504 })
    release()
    expect(f.unlocks()).toBe(0)
  })

  test('a passphrase prompt clears old queued work without cancelling the active unlock', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    const first = f.coordinator.acquire({ unlock: true })
    const queued = f.coordinator.acquire({ unlock: true })
    f.coordinator.invalidateQueued()
    await expect(queued).rejects.toMatchObject({ status: 409 })
    expect(f.cancellations()).toBe(0)
    f.snapshot.state = 'ready'; f.unlock.resolve(); (await first)()
  })

  test('setup and wipe ownership reject before unlocking or dispatching', async () => {
    const f = fixture(); f.snapshot.blocked = 'A wipe is waiting for confirmation'
    await expect(f.coordinator.acquire({ unlock: true })).rejects.toMatchObject({ status: 409 })
    expect(f.unlocks()).toBe(0)
  })

  test('an unlock that leaves the device locked does not grant a lease', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    const first = f.coordinator.acquire({ unlock: true }); f.unlock.resolve()
    await expect(first).rejects.toMatchObject({ status: 423 })
  })

  test('fresh foreground metadata detects an unobserved hardware auto-lock before dispatch', async () => {
    const snapshot: DeviceOperationSnapshot = { wallet: {}, deviceId: 'one', seedAddress: 'same', state: 'ready' }
    const order: string[] = []
    const coordinator = new DeviceOperationCoordinator({ snapshot: () => snapshot,
      prepare: async () => { order.push('features'); snapshot.state = 'needs_pin' },
      unlock: async () => { order.push('unlock'); snapshot.state = 'ready' },
    })
    const release = await coordinator.acquire({ unlock: true })
    order.push('dispatch'); release()
    expect(order).toEqual(['features', 'unlock', 'dispatch'])
  })

  test('metadata cannot move an old request into a replacement wallet', async () => {
    const snapshot: DeviceOperationSnapshot = { wallet: {}, deviceId: 'one', seedAddress: 'same', state: 'ready' }
    let unlocks = 0
    const coordinator = new DeviceOperationCoordinator({ snapshot: () => snapshot,
      prepare: async () => { snapshot.wallet = {}; snapshot.state = 'needs_pin' },
      unlock: async () => { unlocks++ },
    })
    await expect(coordinator.acquire({ unlock: true })).rejects.toMatchObject({ status: 409 })
    expect(unlocks).toBe(0)
  })

  // hdwallet throws the decoded Failure event itself, not an Error (audit v4 V8).
  test('a device Failure object from the unlock keeps its text', async () => {
    const f = fixture(); f.snapshot.state = 'needs_pin'
    const pending = f.coordinator.acquire({ unlock: true })
    await tick()
    f.unlock.reject({ message_enum: 3, message_type: 'Failure', message: { code: 6, message: 'PIN Cancelled' } })
    const error = await pending.then(() => null, e => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('PIN Cancelled')
  })

  test('a passive lease detects an unobserved auto-lock without asking for a PIN', async () => {
    let probes = 0, unlocks = 0
    const wallet = {}
    const snapshot = { wallet, seedAddress: null, state: 'ready' }
    const passive = new DeviceOperationCoordinator({ snapshot: () => snapshot,
      prepare: async () => { probes++; snapshot.state = 'needs_pin' }, unlock: async () => { unlocks++ },
    })
    await expect(passive.acquire({ unlock: false })).rejects.toMatchObject({ status: 423 })
    expect(probes).toBe(1)
    expect(unlocks).toBe(0)
  })
})
