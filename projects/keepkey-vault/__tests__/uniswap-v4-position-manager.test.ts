import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import { decodeV4PositionManagerCall, v4PositionManagerReportFindings } from '../src/bun/uniswap-v4-position-manager'
import { uniswapReportFindingsWithState } from '../src/bun/uniswap-report'
import mainnetFixture from './fixtures/uniswap-v4-position-mainnet.json'

const abi = ethersUtils.defaultAbiCoder
const poolKeyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const iface = new ethersUtils.Interface([
  'function modifyLiquidities(bytes unlockData,uint256 deadline)',
  'function multicall(bytes[] data)',
  'function permitForAll(address owner,address operator,bool approved,uint256 deadline,uint256 nonce,bytes signature)',
])
const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const owner = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
const mainnetPositionManager = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'

describe('Uniswap v4 PositionManager ClearSign decoder', () => {
  test('decodes a successful mainnet mint byte-for-byte', () => {
    const decoded = decodeV4PositionManagerCall(mainnetFixture.input)!
    expect(decoded.complete).toBe(true)
    expect(decoded.decoded.deadline).toBe('1788826550')
    expect(decoded.actions?.map(action => action.name)).toEqual(['MINT_POSITION', 'SETTLE_PAIR', 'SWEEP'])
    expect(decoded.actions?.[0].decoded).toMatchObject({
      poolKey: {
        currency0: '0x0000000000000000000000000000000000000000',
        currency1: '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3', fee: '3000', tickSpacing: '60',
      },
      tickLower: '86760', tickUpper: '88740', liquidity: '456338755511283842550',
      amount0Max: '262129949675060521', amount1Max: '1849420386542208203899',
      owner: mainnetFixture.from,
    })
    const report = v4PositionManagerReportFindings(mainnetFixture.input, 1, mainnetFixture.to)
    expect(report.complete).toBe(false)
    expect(report.limitations).toContainEqual(expect.objectContaining({ code: 'UNISWAP_DEADLINE_EXPIRED' }))
    expect(report.findings.find(item => item.code === 'UNISWAP_V4_POSITION_SETTLE_PAIR')?.message)
      .toContain('native currency')
    expect(report.findings.find(item => item.code === 'UNISWAP_V4_POSITION_SWEEP')?.message)
      .toContain('transaction sender (0x…01 sentinel)')
  })

  test('decodes direct mint, decrease and settlement bounds', () => {
    const mint = abi.encode([
      poolKeyType, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes',
    ], [[weth, usdc, 500, 10, '0x0000000000000000000000000000000000000000'], -120, 120, 5000, 1000, 2000, owner, '0x'])
    const decrease = abi.encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [42, 100, 10, 20, '0x'])
    const settlePair = abi.encode(['address', 'address'], [weth, usdc])
    const unlockData = abi.encode(['bytes', 'bytes[]'], ['0x02010d', [mint, decrease, settlePair]])
    const data = iface.encodeFunctionData('modifyLiquidities', [unlockData, 1_900_000_000])
    const decoded = decodeV4PositionManagerCall(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.actions?.map(action => action.name)).toEqual(['MINT_POSITION', 'DECREASE_LIQUIDITY', 'SETTLE_PAIR'])
    expect(decoded.actions?.[0].decoded).toMatchObject({
      poolKey: { currency0: weth.toLowerCase(), currency1: usdc.toLowerCase(), fee: '500', tickSpacing: '10' },
      tickLower: '-120', tickUpper: '120', liquidity: '5000', amount0Max: '1000', amount1Max: '2000',
      owner: owner.toLowerCase(),
    })
    expect(decoded.actions?.[1].decoded).toMatchObject({ tokenId: '42', liquidity: '100', amount0Min: '10', amount1Min: '20' })
    const report = v4PositionManagerReportFindings(data, 1, mainnetPositionManager)
    expect(report.complete).toBe(true)
    expect(report.limitations).toEqual([])
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_V4_POSITION_MINT_POSITION' }))
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_V4_POSITION_DECREASE_LIQUIDITY' }))
  })

  test('recursively decodes permits without retaining signature bytes', () => {
    const permit = iface.encodeFunctionData('permitForAll', [owner, weth, true, 1_900_000_000, 9, `0x${'ab'.repeat(65)}`])
    const data = iface.encodeFunctionData('multicall', [[permit]])
    const decoded = decodeV4PositionManagerCall(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.children?.[0].decoded).toMatchObject({
      owner: owner.toLowerCase(), operator: weth.toLowerCase(), approved: true, nonce: '9', signatureBytes: 65,
    })
    expect(JSON.stringify(decoded)).not.toContain('abababababababab')
  })

  test('fails closed for unknown actions, unknown targets, and permissioned state', () => {
    const unlockData = abi.encode(['bytes', 'bytes[]'], ['0x0a', ['0x']])
    const data = iface.encodeFunctionData('modifyLiquidities', [unlockData, 5])
    expect(v4PositionManagerReportFindings(data, 1, mainnetPositionManager)).toMatchObject({ complete: false })
    expect(v4PositionManagerReportFindings(data, 1, mainnetPositionManager).limitations)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_V4_POSITION_ACTION_NOT_DECODED' }))

    const valid = iface.encodeFunctionData('permitForAll', [owner, weth, false, 1_900_000_000, 1, '0x'])
    expect(v4PositionManagerReportFindings(valid, 1, owner).limitations)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_POSITION_MANAGER_IDENTITY_UNVERIFIED' }))
    expect(v4PositionManagerReportFindings(data, 1, '0xd7be746b6b29f6185a01013e944313e1704c971f').limitations)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_PERMISSIONED_POSITION_STATE_UNRESOLVED' }))
    expect(v4PositionManagerReportFindings(valid, 1, '0xd7be746b6b29f6185a01013e944313e1704c971f').complete)
      .toBe(true)
  })

  test('decodes permissioned ERC-6909 claim actions and rejects them on the standard manager', () => {
    const mintClaim = abi.encode(['address'], [weth])
    const burnClaim = abi.encode(['address', 'address', 'uint256'], [weth, owner, 100])
    const unwind = abi.encode(['address', 'address', 'uint256'], [weth, owner, 90])
    const data = iface.encodeFunctionData('modifyLiquidities', [
      abi.encode(['bytes', 'bytes[]'], ['0x171819', [mintClaim, burnClaim, unwind]]), 1_900_000_000,
    ])
    const decoded = decodeV4PositionManagerCall(data)!
    expect(decoded.actions?.map(action => action.name)).toEqual(['MINT_6909', 'BURN_6909', 'UNWIND_WITH_FALLBACK'])
    expect(decoded.actions?.[1].decoded).toMatchObject({ currency: weth.toLowerCase(), owner: owner.toLowerCase(), amount: '100' })
    const standard = v4PositionManagerReportFindings(data, 1, mainnetPositionManager)
    expect(standard.complete).toBe(false)
    expect(standard.limitations).toContainEqual(expect.objectContaining({ code: 'UNISWAP_PERMISSIONED_POSITION_ACTION_ON_STANDARD_MANAGER' }))
    const permissioned = v4PositionManagerReportFindings(data, 1, '0xd7be746b6b29f6185a01013e944313e1704c971f')
    expect(permissioned.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_V4_POSITION_UNWIND_WITH_FALLBACK' }))
    expect(permissioned.limitations).toContainEqual(expect.objectContaining({ code: 'UNISWAP_PERMISSIONED_POSITION_STATE_UNRESOLVED' }))
  })

  test('authenticates every canonical standard PositionManager deployment', () => {
    const valid = iface.encodeFunctionData('permitForAll', [owner, weth, false, 1_900_000_000, 1, '0x'])
    const deployments: Array<[number, string]> = [
      [1, mainnetPositionManager], [10, '0x3c3ea4b57a46241e54610e5f022e5c45859a1017'],
      [130, '0x4529a01c7a0410167c5740c487a8de60232617bf'], [137, '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9'],
      [143, '0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016'], [196, '0xcf1eafc6928dc385a342e7c6491d371d2871458b'],
      [480, '0xc585e0f504613b5fbf874f21af14c65260fb41fa'], [4217, '0x3fc79444f8eacc1894775493ff3fa41f1e35ce11'],
      [4326, '0x9ae0921e981aaa7308f176f8d4f9129b9247c89d'], [4663, '0x58daec3116aae6d93017baaea7749052e8a04fa7'],
      [5042, '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b'], [8453, '0x7c5f5a4bbd8fd63184577525326123b519429bdc'],
      [42161, '0xd88f38f930b7952f2db2432cb002e7abbf3dd869'], [42220, '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9'],
      [56, '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b'], [57073, '0x1b35d13a2e2528f192637f14b05f0dc0e7deb566'],
      [59144, '0xddcad5775b2816a87495f207731b3571d7ee3c76'], [7777777, '0xf66c7b99e2040f0d9b326b3b7c152e9663543d63'],
      [81457, '0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad'], [1868, '0x1b35d13a2e2528f192637f14b05f0dc0e7deb566'],
      [11155111, '0x429ba70129df741b2ca2a85bc3a2a3328e5c09b4'], [1301, '0x12a98709bb5d0641d61458f85dcafbe17ac2d05c'],
    ]
    for (const [chainId, target] of deployments) expect(v4PositionManagerReportFindings(valid, chainId, target).complete).toBe(true)
  })

  test('promotes a permissioned mint only after block-pinned adapter and liquidity checks', async () => {
    const permissionedManager = '0xd7be746b6b29f6185a01013e944313e1704c971f'
    const factory = '0x2222222222222222222222222222222222222222'
    const underlying = '0x3333333333333333333333333333333333333333'
    const managerState = new ethersUtils.Interface(['function PERMISSIONS_ADAPTER_FACTORY() view returns (address)'])
    const factoryState = new ethersUtils.Interface([
      'function verifiedPermissionsAdapterOf(address) view returns (address)',
      'function permissionsAdapterOf(address) view returns (address)',
    ])
    const adapterState = new ethersUtils.Interface([
      'function isAllowed(address,bytes2) view returns (bool)', 'function allowedHooks(address) view returns (bool)',
    ])
    const mint = abi.encode([
      poolKeyType, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes',
    ], [[weth, usdc, 500, 10, owner], -120, 120, 5000, 1000, 2000, owner, '0x'])
    const data = iface.encodeFunctionData('modifyLiquidities', [abi.encode(['bytes', 'bytes[]'], ['0x02', [mint]]), 1_900_000_000])
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      const request = JSON.parse(init.body)
      if (request.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x456' }))
      if (request.method === 'eth_getCode') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x6000' }))
      const [{ to, data: callData }] = request.params
      let result: string
      if (callData.startsWith(managerState.getSighash('PERMISSIONS_ADAPTER_FACTORY'))) {
        result = managerState.encodeFunctionResult('PERMISSIONS_ADAPTER_FACTORY', [factory])
      } else if (callData.startsWith(factoryState.getSighash('verifiedPermissionsAdapterOf'))) {
        const [currency] = factoryState.decodeFunctionData('verifiedPermissionsAdapterOf', callData)
        result = factoryState.encodeFunctionResult('verifiedPermissionsAdapterOf', [String(currency).toLowerCase() === weth.toLowerCase() ? underlying : '0x0000000000000000000000000000000000000000'])
      } else if (callData.startsWith(factoryState.getSighash('permissionsAdapterOf'))) {
        result = factoryState.encodeFunctionResult('permissionsAdapterOf', ['0x0000000000000000000000000000000000000000'])
      } else if (to.toLowerCase() === weth.toLowerCase() && callData.startsWith(adapterState.getSighash('isAllowed'))) {
        const [, flag] = adapterState.decodeFunctionData('isAllowed', callData)
        expect(flag).toBe('0x0002')
        result = adapterState.encodeFunctionResult('isAllowed', [true])
      } else if (to.toLowerCase() === weth.toLowerCase() && callData.startsWith(adapterState.getSighash('allowedHooks'))) {
        result = adapterState.encodeFunctionResult('allowedHooks', [true])
      } else throw new Error(`unexpected state call ${to} ${callData.slice(0, 10)}`)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    }) as typeof fetch
    try {
      const report = await uniswapReportFindingsWithState(data, 1, permissionedManager, owner, 'https://rpc.invalid')
      expect(report.complete).toBe(true)
      expect(report.limitations).toEqual([])
      expect(report.findings).toContainEqual(expect.objectContaining({
        code: 'UNISWAP_PERMISSIONED_POSITION_CURRENCY_RESOLVED',
        message: expect.stringContaining(`resolves to underlying token ${underlying}`),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
