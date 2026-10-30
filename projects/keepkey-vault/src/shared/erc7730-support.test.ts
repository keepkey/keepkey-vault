import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  CAPABILITY_ERC7730_RUNTIME_REVIEW, ERC7730_TRANSPORT_SUPPORTED,
  erc7730CalldataSkipReason, supportsErc7730Transport, supportsErc7730TypedData, withoutCallerErc7730,
} from './erc7730-support'
import { configureProductionRootTrust } from './certified-evm-envelope'
import { evmCallRequiresAdvancedMode } from '../bun/evm-signing-policy'
import fixtures from '../bun/erc7730-resolver.fixtures.json'
import { ERC7730_FIXTURE_ROOT_PUBLIC_KEY, trustTestRoot } from '../../__tests__/support/clearsign-test-root'

const contract = '0x1111111111111111111111111111111111111111'
const call = '0xdeadbeef' + '00'.repeat(32)
const CAPS = [1, CAPABILITY_ERC7730_RUNTIME_REVIEW]

describe('the ERC-7730 gate', () => {
  it('calldata is on; typed data stays off on 7.16 and is on from 7.17.0', () => {
    expect(ERC7730_TRANSPORT_SUPPORTED).toBe(true)
    expect(supportsErc7730TypedData('7.16.0', CAPS)).toBe(false)
    expect(supportsErc7730TypedData('7.16.9', CAPS)).toBe(false)
    expect(supportsErc7730TypedData('7.17.0', CAPS)).toBe(true)
    expect(supportsErc7730TypedData('7.18.2', CAPS)).toBe(true)
    // Same capability and root rules as calldata.
    expect(supportsErc7730TypedData('7.17.0', [1, 5, 13])).toBe(false)
    expect(supportsErc7730TypedData(undefined, CAPS)).toBe(false)
    try {
      configureProductionRootTrust(() => false)
      expect(supportsErc7730TypedData('7.17.0', CAPS)).toBe(false)
    } finally { configureProductionRootTrust(() => true) }
  })

  it('needs firmware 7.16.0+ AND CAPABILITY_ERC7730_RUNTIME_REVIEW', () => {
    expect(supportsErc7730Transport('7.16.0', CAPS)).toBe(true)
    expect(supportsErc7730Transport('7.17.1', [CAPABILITY_ERC7730_RUNTIME_REVIEW])).toBe(true)
    // The capability alone sits in the 7.15 block.
    expect(supportsErc7730Transport('7.15.0', CAPS)).toBe(false)
    expect(supportsErc7730Transport('7.16.0', [1, 5, 13])).toBe(false)
    expect(supportsErc7730Transport('7.16.0', undefined)).toBe(false)
    expect(supportsErc7730Transport(undefined, CAPS)).toBe(false)
  })

  it('is off for a device that does not trust the production root (the alpha emulator)', () => {
    try {
      configureProductionRootTrust(() => false)
      expect(supportsErc7730Transport('7.16.0', CAPS)).toBe(false)
    } finally { configureProductionRootTrust(() => true) }
  })

  it('never for approve, increaseAllowance, or arguments that are not whole words', () => {
    expect(erc7730CalldataSkipReason(call)).toBeUndefined()
    expect(erc7730CalldataSkipReason('0xdeadbeef')).toBeUndefined()
    expect(erc7730CalldataSkipReason(`0x095ea7b3${'00'.repeat(64)}`)).toMatch(/approval/)
    expect(erc7730CalldataSkipReason(`0x39509351${'00'.repeat(64)}`)).toMatch(/approval/)
    expect(erc7730CalldataSkipReason(`0xdeadbeef${'00'.repeat(31)}`)).toMatch(/32-byte words/)
    expect(erc7730CalldataSkipReason('0xdead')).toBeDefined()
    expect(erc7730CalldataSkipReason(undefined)).toBeDefined()
  })
})

describe('a caller-supplied catalog', () => {
  it('is stripped from the signing request, leaving everything else', () => {
    const out = withoutCallerErc7730({ to: contract, data: call, erc7730: { primaryDefinitionId: '0x11', definitions: [] } }, 'test') as any
    expect(out.erc7730).toBeUndefined()
    expect(out).toEqual({ to: contract, data: call })
  })

  it('does not lift the AdvancedMode requirement', () => {
    expect(evmCallRequiresAdvancedMode(contract, call, 1, false, undefined, { primaryDefinitionId: '0x11', definitions: [] }, '7.16.0', '0x0', CAPS)).toBe(true)
  })
})

describe('a checked ERC-7730 definition and the AdvancedMode gate', () => {
  const { tx, definition } = fixtures.plain
  const catalog = { primaryDefinitionId: definition.definitionId, definitions: [{ ...definition, kind: 1 as const }] }
  // The replay fixtures are signed under their TEST root.
  let restoreRoot = () => {}
  beforeAll(() => { restoreRoot = trustTestRoot(ERC7730_FIXTURE_ROOT_PUBLIC_KEY) })
  afterAll(() => restoreRoot())

  it('lifts the gate only for the call it describes, on a device that takes it', () => {
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, undefined, '7.16.0', tx.value, CAPS)).toBe(true)
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, catalog, '7.16.0', tx.value, CAPS)).toBe(false)
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, catalog, '7.15.0', tx.value, CAPS)).toBe(true)
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, catalog, '7.16.0', tx.value, [1])).toBe(true)
    expect(evmCallRequiresAdvancedMode(contract, tx.data, tx.chainId, false, undefined, catalog, '7.16.0', tx.value, CAPS)).toBe(true)
  })

  it('never beside kind-1 metadata (one description per transaction)', () => {
    const runtime = { signedPayload: '0x0102', keyId: 1 }
    expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, runtime, catalog, '7.16.0', tx.value, CAPS)).toBe(true)
  })

  it('never for a definition with an embedded call', () => {
    const e = fixtures.embedded
    const embedded = { primaryDefinitionId: e.definition.definitionId, definitions: [{ ...e.definition, kind: 1 as const }] }
    expect(evmCallRequiresAdvancedMode(e.tx.to, e.tx.data, e.tx.chainId, false, undefined, embedded, '7.16.0', e.tx.value, CAPS)).toBe(true)
  })
})
