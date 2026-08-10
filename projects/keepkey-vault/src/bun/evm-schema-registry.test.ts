import { describe, it, expect } from 'bun:test'
import { findEvmSchema } from './evm-schema-registry'

/* The exact Relay ETH->Solana bridge deposit captured from api.relay.link on
 * 2026-07-27 — the transaction that used to blind-sign. */
const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const DATA =
  '0x49290c1c' +
  '000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e' +
  '8a2c121197efc95c42f53142ab409735ee353287f877ed4d351f63094d5bfcb1'

describe('findEvmSchema', () => {
  it('matches the real Relay bridge deposit', () => {
    const hit = findEvmSchema(1, TO, DATA)
    expect(hit).toBeDefined()
    expect(hit!.method).toBe('bridgeDeposit')
    expect(hit!.signedPayload.startsWith('0x')).toBe(true)
    // 4-byte selector + 2 words
    expect(hit!.expectedCalldataLength).toBe(68)
    expect((DATA.length - 2) / 2).toBe(hit!.expectedCalldataLength)
  })

  it('is case-insensitive on the contract address', () => {
    expect(findEvmSchema(1, TO.toUpperCase(), DATA)).toBeDefined()
  })

  /* A schema authorises a specific decode. Matching too loosely would let the
   * device render one method's labels over another call's bytes, so every
   * component of the key must be required. */
  it('does not match a different chain, contract, or selector', () => {
    expect(findEvmSchema(8453, TO, DATA)).toBeUndefined()
    expect(findEvmSchema(1, '0x0000000000000000000000000000000000000001', DATA)).toBeUndefined()
    expect(findEvmSchema(1, TO, '0xdeadbeef' + DATA.slice(10))).toBeUndefined()
  })

  /* Firmware requires declared arg widths to account for the calldata exactly;
   * refusing here avoids a confusing mid-signing rejection on the device. */
  it('rejects calldata whose length does not match the schema', () => {
    expect(findEvmSchema(1, TO, DATA + 'ab'.repeat(32))).toBeUndefined()
    expect(findEvmSchema(1, TO, DATA.slice(0, 42))).toBeUndefined()
  })

  it('returns undefined on missing input rather than throwing', () => {
    expect(findEvmSchema(undefined, TO, DATA)).toBeUndefined()
    expect(findEvmSchema(1, undefined, DATA)).toBeUndefined()
    expect(findEvmSchema(1, TO, undefined)).toBeUndefined()
    expect(findEvmSchema(1, TO, '0x')).toBeUndefined()
  })
})
