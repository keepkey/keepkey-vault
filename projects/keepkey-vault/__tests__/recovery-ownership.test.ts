/**
 * REST cipher-recovery ownership + seq gate.
 *
 * Mirrors EngineController.assertRecoveryOwner / canReadRecoveryState (they
 * can't be imported directly without the USB/HID native chain — same reason
 * engine-state-machine.test.ts mirrors its pure functions). If the engine
 * logic drifts, these expectations must be updated in lockstep.
 *
 * Run: bun test __tests__/recovery-ownership.test.ts
 */
import { describe, test, expect } from 'bun:test'

// ── Mirror of the engine gate ─────────────────────────────────────────
interface RecoveryState {
  recoveryActive: boolean
  recoveryOwner: string | null
  characterRequestSeq: number
}

class Gate {
  constructor(private s: RecoveryState) {}

  // throws with a 409-ish tag on any mismatch (mirror of assertRecoveryOwner)
  assertOwner(ownerId: string, expectedSeq?: number) {
    if (!this.s.recoveryActive || !this.s.recoveryOwner) {
      throw new Error('409:no recovery')
    }
    if (this.s.recoveryOwner !== ownerId) {
      throw new Error('409:wrong owner')
    }
    if (expectedSeq !== undefined && expectedSeq !== this.s.characterRequestSeq) {
      throw new Error('409:stale seq')
    }
  }

  canRead(ownerId: string): boolean {
    return !this.s.recoveryActive || this.s.recoveryOwner === ownerId
  }
}

const OWNER = 'apikey-owner'
const OTHER = 'apikey-other'

describe('recovery ownership gate', () => {
  test('rejects character input when no recovery is active', () => {
    const g = new Gate({ recoveryActive: false, recoveryOwner: null, characterRequestSeq: 0 })
    expect(() => g.assertOwner(OWNER, 0)).toThrow(/no recovery/)
  })

  test('rejects a second paired client during an owned recovery', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 3 })
    expect(() => g.assertOwner(OTHER, 3)).toThrow(/wrong owner/)
  })

  test('rejects a stale/reordered seq from the owner', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 5 })
    expect(() => g.assertOwner(OWNER, 4)).toThrow(/stale seq/) // client saw seq 4, device already at 5
  })

  test('accepts the owner with the current seq', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 5 })
    expect(() => g.assertOwner(OWNER, 5)).not.toThrow()
  })

  test('accepts the owner when seq is omitted (delete/done path)', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 5 })
    expect(() => g.assertOwner(OWNER)).not.toThrow()
  })
})

describe('recovery state read access', () => {
  test('any client may read when no recovery is active', () => {
    const g = new Gate({ recoveryActive: false, recoveryOwner: null, characterRequestSeq: 0 })
    expect(g.canRead(OTHER)).toBe(true)
  })

  test('only the owner may read an active recovery', () => {
    const g = new Gate({ recoveryActive: true, recoveryOwner: OWNER, characterRequestSeq: 2 })
    expect(g.canRead(OWNER)).toBe(true)
    expect(g.canRead(OTHER)).toBe(false)
  })
})
