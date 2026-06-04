/**
 * Pure device-switch decision used by the engine state-change handler to decide
 * when to reset the in-memory account managers (btcAccounts / evmAddresses) on a
 * device-to-device (A->B) hardware swap.
 *
 * Lives here (shared/, no I/O imports) — modeled on swap-revert.ts — so the
 * decision is unit-testable without dragging the bun + USB/HID + sqlite stack
 * into the test runner. src/bun/index.ts wires it into engine.on('state-change').
 *
 * Why this exists: the managers cache the connected device's xpubs/addresses and
 * are deliberately KEPT across 'disconnected' for the watch-only UI, so they only
 * re-derive when empty. On an A->B swap the deviceId changes but `seed-changed`
 * never fires (it compares against the per-device seed_eth_${id} key, which
 * matches B's own identity), so without this the new device reuses the old
 * device's addresses — stale receive addresses that don't match the device OLED.
 *
 * Invariants (locked by __tests__/device-switch.test.ts):
 *  - Edge-triggered: reset ONLY when a *different* truthy deviceId reaches 'ready'.
 *  - No reset on the first device (lastReadyDeviceId === null) — nothing stale yet,
 *    and this avoids racing the normal cold-start load.
 *  - The benign 2-4 'ready' re-emits for one device (post-PIN/passphrase/probe,
 *    checkSeedIdentity) carry the SAME deviceId, so they are no-ops.
 *  - The tracker is NEVER nulled on 'disconnected'. A swap always passes through
 *    'disconnected', and the managers are intentionally kept across it; nulling
 *    the tracker there would make the next B-ready edge look like a first device
 *    and SKIP the reset, silently reintroducing the bug. This is the deliberate
 *    divergence from rest-api.ts (which DOES null on disconnect, but only because
 *    it also clears its caches there).
 */

/** Minimal structural view of the emitted device state — only the fields the
 *  decision needs, so tests need no native imports. The runtime passes a full
 *  DeviceStateInfo, which is assignable to this. */
export interface DeviceSwitchState {
  state: string
  deviceId?: string
}

/** True IFF a genuinely different device has just reached 'ready' while a prior
 *  device was already tracked — i.e. an A->B swap that requires dropping the
 *  in-memory account managers' device-A data. */
export function shouldResetManagersOnReady(
  state: DeviceSwitchState,
  lastReadyDeviceId: string | null,
): boolean {
  return (
    state.state === 'ready' &&
    !!state.deviceId &&
    lastReadyDeviceId !== null &&
    state.deviceId !== lastReadyDeviceId
  )
}

/** Next value of the lastReadyDeviceId tracker. Advances only when a device
 *  reaches 'ready' with a truthy deviceId; otherwise returns the tracker
 *  unchanged. Critically does NOT null on 'disconnected'/undefined — the tracker
 *  must survive the disconnect gap of a swap so the subsequent B-ready edge is
 *  detected. */
export function nextReadyDeviceId(
  state: DeviceSwitchState,
  lastReadyDeviceId: string | null,
): string | null {
  if (state.state === 'ready' && state.deviceId) return state.deviceId
  return lastReadyDeviceId
}
