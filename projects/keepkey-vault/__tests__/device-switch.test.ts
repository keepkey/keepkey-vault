/**
 * Device-switch reset-decision tests.
 *
 * Pins the pure decision that gates the in-memory account-manager reset on an
 * A->B hardware swap (see src/shared/device-switch.ts).
 *
 * Background: the in-memory managers (btcAccounts/evmAddresses) cache the
 * connected device's BTC xpubs + EVM addresses and are deliberately KEPT across
 * 'disconnected' for the watch-only UI, so they only re-derive when empty. On an
 * A->B hardware swap the deviceId changes but `seed-changed` never fires (it
 * compares against the per-device seed_eth_${id} key, which matches B's own
 * identity), so device B silently reuses device A's addresses -> stale receive
 * addresses that don't even match the device OLED. The fix resets the managers
 * on the B-ready edge.
 *
 * The prior attempt (closed PR #202) reset correctly in the backend but ALSO
 * keyed <Dashboard> on deviceId, which remounted it on the NORMAL cold-start
 * disconnected->ready transition and raced the balance load. So the fix is
 * backend-only and these tests lock the exact edge-trigger plus the
 * "never null the tracker on disconnect" invariant the correctness hinges on.
 *
 * Run: bun test __tests__/device-switch.test.ts
 */
import { describe, test, expect } from 'bun:test'
import {
  shouldResetManagersOnReady,
  nextReadyDeviceId,
  type DeviceSwitchState,
} from '../src/shared/device-switch'
import { BtcAccountManager } from '../src/bun/btc-accounts'

const s = (state: string, deviceId?: string): DeviceSwitchState => ({ state, deviceId })

// ── Step 1: the pure decision ─────────────────────────────────────────────
describe('shouldResetManagersOnReady', () => {
  test('cold start: first device reaching ready does NOT reset (nothing stale yet)', () => {
    expect(shouldResetManagersOnReady(s('ready', 'A'), null)).toBe(false)
  })

  test('non-ready states never reset, regardless of deviceId', () => {
    for (const st of ['disconnected', 'connected_unpaired', 'needs_pin', 'needs_passphrase', 'bootloader', 'needs_firmware', 'needs_init', 'error']) {
      expect(shouldResetManagersOnReady(s(st, 'B'), 'A')).toBe(false)
    }
  })

  test('ready with empty/undefined deviceId (the disconnected/unpaired gap) does NOT reset', () => {
    expect(shouldResetManagersOnReady(s('ready', undefined), 'A')).toBe(false)
    expect(shouldResetManagersOnReady(s('ready', ''), 'A')).toBe(false)
  })

  test('benign re-emit: same device reaching ready again is a no-op (post-PIN/passphrase/probe/seed-check)', () => {
    expect(shouldResetManagersOnReady(s('ready', 'A'), 'A')).toBe(false)
  })

  test('real A->B swap: a different truthy device reaching ready resets', () => {
    expect(shouldResetManagersOnReady(s('ready', 'B'), 'A')).toBe(true)
  })
})

// ── Step 1: the tracker advance rule ──────────────────────────────────────
describe('nextReadyDeviceId', () => {
  test('advances to the device that reached ready', () => {
    expect(nextReadyDeviceId(s('ready', 'B'), 'A')).toBe('B')
    expect(nextReadyDeviceId(s('ready', 'A'), null)).toBe('A')
  })

  test('non-ready or undefined-deviceId states leave the tracker unchanged', () => {
    expect(nextReadyDeviceId(s('needs_passphrase', 'A'), 'A')).toBe('A')
    expect(nextReadyDeviceId(s('ready', undefined), 'A')).toBe('A')
    expect(nextReadyDeviceId(s('ready', ''), 'A')).toBe('A')
  })

  test('CRITICAL: disconnected does NOT null the tracker (a swap always passes through disconnected)', () => {
    expect(nextReadyDeviceId(s('disconnected', undefined), 'A')).toBe('A')
  })
})

// ── Step 2: drive the EXACT swap event order through both functions ────────
describe('A->B swap event sequence (reducer)', () => {
  test('reset fires exactly once, only on the B-ready edge; tracker never nulls on disconnect', () => {
    const sequence: DeviceSwitchState[] = [
      s('ready', 'A'),                    // initial pair/initialize
      s('ready', 'A'),                    // checkSeedIdentity re-emit (same device)
      s('disconnected', undefined),       // unplug A
      s('connected_unpaired', undefined), // plug B, pairing
      s('ready', 'B'),                    // B ready -> the swap edge
      s('ready', 'B'),                    // B post-ready re-emit (same device)
    ]
    const resets: boolean[] = []
    const trackerAfter: (string | null)[] = []
    let last: string | null = null
    for (const ev of sequence) {
      // Order matters: decide with the PRE-update tracker, then advance it.
      resets.push(shouldResetManagersOnReady(ev, last))
      last = nextReadyDeviceId(ev, last)
      trackerAfter.push(last)
    }
    expect(resets).toEqual([false, false, false, false, true, false])
    expect(trackerAfter).toEqual(['A', 'A', 'A', 'A', 'B', 'B'])
  })

  test('hot-swap with no clean disconnect gap (dropped detach) still resets on the value change', () => {
    // A 'already-paired' fast-path can reach a new ready without a clean
    // disconnected gap. The reset keys on the deviceId VALUE changing, not on
    // observing a disconnect, so it still fires.
    let last: string | null = null
    last = nextReadyDeviceId(s('ready', 'A'), last)            // A ready
    const reset = shouldResetManagersOnReady(s('ready', 'B'), last) // straight to B
    expect(reset).toBe(true)
  })
})

// ── Step 3: the reset() contract the index.ts wiring depends on ────────────
// Imports the REAL BtcAccountManager (clean imports: events + shared/chains +
// types — no ./db / native). evm-addresses.ts is NOT imported here because it
// pulls ./db (sqlite side-effects); its reset() follows the identical contract
// verified at evm-addresses.ts reset()/toAddressSet().
describe('BtcAccountManager.reset() contract', () => {
  const fakeWallet = {
    // initialize() -> fetchAccount() -> wallet.getPublicKeys(paths)
    getPublicKeys: async (paths: any[]) => paths.map((_, i) => ({ xpub: `xpubFAKE${i}` })),
  }

  test('reset() drops device-A state so the next fetch re-derives for device B', async () => {
    const mgr = new BtcAccountManager()
    await mgr.initialize(fakeWallet)
    expect(mgr.isInitialized).toBe(true)
    expect(mgr.toAccountSet().accounts.length).toBeGreaterThan(0)

    mgr.reset()

    expect(mgr.isInitialized).toBe(false)
    expect(mgr.toAccountSet().accounts).toEqual([])
    // selection falls back to the default account 0 / native-segwit
    expect(mgr.toAccountSet().selectedXpub).toEqual({ accountIndex: 0, scriptType: 'p2wpkh' })
  })
})
