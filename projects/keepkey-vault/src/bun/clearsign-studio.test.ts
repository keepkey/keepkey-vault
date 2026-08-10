import { describe, expect, it } from 'bun:test'

import { buildSolanaSchema, inspectSolanaSchema } from './clearsign-studio'

const RELAY_SCHEMA_HEX = [
  '4b4b534f4c53433101792689378ecd51d80406eb0caa3b62795beb10b6c5dc96bc2e0df03cbfee1abf',
  '080d9e0ddf5fd51c060c52656c6179204272696467650d6465706f7369744e6174697665020106416d',
  '6f756e7404054f726465720103055661756c74',
].join('')

const RELAY_DRAFT = {
  programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
  discriminator: '0d9e0ddf5fd51c06',
  programName: 'Relay Bridge',
  instructionName: 'depositNative',
  args: [
    { type: 'u64' as const, label: 'Amount' },
    { type: 'opaque32' as const, label: 'Order' },
  ],
  accounts: [{ index: 3, label: 'Vault' }],
}

describe('ClearSign Studio KKSOLSC1 authoring', () => {
  it('reproduces the firmware/SDK Relay fixture byte for byte', () => {
    const artifact = buildSolanaSchema(RELAY_DRAFT)
    expect(artifact.payload).toBe(RELAY_SCHEMA_HEX)
    expect(artifact.byteLength).toBe(RELAY_SCHEMA_HEX.length / 2)
    expect(artifact.coverageBytes).toBe(48)
  })

  it('round-trips a canonical payload into a human-reviewable draft', () => {
    const artifact = inspectSolanaSchema(RELAY_SCHEMA_HEX)
    expect(artifact.draft).toEqual(RELAY_DRAFT)
    expect(buildSolanaSchema(artifact.draft).payload).toBe(RELAY_SCHEMA_HEX)
  })

  it('refuses unsafe display labels and trailing bytes', () => {
    expect(() => buildSolanaSchema({ ...RELAY_DRAFT, programName: 'Relay%Bridge' })).toThrow('cannot contain %')
    expect(() => inspectSolanaSchema(`${RELAY_SCHEMA_HEX}00`)).toThrow('trailing bytes')
  })

  it('enforces the firmware argument and account caps', () => {
    expect(() => buildSolanaSchema({
      ...RELAY_DRAFT,
      args: Array.from({ length: 5 }, (_, i) => ({ type: 'u8' as const, label: `Arg ${i}` })),
    })).toThrow('at most 4 arguments')
  })
})

