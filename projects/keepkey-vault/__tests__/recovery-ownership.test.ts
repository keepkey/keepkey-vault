/**
 * REST cipher-recovery ownership + seq gate.
 *
 * This mirrors the pure decision logic of EngineController's recovery methods
 * (beginRecovery / assertRecoveryOwner / submitRecoveryAck / canReadRecoveryState).
 * The engine itself can't be imported without the USB/HID native chain — same
 * reason engine-state-machine.test.ts mirrors its pure functions. The mirror is
 * kept in lockstep with the engine; if one changes, change both.
 *
 * Run: bun test __tests__/recovery-ownership.test.ts
 */
import { describe, test, expect } from 'bun:test'

// ── Mirror of the engine gate ─────────────────────────────────────────
interface RecoveryState {
  recoveryActive: boolean
  recoveryOwner: string | null
  characterRequestSeq: number
  lastCharacterRequest: object | null // present only once the device has asked
}

class Gate {
  lastAcceptedCharSeq = -1
  recoverySendInFlight = false
  constructor(private s: RecoveryState) {}

  // mirror of assertRecoveryOwner
  assertOwner(ownerId: string, expectedSeq?: number) {
    if (!this.s.recoveryActive || !this.s.recoveryOwner) throw new Error('409:no recovery')
    if (this.s.recoveryOwner !== ownerId) throw new Error('409:wrong owner')
    if (expectedSeq !== undefined && expectedSeq !== this.s.characterRequestSeq) throw new Error('409:stale seq')
  }

  canRead(ownerId: string): boolean {
    return !this.s.recoveryActive || this.s.recoveryOwner === ownerId
  }

  // mirror of beginRecovery — rejects a concurrent start; clears the outstanding
  // request; does NOT reset characterRequestSeq (stays monotonic across sessions)
  begin(ownerId: string) {
    if (this.s.recoveryActive) throw new Error('409:already in progress')
    this.s.recoveryActive = true
    this.s.recoveryOwner = ownerId
    this.s.lastCharacterRequest = null
    this.recoverySendInFlight = false
  }

  // mirror of endRecovery — clears the session but leaves seq/lastAccepted
  // MONOTONIC (only a device disconnect / resetRecoveryState fully resets them)
  end() {
    this.s.recoveryActive = false
    this.s.recoveryOwner = null
    this.recoverySendInFlight = false
  }

  // the device issues a CharacterRequest
  deviceAsks() {
    this.s.characterRequestSeq++
    this.s.lastCharacterRequest = { wordPos: 0, characterPos: 0 }
  }

  // mirror of submitRecoveryAck's SYNCHRONOUS portion (checks + claim + guard).
  // The real send is async; the guard is released by completeAck() (simulating
  // the await resolving). All three actions share recoverySendInFlight.
  submitAck(ownerId: string, action: 'character' | 'delete' | 'done', opts: { expectedSeq?: number } = {}) {
    this.assertOwner(ownerId, action === 'done' ? undefined : opts.expectedSeq)
    if (action === 'character') {
      if (!this.s.lastCharacterRequest) throw new Error('409:no request yet')
      if (opts.expectedSeq === undefined) throw new Error('400:seq required')
      if (opts.expectedSeq <= this.lastAcceptedCharSeq) throw new Error('409:already sent')
    }
    if (this.recoverySendInFlight) throw new Error('409:in flight')
    this.recoverySendInFlight = true
    if (action === 'character') this.lastAcceptedCharSeq = opts.expectedSeq!
  }
  completeAck() {
    this.recoverySendInFlight = false
  }
}

const OWNER = 'apikey-owner'
const OTHER = 'apikey-other'
const idle = (): RecoveryState => ({ recoveryActive: false, recoveryOwner: null, characterRequestSeq: 0, lastCharacterRequest: null })

describe('recovery ownership gate', () => {
  test('rejects character input when no recovery is active', () => {
    const g = new Gate({ ...idle(), lastCharacterRequest: {} })
    expect(() => g.assertOwner(OWNER, 0)).toThrow(/no recovery/)
  })

  test('rejects a second paired client during an owned recovery', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 3, lastCharacterRequest: {} })
    expect(() => g.assertOwner(OTHER, 3)).toThrow(/wrong owner/)
  })

  test('rejects a stale/reordered seq from the owner', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 5, lastCharacterRequest: {} })
    expect(() => g.assertOwner(OWNER, 4)).toThrow(/stale seq/)
  })

  test('accepts the owner with the current seq', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 5, lastCharacterRequest: {} })
    expect(() => g.assertOwner(OWNER, 5)).not.toThrow()
  })
})

describe('recovery state read access', () => {
  test('any client may read when no recovery is active', () => {
    expect(new Gate(idle()).canRead(OTHER)).toBe(true)
  })
  test('only the owner may read an active recovery', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 2, lastCharacterRequest: {} })
    expect(g.canRead(OWNER)).toBe(true)
    expect(g.canRead(OTHER)).toBe(false)
  })
})

describe('concurrent-start lock-steal guard', () => {
  test('a second recover-device start is rejected while one is active', () => {
    const g = new Gate(idle())
    g.begin(OWNER)
    expect(() => g.begin(OTHER)).toThrow(/already in progress/)
    expect(g.canRead(OTHER)).toBe(false)
  })
})

describe('character before the device requests one (finding #1)', () => {
  test('a character sent before the first CharacterRequest is rejected', () => {
    const g = new Gate(idle())
    g.begin(OWNER) // device has NOT asked yet → lastCharacterRequest null, seq unchanged
    expect(() => g.submitAck(OWNER, 'character', { expectedSeq: 0 })).toThrow(/no request yet/)
  })

  test('after the device asks, the character at the current seq is accepted', () => {
    const g = new Gate(idle())
    g.begin(OWNER)
    g.deviceAsks() // seq → 1, request outstanding
    expect(() => g.submitAck(OWNER, 'character', { expectedSeq: 1 })).not.toThrow()
  })

  test('seq stays monotonic across sessions — a prior seq cannot be replayed', () => {
    const g = new Gate(idle())
    g.begin(OWNER); g.deviceAsks(); g.submitAck(OWNER, 'character', { expectedSeq: 1 }); g.completeAck(); g.end()
    g.begin(OWNER) // new session, seq NOT reset
    g.deviceAsks() // seq → 2
    expect(() => g.submitAck(OWNER, 'character', { expectedSeq: 1 })).toThrow(/stale seq/) // old seq rejected
    expect(() => g.submitAck(OWNER, 'character', { expectedSeq: 2 })).not.toThrow()
  })
})

describe('all acks share one in-flight guard (finding #2)', () => {
  test('duplicate same-seq character sends: second is rejected', () => {
    const g = new Gate(idle())
    g.begin(OWNER); g.deviceAsks()
    g.submitAck(OWNER, 'character', { expectedSeq: 1 }) // A claims + holds the guard
    expect(() => g.submitAck(OWNER, 'character', { expectedSeq: 1 })).toThrow(/already sent|in flight/)
  })

  test('delete cannot race a character send still in flight', () => {
    const g = new Gate(idle())
    g.begin(OWNER); g.deviceAsks()
    g.submitAck(OWNER, 'character', { expectedSeq: 1 }) // in flight
    expect(() => g.submitAck(OWNER, 'delete', {})).toThrow(/in flight/)
  })

  test('done cannot race a delete still in flight', () => {
    const g = new Gate(idle())
    g.begin(OWNER); g.deviceAsks()
    g.submitAck(OWNER, 'delete', {}) // in flight
    expect(() => g.submitAck(OWNER, 'done', {})).toThrow(/in flight/)
  })

  test('a non-owner cannot delete or finalize an owned recovery', () => {
    const g = new Gate(idle())
    g.begin(OWNER); g.deviceAsks()
    expect(() => g.submitAck(OTHER, 'delete', {})).toThrow(/wrong owner/)
    expect(() => g.submitAck(OTHER, 'done', {})).toThrow(/wrong owner/)
  })

  test('sequential acks succeed once the prior one completes', () => {
    const g = new Gate(idle())
    g.begin(OWNER); g.deviceAsks()
    g.submitAck(OWNER, 'character', { expectedSeq: 1 }); g.completeAck()
    g.deviceAsks() // seq → 2
    expect(() => g.submitAck(OWNER, 'character', { expectedSeq: 2 })).not.toThrow()
    g.completeAck()
    expect(() => g.submitAck(OWNER, 'done', {})).not.toThrow()
  })
})
