import { describe, expect, it } from 'bun:test'
import { ERC7730_TRANSPORT_SUPPORTED, withoutUnsupportedErc7730 } from './erc7730-support'
import { evmCallRequiresAdvancedMode } from '../bun/evm-signing-policy'

const catalog = { primaryDefinitionId: '0x11', definitions: [] }
const contract = '0x1111111111111111111111111111111111111111'
const call = '0xdeadbeef' + '00'.repeat(32)

describe('ERC-7730 catalog without a transport', () => {
  it('is not delivered by the pinned hdwallet', () => {
    expect(ERC7730_TRANSPORT_SUPPORTED).toBe(false)
  })

  it('is stripped from the signing request, leaving everything else', () => {
    const out = withoutUnsupportedErc7730({ to: contract, data: call, erc7730: catalog }, 'test') as any
    expect(out.erc7730).toBeUndefined()
    expect(out).toEqual({ to: contract, data: call })
  })

  it('does not lift the AdvancedMode requirement for an opaque call', () => {
    expect(evmCallRequiresAdvancedMode(contract, call, 1, false, undefined, catalog)).toBe(true)
  })
})
