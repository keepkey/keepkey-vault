import { describe, expect, test } from 'bun:test'

import { authenticatedClearSignLevel, classifyEffectExposure, expandClearSignAuditDrafts, observeEvmCall, observeEvmTypedData, observeMalformedSolanaTransaction, observeSolanaTransaction, summarizeClearSignObservations } from '../src/bun/clearsign-observation'

describe('ClearSign demand observations', () => {
  test('reserves P5 for device-authenticated definitions with current code identity', () => {
    expect(authenticatedClearSignLevel('certified', true)).toBe('P5')
    expect(authenticatedClearSignLevel('erc7730', false)).toBe('P4')
    expect(authenticatedClearSignLevel('runtime', true)).toBe('P2')
  })
  test('EVM fingerprint ignores arguments but retains public call shape', () => {
    const a = observeEvmCall({
      chainId: 1,
      to: '0x111111125421ca6dc452d289314280a0f8842a65',
      data: `0x12aa3caf${'00'.repeat(64)}`,
    })
    const b = observeEvmCall({
      chainId: 1,
      to: '0x111111125421ca6dc452d289314280a0f8842a65',
      data: `0x12aa3caf${'ff'.repeat(64)}`,
    })
    expect(a.shapeKey).toBe(b.shapeKey)
    expect(a.shape).toEqual({
      chainId: 1,
      contract: '0x111111125421ca6dc452d289314280a0f8842a65',
      selector: '0x12aa3caf',
      calldataLength: 68,
    })
    expect(JSON.stringify(a)).not.toContain('ffff')
    expect(a.protectionLevel).toBe('P1')
  })

  test('certified EVM material remains P2 until device acceptance', () => {
    expect(observeEvmCall({ chainId: 1, source: 'certified' }).protectionLevel).toBe('P2')
    expect(observeEvmCall({ chainId: 1, hostDecoded: true }).protectionLevel).toBe('P2')
  })

  test('EIP-712 fingerprint retains schema and binding context but no domain name or message values', () => {
    const typedData = {
      domain: { name: 'Private App', chainId: 1, verifyingContract: '0x1111111111111111111111111111111111111111' },
      primaryType: 'Permit',
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }],
        Permit: [{ name: 'spender', type: 'address' }, { name: 'details', type: 'Details' }],
        Details: [{ name: 'amount', type: 'uint256' }],
      },
      message: { spender: '0x2222222222222222222222222222222222222222', details: { amount: '999999' } },
    }
    const observed = observeEvmTypedData({ typedData })
    expect(observed.requestKind).toBe('evm-typed-data')
    expect(observed.protectionLevel).toBe('P2')
    expect(observed.shape).toMatchObject({
      chainId: 1, verifyingContract: typedData.domain.verifyingContract, primaryType: 'Permit',
      types: { Permit: typedData.types.Permit, Details: typedData.types.Details },
    })
    const serialized = JSON.stringify(observed)
    expect(serialized).not.toContain('Private App')
    expect(serialized).not.toContain('22222222')
    expect(serialized).not.toContain('999999')
  })

  test('classifies potential loss without retaining amounts and prioritizes unbounded unknowns', () => {
    const base: any = { status: 'success', assetChanges: [], authorityChanges: [] }
    expect(classifyEffectExposure({ ...base, authorityChanges: [{ revoked: false, unlimited: true }] })).toBe('unlimited-authority')
    expect(classifyEffectExposure({ ...base, assetChanges: [{ delta: '-999999999' }] })).toBe('bounded-outflow')
    expect(classifyEffectExposure({ ...base, status: 'incomplete' })).toBe('unknown-effects')

    const frequent = observeEvmCall({ chainId: 1, to: '0x1111111111111111111111111111111111111111', exposureClass: 'bounded-outflow' })
    const unbounded = observeEvmCall({ chainId: 1, to: '0x2222222222222222222222222222222222222222', exposureClass: 'unknown-effects' })
    const rows: any[] = [
      ...Array.from({ length: 3 }, (_, index) => ({ ...frequent, id: `f${index}`, createdAt: index, source: 'rest-api', outcome: 'signed' })),
      { ...unbounded, id: 'u', createdAt: 4, source: 'rest-api', outcome: 'rejected' },
    ]
    const summary = summarizeClearSignObservations(rows, 4)
    expect(summary.topUnknown[0]).toMatchObject({ shapeKey: unbounded.shapeKey, maxExposureClass: 'unknown-effects', count: 1 })
    expect(JSON.stringify(summary.topUnknown)).not.toContain('999999999')
  })

  test('coverage denominator includes rejection and ranks repeated unknown shapes', () => {
    const draft = observeEvmCall({ chainId: 1, to: '0x111111125421ca6dc452d289314280a0f8842a65', data: '0x12345678' })
    const rows: any[] = [
      { ...draft, id: '1', createdAt: 1, source: 'rest-api', outcome: 'rejected', simulationStatus: 'unavailable' },
      { ...draft, id: '2', createdAt: 2, source: 'rest-api', outcome: 'signed', simulationStatus: 'success' },
      { ...draft, id: '3', createdAt: 3, source: 'rest-api', outcome: 'timed-out', protectionLevel: 'P4', definitionSource: 'erc7730' },
    ]
    const summary = summarizeClearSignObservations(rows, 3)
    expect(summary.totalRequests).toBe(3)
    expect(summary.authenticatedRequests).toBe(1)
    expect(summary.authenticatedPercent).toBe(33.33)
    expect(summary.byOutcome.rejected).toBe(1)
    expect(summary.byOutcome['timed-out']).toBe(1)
    expect(summary.topUnknown[0]?.count).toBe(2)
    expect(summary.topComponents[0]).toMatchObject({ chain: 'Ethereum', count: 3, component: draft.shape })
    expect(summary.byChain.Ethereum).toEqual({ totalRequests: 3, authenticatedRequests: 1, authenticatedPercent: 33.33 })
    expect(summary.byChain.Solana.totalRequests).toBe(0)
    expect(summary.bySource['rest-api'].authenticatedPercent).toBe(33.33)
    expect(summary.rolling.last24Hours.totalRequests).toBe(3)
    expect(summary.simulation).toEqual({ attemptedRequests: 2, successfulRequests: 1, successPercent: 50 })
    expect(summary.bySimulation['not-requested']).toBe(1)
    expect(summary.definitions).toEqual({ checkedRequests: 0, selectedRequests: 0, refusedRequests: 0, noArtifactRequests: 0 })
  })

  test('does not count one authenticated Solana schema as full transaction coverage', () => {
    const observation: any = {
      chain: 'Solana', requestKind: 'solana-transaction', shapeKey: 'solana:mixed',
      shape: { version: 'legacy', hasLookupTables: false, components: [
        { program: 'Target111', prefix1: '01', dataLength: 9 },
        { program: 'Companion222', prefix1: '02', dataLength: 12 },
      ] },
      protectionLevel: 'P4', definitionSource: 'certified', simulationStatus: 'success',
      definitionResolution: 'selected', exposureClass: 'bounded-outflow',
      componentCount: 2, authenticatedComponentCount: 1,
      id: 'mixed', createdAt: 1, source: 'rest-api', outcome: 'signed',
    }
    const summary = summarizeClearSignObservations([observation], 1)
    expect(summary.authenticatedRequests).toBe(1)
    expect(summary.componentCoverage).toEqual({
      totalAppearances: 2, authenticatedAppearances: 1, authenticatedPercent: 50,
      fullyAuthenticatedRequests: 0, partiallyAuthenticatedRequests: 1, unauthenticatedRequests: 0,
    })
  })

  test('deduplicates Solana audit demand by instruction rather than transaction composition', () => {
    const base: any = {
      chain: 'Solana', requestKind: 'solana-transaction', shapeKey: 'whole-a',
      protectionLevel: 'P1', definitionSource: 'none', simulationStatus: 'not-requested',
      definitionResolution: 'not-checked', exposureClass: 'not-evaluated',
    }
    const target = { program: 'Target111', prefix8: '0102030405060708', dataLength: 16, accountPrivileges: [] }
    const first = expandClearSignAuditDrafts({ ...base, shape: { components: [target] } })
    const second = expandClearSignAuditDrafts({ ...base, shapeKey: 'whole-b', shape: { components: [
      { program: 'ComputeBudget111', prefix1: '02', dataLength: 5, accountPrivileges: [] }, target,
    ] } })
    expect(first[0].shapeKey).toBe(second[1].shapeKey)
    expect(first[0].shape).toEqual({ components: [target] })
  })

  test('Solana shape excludes blockhash, signatures, and account addresses', () => {
    // One-signature legacy transaction with 2 static accounts and one 3-byte
    // instruction. Only structure and program id may survive the fingerprint.
    const signature = Buffer.alloc(64, 0xaa)
    const payer = Buffer.alloc(32, 0x11)
    const program = Buffer.alloc(32, 0x22)
    const blockhash = Buffer.alloc(32, 0x33)
    const message = Buffer.concat([
      Buffer.from([1, 0, 1, 2]), payer, program, blockhash,
      Buffer.from([1, 1, 1, 0, 3, 0x51, 0xaa, 0xbb]),
    ])
    const observed = observeSolanaTransaction({
      rawTxBase64: Buffer.concat([Buffer.from([1]), signature, message]).toString('base64'),
    })
    expect(observed.protectionLevel).toBe('P1')
    expect(observed.shape).toEqual({
      version: 'legacy',
      hasLookupTables: false,
      components: [{
        program: '3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3',
        prefix1: '51',
        prefix8: '51aabb',
        dataLength: 3,
        accountCount: 1,
        accountPrivileges: [{ index: 0, signer: true, writable: true, source: 'static' }],
      }],
    })
    const serialized = JSON.stringify(observed)
    expect(serialized).not.toContain('11111111')
    expect(serialized).not.toContain('33333333')
    expect(serialized).not.toContain('aaaaaaaa')
    const summary = summarizeClearSignObservations([{
      ...observed, id: 'sol', createdAt: 1, source: 'rest-api', outcome: 'signed',
    } as any], 1)
    expect(summary.topComponents).toHaveLength(1)
    expect(summary.topComponents[0].component).toEqual((observed.shape.components as any[])[0])
  })

  test('Solana privilege changes produce a distinct audit shape without retaining addresses', () => {
    const wrap = (readonlySigned: number) => {
      const message = Buffer.concat([
        Buffer.from([1, readonlySigned, 1, 2]), Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22), Buffer.alloc(32, 0x33),
        Buffer.from([1, 1, 1, 0, 1, 0x51]),
      ])
      return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')
    }
    const writable = observeSolanaTransaction({ rawTxBase64: wrap(0) })
    const readonly = observeSolanaTransaction({ rawTxBase64: wrap(1) })
    expect(writable.shapeKey).not.toBe(readonly.shapeKey)
    expect((writable.shape.components as any)[0].accountPrivileges[0]).toMatchObject({ signer: true, writable: true })
    expect((readonly.shape.components as any)[0].accountPrivileges[0]).toMatchObject({ signer: true, writable: false })
  })

  test('malformed Solana requests still count without retaining their bytes', () => {
    const raw = Buffer.from('private transaction bytes').toString('base64')
    const observed = observeMalformedSolanaTransaction(raw)
    expect(observed.protectionLevel).toBe('P0')
    expect(observed.shape).toEqual({ parseStatus: 'malformed', wireLength: 25 })
    expect(JSON.stringify(observed)).not.toContain(raw)
    expect(JSON.stringify(observed)).not.toContain('private')
  })
})
