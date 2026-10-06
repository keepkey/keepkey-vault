import { describe, expect, test } from 'bun:test'

import vendoredFlows from '../../keepkey-sdk/tests/fixtures/evm-clearsign-vendored.js'
import { universalRouterReportFindings } from '../src/bun/uniswap-universal-router'
import { decodeV4PositionManagerCall, v4PositionManagerReportFindings } from '../src/bun/uniswap-v4-position-manager'
import mainnetV4Fixture from './fixtures/uniswap-v4-position-mainnet.json'

describe('Uniswap host/device fixture agreement', () => {
  test('live ETH to USDC device metadata agrees with the fail-closed host decoder', () => {
    const flow: any = (vendoredFlows as any)['uniswap-live-eth-usdc-universal-router']
    const report = universalRouterReportFindings(`0x${flow.calldata}`, flow.chainId, `0x${flow.to}`)
    expect(report.findings[0].message).toContain('WRAP_ETH → V2_SWAP_EXACT_IN → SWEEP')
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_EXACT_INPUT_SWAP', message: expect.stringContaining('257170 base units'),
    }))
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_SWEEP', message: expect.stringContaining('257170 base units'),
    }))
    expect(flow.args.map((arg: any) => arg.name)).toEqual([
      'route', 'spend exactly', 'receive at least', 'path', 'recipient', 'payer', 'deadline',
    ])
  })

  test('successful mainnet v4 mint bytes and economic bounds agree across Vault and SDK', () => {
    const flow: any = (vendoredFlows as any)['uniswap-mainnet-v4-eth-ondo-position-mint']
    expect(`0x${flow.calldata}`).toBe(mainnetV4Fixture.input)
    expect(`0x${flow.to}`).toBe(mainnetV4Fixture.to)
    expect(flow.value).toBe(BigInt(mainnetV4Fixture.value).toString())
    const decoded = decodeV4PositionManagerCall(`0x${flow.calldata}`)!
    expect(decoded.actions?.map(action => action.name)).toEqual(['MINT_POSITION', 'SETTLE_PAIR', 'SWEEP'])
    expect(decoded.actions?.[0].decoded).toMatchObject({
      liquidity: '456338755511283842550',
      amount0Max: '262129949675060521',
      amount1Max: '1849420386542208203899',
      owner: mainnetV4Fixture.from,
    })
    const report = v4PositionManagerReportFindings(`0x${flow.calldata}`, 1, `0x${flow.to}`)
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_V4_POSITION_MINT_POSITION', message: expect.stringContaining('262129949675060521/1849420386542208203899'),
    }))
    expect(report.limitations).toContainEqual(expect.objectContaining({ code: 'UNISWAP_DEADLINE_EXPIRED' }))
    expect(flow.args.map((arg: any) => arg.name)).toEqual([
      'action', 'pool', 'tick range', 'liquidity', 'spend at most', 'spend at most', 'position owner', 'deadline',
    ])
  })
})
