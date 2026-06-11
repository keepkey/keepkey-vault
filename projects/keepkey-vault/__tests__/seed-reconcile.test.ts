/**
 * Seed-staleness purge-decision tests.
 *
 * Pins the pure decision that gates the stale-wallet purge of the in-memory
 * account managers (see src/shared/seed-reconcile.ts).
 *
 * Background (recurring customer bug): the UI showed one wallet's addresses/
 * balances while the device OLED showed another's. The managers were reset by
 * INFERRING seed changes from events, and every trigger had a blind spot:
 *  - needs_passphrase reset:  skipped on reconnect with a pre-cached passphrase
 *                             (device goes straight to ready).
 *  - device-switch reset:     skipped when the deviceId is unchanged.
 *  - seed-changed reset:      skipped on hidden→standard transitions — hidden
 *                             wallets never persist seed_eth_<id> (privacy), so
 *                             the stored identity is the standard wallet's and
 *                             MATCHES once the device returns to it.
 *  - passphrase toggle:       applySettings+clearSession changes the effective
 *                             seed but reset only the engine's fingerprint and
 *                             identity, never the managers.
 *
 * The fix checks the RESULT: the seed-identity address (ETH m/44'/60'/0'/0/0)
 * is the exact same path as evmAddressPath(0), so the EVM manager's index-0
 * address must always equal the device-derived identity. Mismatch ⇒ purge.
 *
 * Run: bun test __tests__/seed-reconcile.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { isManagerSeedStale } from '../src/shared/seed-reconcile'
// From shared/chains (NOT src/bun/evm-addresses, which re-exports it): the bun
// module pulls ./db → electrobun side effects that break under bun test.
import { evmAddressPath } from '../src/shared/chains'

const STANDARD = '0x27de622c000000000000000000000000000000aa'
const HIDDEN = '0x4C1922069f8d0B5155338910Ac6262f1Edf15fD2' // the address from the field report

// ── The invariant's foundation: identity path === manager index-0 path ──────
describe('seed-identity path equivalence', () => {
  test("evmAddressPath(0) IS the seed-identity path (ETH m/44'/60'/0'/0/0)", () => {
    // engine-controller.ts checkSeedIdentity/deriveSeedIdentity derive this:
    const seedIdentityPath = [0x80000000 + 44, 0x80000000 + 60, 0x80000000 + 0, 0, 0]
    expect(evmAddressPath(0)).toEqual(seedIdentityPath)
  })
})

// ── The pure decision ───────────────────────────────────────────────────────
describe('isManagerSeedStale', () => {
  test('never purge on uncertainty: unknown device identity', () => {
    expect(isManagerSeedStale(null, HIDDEN)).toBe(false)
    expect(isManagerSeedStale(undefined, HIDDEN)).toBe(false)
    expect(isManagerSeedStale('', HIDDEN)).toBe(false)
  })

  test('never purge on uncertainty: uninitialized managers (no index-0 address)', () => {
    expect(isManagerSeedStale(STANDARD, null)).toBe(false)
    expect(isManagerSeedStale(STANDARD, undefined)).toBe(false)
    expect(isManagerSeedStale(STANDARD, '')).toBe(false)
  })

  test('matching identity is NOT stale — including across casing (engine lowercases, manager keeps checksum case)', () => {
    expect(isManagerSeedStale(STANDARD, STANDARD)).toBe(false)
    expect(isManagerSeedStale(HIDDEN.toLowerCase(), HIDDEN)).toBe(false)
    expect(isManagerSeedStale(HIDDEN, HIDDEN.toLowerCase())).toBe(false)
  })

  test('THE BUG: managers hold the hidden wallet, device is back on standard → purge', () => {
    // Field report: UI showed 0x4C1922... while the device OLED showed the
    // standard wallet. seed-changed could not fire (stored identity == standard
    // == current), needs_passphrase never fired (passphrase removed), deviceId
    // unchanged. Only the result-based check catches it.
    expect(isManagerSeedStale(STANDARD, HIDDEN)).toBe(true)
  })

  test('inverse transition: managers hold standard, device unlocked into hidden → purge', () => {
    expect(isManagerSeedStale(HIDDEN.toLowerCase(), STANDARD)).toBe(true)
  })
})

// ── The blind-spot scenarios, end to end at the decision level ──────────────
describe('blind-spot sequences resolve correctly', () => {
  test('passphrase toggle OFF: identity null right after toggle (no purge), then derived (purge)', () => {
    // applySettings nulls seedEthAddress; managers still hold the hidden wallet.
    expect(isManagerSeedStale(null, HIDDEN)).toBe(false) // pre-derivation: hold fire
    // getBalances/checkSeedIdentity derives the standard identity from the device:
    expect(isManagerSeedStale(STANDARD, HIDDEN)).toBe(true) // now verifiable: purge
    // after purge + re-derivation the managers match:
    expect(isManagerSeedStale(STANDARD, STANDARD)).toBe(false)
  })

  test('reconnect with cached passphrase, same hidden wallet → watch-only continuity preserved (no purge)', () => {
    // Managers kept across disconnect for watch-only; same seed comes back.
    expect(isManagerSeedStale(HIDDEN.toLowerCase(), HIDDEN)).toBe(false)
  })
})

// ── Seed-owner stamp: the BTC-only staleness anchor ─────────────────────────
// reconcileSeedManagers detects staleness two ways, BOTH via this same pure
// comparison: (1) EVM index-0 address vs device, and (2) the seed-owner STAMP
// (managersSeedOwner — the seed the managers were derived under) vs device. The
// stamp is what catches a stale BTC-only manager, where getBtcAccounts
// initialized BTC with no EVM index-0 to compare. Same helper, different operand.
describe('seed-owner stamp comparison (BTC-only gap)', () => {
  test('BTC-only managers stamped under the previous seed are stale when the device seed changes', () => {
    // getBtcAccounts initialized BTC under HIDDEN and stamped it; EVM never
    // initialized (evmIdx0 === null → that leg no-ops). The stamp is the only
    // signal, and it must fire.
    const stamp = HIDDEN.toLowerCase()
    expect(isManagerSeedStale(STANDARD, stamp)).toBe(true)   // stamp leg → purge
    expect(isManagerSeedStale(STANDARD, null)).toBe(false)   // evmIdx0 leg absent → no-op
  })

  test('BTC-only managers stamped under the current seed are fresh (no churn on cold start)', () => {
    const stamp = STANDARD.toLowerCase()
    expect(isManagerSeedStale(STANDARD, stamp)).toBe(false)
  })

  test('unstamped managers (owner null) never purge on the stamp leg — adopt, do not churn', () => {
    expect(isManagerSeedStale(STANDARD, null)).toBe(false)
  })
})
