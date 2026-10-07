import { afterEach, describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'
import bs58 from 'bs58'

import { evmTxFingerprint, normalizeEvmSimulation, simulateEvmEffects } from '../src/bun/evm-effects'
import { normalizeSolanaSimulation, simulateSolanaEffects } from '../src/bun/solana-effects'
import { buildClearSignReport, solanaDecodedReportFindings } from '../src/shared/clearsign-report'
import { ClearSignReportResponse } from '../src/bun/schemas'

const wallet = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('Vault ClearSign effect reports', () => {
  test('normalizes EVM transfers, approvals, and nested calls', () => {
    const transfer = '0x' + 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const approval = ethersUtils.id('Approval(address,address,uint256)')
    const report = normalizeEvmSimulation(
      { chainId: 1, from: wallet, to: other, input: '0x12345678' },
      'http://rpc', '0x10',
      { status: '0x1', logs: [
        { address: token, topics: [transfer, topicAddress(wallet), topicAddress(other)], data: '0x64' },
        { address: token, topics: [approval, topicAddress(wallet), topicAddress(other)], data: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
      ] },
      { type: 'CALL', to: other, calls: [{ type: 'DELEGATECALL', to: token }] },
    )
    expect(report.assetChanges[0]?.delta).toBe('-100')
    expect(report.invokedCode).toContainEqual({ address: token, invocation: 'delegatecall' })
    expect(report.authorityChanges).toHaveLength(1)
    expect(report.authorityChanges[0]?.unlimited).toBe(true)
  })

  test('normalizes Solana SOL/token deltas and identifies CPI programs', () => {
    const signature = Buffer.alloc(64)
    const ownerBytes = Buffer.alloc(32, 0x11)
    const programBytes = Buffer.alloc(32, 0x22)
    const message = Buffer.concat([
      Buffer.from([1, 0, 1, 2]), ownerBytes, programBytes, Buffer.alloc(32, 0x33),
      Buffer.from([1, 1, 1, 0, 1, 0x51]),
    ])
    const rawTx = Buffer.concat([Buffer.from([1]), signature, message]).toString('base64')
    const owner = bs58.encode(ownerBytes)
    const report = normalizeSolanaSimulation(rawTx, owner, 'http://rpc', 99, {
      err: null,
      fee: 5000,
      preBalances: [1_000_000, 1],
      postBalances: [895_000, 1],
      preTokenBalances: [{ accountIndex: 0, mint: 'Mint1', owner, uiTokenAmount: { amount: '1000', decimals: 2 } }],
      postTokenBalances: [{ accountIndex: 0, mint: 'Mint1', owner, uiTokenAmount: { amount: '250', decimals: 2 } }],
      innerInstructions: [{ index: 0, instructions: [] }],
      logs: ['Program 4Nd1mY1nCpi111111111111111111111111111111 invoke [2]'],
    })
    expect(report.assetChanges.map((change) => change.delta)).toEqual(['-105000', '-750'])
    expect(report.fee?.amount).toBe('5000')
    expect(report.invokedCode.some((entry) => entry.invocation === 'cpi')).toBe(true)
    expect(report.status).toBe('incomplete')
    expect(report.unknowns.map(finding => finding.code)).toContain('PROGRAM_STATE_CHANGES_UNINTERPRETED')
  })

  test('decodes successfully executed SPL delegate changes without claiming arbitrary program semantics', () => {
    const signature = Buffer.alloc(64)
    const ownerBytes = Buffer.alloc(32, 0x11)
    const sourceBytes = Buffer.alloc(32, 0x22)
    const tokenProgram = Buffer.from(bs58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'))
    const delegateBytes = Buffer.alloc(32, 0x44)
    const approveData = Buffer.alloc(9)
    approveData[0] = 4
    approveData.writeBigUInt64LE(100n, 1)
    const message = Buffer.concat([
      Buffer.from([1, 0, 2, 4]), ownerBytes, sourceBytes, tokenProgram, delegateBytes, Buffer.alloc(32, 0x33),
      Buffer.from([1, 2, 3, 1, 3, 0, approveData.length]), approveData,
    ])
    const rawTx = Buffer.concat([Buffer.from([1]), signature, message]).toString('base64')
    const owner = bs58.encode(ownerBytes)
    const report = normalizeSolanaSimulation(rawTx, owner, 'http://rpc', 100, {
      err: null, preBalances: [1000, 1, 1, 1], postBalances: [1000, 1, 1, 1],
      preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logs: [],
    })
    expect(report.authorityChanges).toEqual([{
      kind: 'delegate', assetOrAccount: bs58.encode(sourceBytes), authority: bs58.encode(delegateBytes),
      value: '100', unlimited: false, revoked: false, confidence: 'inferred',
    }])
    expect(report.completeness.authorityCoverage).toBe('complete')
    expect(report.status).toBe('success')
  })

  test('reports missing simulation evidence as incomplete, never safe', () => {
    const signature = Buffer.alloc(64)
    const ownerBytes = Buffer.alloc(32, 0x11)
    const programBytes = Buffer.alloc(32, 0x22)
    const message = Buffer.concat([
      Buffer.from([1, 0, 1, 2]), ownerBytes, programBytes, Buffer.alloc(32),
      Buffer.from([1, 1, 0, 1, 0x51]),
    ])
    const rawTx = Buffer.concat([Buffer.from([1]), signature, message]).toString('base64')
    const report = normalizeSolanaSimulation(rawTx, 'missing-owner', 'http://rpc', undefined, { err: null })
    expect(report.status).toBe('incomplete')
    expect(report.unknowns.map((finding) => finding.code)).toContain('SOL_BALANCE_UNAVAILABLE')
    expect(report.unknowns.map((finding) => finding.code)).toContain('TOKEN_BALANCES_UNAVAILABLE')
  })

  test('ClearSign Report cannot claim authenticated coverage from simulation alone', () => {
    const simulation = normalizeEvmSimulation(
      { chainId: 1, from: wallet, to: other, input: '0x12345678' },
      'http://rpc', '0x10', { status: '0x1', logs: [] },
      { type: 'CALL', to: other },
    )
    const report = buildClearSignReport({
      requestedLevel: 'P5',
      descriptor: { source: 'none', authenticated: false },
      simulation,
      now: 100,
    })
    expect(report.protectionLevel).toBe('P3')
    expect(report.headline).toContain('not authenticated')
  })

  test('ClearSign Report separates authenticated description from incomplete effects', () => {
    const simulation = normalizeEvmSimulation(
      { chainId: 1, from: wallet, to: other, input: '0x12345678' },
      'http://rpc', '0x10', { status: '0x1' }, undefined,
    )
    const report = buildClearSignReport({
      requestedLevel: 'P5',
      descriptor: { source: 'erc7730', authenticated: true, format: 'ERC7730', codeIdentityBound: true },
      simulation,
      now: 100,
    })
    expect(report.protectionLevel).toBe('P5')
    expect(report.limitations.map((finding) => finding.code)).toContain('DESCRIPTION_WITHOUT_COMPLETE_SIMULATION')
    expect(report.claims.map((claim) => claim.source)).toContain('authenticated-definition')
  })

  test('firmware-native parsing is presented as KeepKey ClearSign ready', () => {
    const simulation = normalizeEvmSimulation(
      { chainId: 42161, from: wallet, to: other, input: '0x095ea7b3' },
      'http://rpc', '0x10', { status: '0x1' }, undefined,
    )
    const report = buildClearSignReport({
      requestedLevel: 'P4',
      descriptor: { source: 'native', authenticated: true, format: 'FIRMWARE_NATIVE', label: 'ERC-20 approve' },
      simulation,
      now: 100,
    })
    expect(report.protectionLevel).toBe('P4')
    expect(report.headline).toBe('KeepKey ClearSign ready')
    expect(report.claims).toContainEqual(expect.objectContaining({
      source: 'authenticated-definition',
      statement: expect.stringContaining('firmware will independently decode'),
    }))
  })

  test('POST /clearsign/report response schema accepts the reports the route builds', () => {
    const simulation = normalizeEvmSimulation(
      { chainId: 1, from: wallet, to: other, input: '0x12345678' },
      'http://rpc', '0x10', { status: '0x1', logs: [] }, { type: 'CALL', to: other },
    )
    const report = buildClearSignReport({
      requestedLevel: 'P3',
      descriptor: { source: 'none', authenticated: false, resolution: 'no-artifact' },
      simulation,
    })
    const parsed = ClearSignReportResponse.safeParse(report)
    expect(parsed.success).toBe(true)
    expect(ClearSignReportResponse.safeParse({ ...report, protectionLevel: 'P9' }).success).toBe(false)
  })

  test('ClearSign Report exposes a fail-closed definition refusal', () => {
    const simulation = normalizeEvmSimulation(
      { chainId: 1, from: wallet, to: other, input: '0x12345678' },
      'http://rpc', '0x10', { status: '0x1', logs: [] }, undefined,
    )
    const report = buildClearSignReport({
      requestedLevel: 'P3',
      descriptor: { source: 'none', authenticated: false, resolution: 'identity-changed' },
      simulation,
    })
    expect(report.protectionLevel).toBe('P3')
    expect(report.limitations).toContainEqual(expect.objectContaining({ code: 'CLEARSIGN_DEFINITION_REFUSED', severity: 'danger' }))
  })

  test('unifies session-key and unknown-program decoder risks into the ClearSign Report', () => {
    const decodedFindings = solanaDecodedReportFindings({
      version: 'legacy', staticAccountCount: 4, altPubkeys: [],
      instructions: [{
        status: 'unknown-program', programId: 'Game111', programName: 'Unknown program', args: [], accounts: [],
      }],
      hasUnknownProgram: true, assetPrograms: ['System Program'],
      fundedKeysGivenToUnknownProgram: ['Session111'], altResolutionIncomplete: true,
    })
    expect(decodedFindings.findings.map(finding => finding.code)).toEqual([
      'SESSION_KEY_FUNDED_AND_REGISTERED', 'UNKNOWN_PROGRAM_WITH_ASSET_PROGRAM_ACCESS',
    ])
    expect(decodedFindings.limitations.map(finding => finding.code)).toContain('SOLANA_ALT_RESOLUTION_INCOMPLETE')
    expect(decodedFindings.limitations.map(finding => finding.code)).toContain('UNKNOWN_SOLANA_PROGRAM')
  })

  test('EVM adapter requests execution plus trace and returns one report', async () => {
    const methods: string[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      methods.push(request.method)
      const result = request.method === 'eth_blockNumber' ? '0x20' : request.method === 'eth_simulateV1'
        ? [{ number: '0x20', calls: [{ status: '0x1', logs: [] }] }]
        : request.method === 'eth_getCode' ? '0x6000'
        : { type: 'CALL', to: other }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    }) as any
    const report = await simulateEvmEffects({ chainId: 1, from: wallet, to: other }, 'http://rpc')
    expect(methods).toEqual(['eth_blockNumber', 'eth_simulateV1', 'debug_traceCall', 'eth_getCode'])
    expect(report.status).toBe('success')
    expect(report.stateReference.blockOrSlot).toBe('0x20')
    expect(report.invokedCode[0]?.codeHash).toBe(ethersUtils.keccak256('0x6000'))
  })

  test('EVM adapter falls back to a pinned call trace and captures nested native value', async () => {
    const methods: string[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      methods.push(request.method)
      if (request.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x99' }))
      if (request.method === 'eth_simulateV1') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }))
      if (request.method === 'debug_traceCall') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        type: 'CALL', from: wallet, to: other, value: '0x10',
        calls: [{ type: 'CALL', from: other, to: wallet, value: '0x4' }],
      } }))
      if (request.method === 'eth_getCode') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: request.params[0] === wallet ? '0x' : '0x6000' }))
      throw new Error(`unexpected ${request.method}`)
    }) as any
    const report = await simulateEvmEffects({ chainId: 1, from: wallet, to: other, value: '0x10' }, 'http://rpc')
    expect(methods).toEqual(['eth_blockNumber', 'eth_simulateV1', 'debug_traceCall', 'eth_getCode', 'eth_getCode'])
    expect(report.assetChanges).toContainEqual(expect.objectContaining({ asset: { kind: 'native', id: 'eip155:native' }, delta: '-12' }))
    expect(report.invokedCode).toContainEqual({ address: other, invocation: 'top-level', codeHash: ethersUtils.keccak256('0x6000') })
    expect(report.status).toBe('incomplete')
    expect(report.stateReference.blockOrSlot).toBe('0x99')
  })

  test('Solana adapter requests inner execution and returns one report', async () => {
    const signature = Buffer.alloc(64)
    const ownerBytes = Buffer.alloc(32, 0x11)
    const programBytes = Buffer.alloc(32, 0x22)
    const message = Buffer.concat([
      Buffer.from([1, 0, 1, 2]), ownerBytes, programBytes, Buffer.alloc(32),
      Buffer.from([1, 1, 0, 1, 0x51]),
    ])
    const rawTx = Buffer.concat([Buffer.from([1]), signature, message]).toString('base64')
    let config: any
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body))
      config = request.params[1]
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        context: { slot: 42 },
        value: { err: null, preBalances: [100, 0], postBalances: [90, 0], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
      } }))
    }) as any
    const report = await simulateSolanaEffects(rawTx, bs58.encode(ownerBytes), 'http://rpc')
    expect(config).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true })
    expect(report.assetChanges[0]?.delta).toBe('-10')
    expect(report.stateReference.blockOrSlot).toBe('42')
  })
})

describe('evmTxFingerprint', () => {
  // Real Base Uniswap swap from 2026-10-04: the pre-sign report got Uniswap's
  // lowercase `from`, the signing path the extension's checksummed one, and the
  // raw-string hash rejected an identical transaction.
  const base = {
    chainId: 8453,
    from: '0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e',
    to: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40',
    data: '0x3593564c',
    value: '0x0',
    gas: '0x3ad76',
    maxFeePerGas: '0xbebc21',
    maxPriorityFeePerGas: '0x4c4b41',
    nonce: '0x23',
  }

  test('same transaction, different spelling: same fingerprint', () => {
    const fp = evmTxFingerprint(base)
    expect(evmTxFingerprint({ ...base, from: '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E' })).toBe(fp)
    expect(evmTxFingerprint({ ...base, to: base.to.toUpperCase().replace('0X', '0x'), data: '0x3593564C' })).toBe(fp)
    expect(evmTxFingerprint({ ...base, chainId: '0x2105' as any, value: '0x00', nonce: '35', gasPrice: undefined })).toBe(fp)
    expect(evmTxFingerprint({ ...base, data: undefined, input: '0x3593564c' })).toBe(fp)
  })

  test('any real change: different fingerprint', () => {
    const fp = evmTxFingerprint(base)
    for (const change of [
      { maxFeePerGas: '0xbebc22' }, { gas: '0x30396' }, { nonce: '0x24' }, { value: '0x1' },
      { data: '0x3593564d' }, { to: '0x0000000000000000000000000000000000000001' }, { chainId: 1 },
      { gasPrice: '0x895440', maxFeePerGas: undefined, maxPriorityFeePerGas: undefined },
    ]) expect(evmTxFingerprint({ ...base, ...change } as any)).not.toBe(fp)
  })
})
