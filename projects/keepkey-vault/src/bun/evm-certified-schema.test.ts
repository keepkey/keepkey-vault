import { describe, expect, it } from 'bun:test'

import {
  buildEvmV2SchemaBody,
  CERTIFIED_EVM_CATALOG,
  CERTIFIED_METADATA_KEY_ID,
  findCertifiedEvmSchemaByShape,
  findCertifiedEvmSchemaSpec,
} from './evm-certified-schema'

const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const DATA =
  '0x49290c1c' +
  '000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e' +
  '8a2c121197efc95c42f53142ab409735ee353287f877ed4d351f63094d5bfcb1'

describe('7.16 certified EVM schemas', () => {
  it('serializes the Relay schema with a delegate sentinel trailer', () => {
    const spec = CERTIFIED_EVM_CATALOG[`1:${TO}:0x49290c1c`]
    const body = buildEvmV2SchemaBody(spec)
    expect(body[0]).toBe(0x02)
    expect(body[body.length - 1]).toBe(CERTIFIED_METADATA_KEY_ID)
    expect(body.subarray(1, 5).readUInt32BE()).toBe(1)
    expect(body.includes(Buffer.from('bridgeDeposit', 'ascii'))).toBe(true)
  })

  it('matches only the complete reviewed Relay calldata shape', () => {
    expect(findCertifiedEvmSchemaSpec(1, TO, DATA)?.method).toBe('bridgeDeposit')
    expect(findCertifiedEvmSchemaSpec(1, TO, `${DATA}00`)).toBeUndefined()
    expect(findCertifiedEvmSchemaSpec(8453, TO, DATA)).toBeUndefined()
    expect(findCertifiedEvmSchemaSpec(1, TO, `0xdeadbeef${DATA.slice(10)}`)).toBeUndefined()
  })

  it('matches the privacy-preserving call shape without argument values', () => {
    expect(findCertifiedEvmSchemaByShape(1, TO, '0x49290c1c', 68)?.method).toBe('bridgeDeposit')
    expect(findCertifiedEvmSchemaByShape(1, TO, '0x49290c1c', 100)).toBeUndefined()
    expect(findCertifiedEvmSchemaByShape(1, TO, '0xdeadbeef', 68)).toBeUndefined()
  })
})
