/** Audit v6 H10: a failed getAppSettings left Zcash, Hive and Monero hidden until something else changed. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettingsLoader, dispatchBackendSettingsChanged, settingsChangedByBackend, SETTINGS_CHANGED_EVENT, SETTINGS_RETRY_DELAYS_MS } from '../src/mainview/lib/app-settings-loader'
import type { AppSettings } from '../src/shared/types'

const settings = (zcashPrivacyEnabled: boolean) => ({ zcashPrivacyEnabled, hiveEnabled: true, moneroEnabled: true }) as AppSettings

/** A scripted backend and a manual clock. */
function harness(replies: Array<'fail' | 'hang' | AppSettings>) {
  const applied: AppSettings[] = []
  const warnings: string[] = []
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  const pending: Array<{ resolve: (s: AppSettings) => void; reject: (e: Error) => void }> = []
  let calls = 0
  const loader = createSettingsLoader(s => applied.push(s), {
    request: () => {
      const reply = replies[calls++] ?? 'fail'
      if (reply === 'fail') return Promise.reject(new Error('RPC request timed out: getAppSettings'))
      if (reply === 'hang') return new Promise((resolve, reject) => pending.push({ resolve, reject }))
      return Promise.resolve(reply)
    },
    setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { (timer as { cleared: boolean }).cleared = true },
    warn: message => warnings.push(message),
  })
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  /** Fire the next armed timer, as the clock would. */
  const tick = async () => {
    const timer = timers.find(t => !t.cleared && !(t as any).fired)
    if (!timer) throw new Error('no timer armed')
    ;(timer as any).fired = true
    timer.run()
    await flush()
    return timer.ms
  }
  return { loader, applied, warnings, timers, pending, flush, tick, calls: () => calls }
}

describe('settings loader', () => {
  test('a successful read is applied once and arms no retry', async () => {
    const h = harness([settings(true)])
    h.loader.load(); await h.flush()
    expect(h.applied).toEqual([settings(true)])
    expect(h.timers).toEqual([])
  })

  test('a failed read is retried with growing waits until it succeeds', async () => {
    const h = harness(['fail', 'fail', settings(true)])
    h.loader.load(); await h.flush()
    expect(h.applied).toEqual([])
    expect(await h.tick()).toBe(SETTINGS_RETRY_DELAYS_MS[0])
    expect(h.applied).toEqual([])
    expect(await h.tick()).toBe(SETTINGS_RETRY_DELAYS_MS[1])
    expect(h.applied).toEqual([settings(true)])
    expect(h.calls()).toBe(3)
  })

  test('it stops after the last wait, warns once, and a later load starts over', async () => {
    const h = harness([])
    h.loader.load(); await h.flush()
    for (const delay of SETTINGS_RETRY_DELAYS_MS) expect(await h.tick()).toBe(delay)
    expect(h.calls()).toBe(SETTINGS_RETRY_DELAYS_MS.length + 1)
    expect(h.timers.filter(t => !(t as any).fired && !t.cleared)).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain(`after ${SETTINGS_RETRY_DELAYS_MS.length + 1} attempts`)
    h.loader.load(); await h.flush()
    expect(h.calls()).toBe(SETTINGS_RETRY_DELAYS_MS.length + 2)
    expect(h.timers.filter(t => !(t as any).fired && !t.cleared)).toHaveLength(1)
  })

  test('the latest load wins: an older reply never overwrites a newer one', async () => {
    const h = harness(['hang', settings(true)])
    h.loader.load(); await h.flush()
    h.loader.load(); await h.flush()
    expect(h.applied).toEqual([settings(true)])
    h.pending[0].resolve(settings(false)); await h.flush()
    expect(h.applied).toEqual([settings(true)])
  })

  test('a new load replaces a pending retry instead of running two', async () => {
    const h = harness(['fail', settings(true)])
    h.loader.load(); await h.flush()
    expect(h.timers).toHaveLength(1)
    h.loader.load(); await h.flush()
    expect(h.timers[0].cleared).toBe(true)
    expect(h.applied).toEqual([settings(true)])
  })

  test('cancel (unmount) stops a pending retry and ignores a reply in flight', async () => {
    const h = harness(['fail'])
    h.loader.load(); await h.flush()
    h.loader.cancel()
    expect(h.timers[0].cleared).toBe(true)
    const late = harness(['hang'])
    late.loader.load(); await late.flush()
    late.loader.cancel()
    late.pending[0].resolve(settings(true)); await late.flush()
    expect(late.applied).toEqual([])
  })
})

describe('backend-origin refresh', () => {
  test('a push or reconnect is dispatched as the usual event, marked as coming from the backend', () => {
    const previous = (globalThis as any).window
    const target = new EventTarget()
    ;(globalThis as any).window = target
    const seen: Event[] = []
    target.addEventListener(SETTINGS_CHANGED_EVENT, event => seen.push(event))
    try {
      dispatchBackendSettingsChanged('push')
      dispatchBackendSettingsChanged('reconnect')
    } finally { (globalThis as any).window = previous }
    expect(seen.map(settingsChangedByBackend)).toEqual([true, true])
    expect(seen.map(event => (event as CustomEvent).detail.reason)).toEqual(['push', 'reconnect'])
    // A plain event, as the settings drawer and node panel dispatch, is a user change.
    expect(settingsChangedByBackend(new Event(SETTINGS_CHANGED_EVENT))).toBe(false)
  })
})

describe('wiring', () => {
  const src = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')
  test('the views that hide Zcash, Hive and Monero read settings through the retrying loader', () => {
    for (const path of ['src/mainview/components/Dashboard.tsx', 'src/mainview/components/AssetPage.tsx', 'src/mainview/App.tsx']) {
      const code = src(path)
      expect(code).toContain('useAppSettingsLoader(')
      // No direct read left that could swallow a failure.
      expect(code).not.toMatch(/rpcRequest(<[^>]*>)?\(\s*['"]getAppSettings['"]/)
    }
  })
  test('the backend pushes settings-changed when firmware flips Zcash or Hive, and the UI turns it into a refresh', () => {
    const index = src('src/bun/index.ts')
    expect(index).toContain("rpc.send['settings-changed'](getAppSettings())")
    expect(index).toMatch(/flagsChanged = zcashPrivacyEnabled !== hasZcashPrivacy \|\| hiveEnabled !== has715/)
    expect(index).toContain('if (flagsChanged) notifySettingsChanged()')
    expect(src('src/shared/rpc-schema.ts')).toContain("'settings-changed': AppSettings")
    expect(src('src/mainview/App.tsx')).toContain("onRpcMessage('settings-changed', () => dispatchBackendSettingsChanged('push'))")
  })
  test('a reconnect re-reads settings, and Monero never reopens its wallet on a backend-origin refresh', () => {
    expect(src('src/mainview/lib/rpc.ts')).toMatch(/if \(connectedOnce\) dispatchBackendSettingsChanged\('reconnect'\)/)
    expect(src('src/mainview/components/MoneroAssetSections.tsx')).toContain('if (!settingsChangedByBackend(event) && !connecting) void connect()')
  })
})
