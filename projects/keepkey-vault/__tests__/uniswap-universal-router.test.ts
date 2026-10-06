import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import { decodeUniversalRouter, universalRouterReportFindings } from '../src/bun/uniswap-universal-router'
import { uniswapReportFindingsWithState } from '../src/bun/uniswap-report'
import regressionFixtures from '../../keepkey-sdk/tests/fixtures/evm-tx-1559-regression.json'

const router = new ethersUtils.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
  'function executeSigned(bytes commands, bytes[] inputs, bytes32 intent, bytes32 data, bool verifySender, bytes32 nonce, bytes signature, uint256 deadline)',
])
const abi = ethersUtils.defaultAbiCoder
const recipient = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

describe('Uniswap Universal Router ClearSign decoder', () => {
  test('decodes the live ETH to USDC command family', () => {
    const data = router.encodeFunctionData('execute', [
      '0x0b0804',
      [
        abi.encode(['address', 'uint256'], ['0x0000000000000000000000000000000000000002', 100_000_000_000_000n]),
        abi.encode(['address', 'uint256', 'uint256', 'address[]', 'bool', 'uint256[]'], [
          '0x0000000000000000000000000000000000000001', 100_000_000_000_000n, 257_170n, [weth, usdc], false, [],
        ]),
        abi.encode(['address', 'address', 'uint256'], [usdc, recipient, 257_170n]),
      ],
      1_800_000_000,
    ])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.deadline).toBe('1800000000')
    expect(decoded.commands.map(command => command.name)).toEqual(['WRAP_ETH', 'V2_SWAP_EXACT_IN', 'SWEEP'])
    expect(decoded.commands[1].decoded).toMatchObject({
      amountIn: '100000000000000', amountOutMin: '257170', path: [weth.toLowerCase(), usdc.toLowerCase()],
      layout: 'v2.1.2', minHopPriceX36: [],
    })
    expect(decoded.commands[2].decoded).toMatchObject({ token: usdc.toLowerCase(), recipient: recipient.toLowerCase() })
    const report = universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
    expect(report.findings[0].message).toContain('WRAP_ETH → V2_SWAP_EXACT_IN → SWEEP')
    expect(report.limitations).toEqual([])
  })

  test('does not attribute router-format calldata to Uniswap at an unknown target', () => {
    const data = router.encodeFunctionData('execute', ['0x0b', [
      abi.encode(['address', 'uint256'], [recipient, 1]),
    ], 2])
    const report = universalRouterReportFindings(data, 1, '0x1111111111111111111111111111111111111111')
    expect(report.complete).toBe(false)
    expect(report.findings[0].message).toContain('Universal Router-format')
    expect(report.limitations).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_ROUTER_IDENTITY_UNVERIFIED', severity: 'danger',
    }))
  })

  test('decodes core swaps on the official v1 router with its 0x3f command mask', () => {
    const data = router.encodeFunctionData('execute', ['0x0b', [
      abi.encode(['address', 'uint256'], [recipient, 1]),
    ], 2])
    const report = universalRouterReportFindings(data, 1, '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b')
    expect(report.complete).toBe(true)
    expect(report.limitations).toEqual([])
    expect(report.findings[0].message).toContain('V1')

    const reservedBit = router.encodeFunctionData('execute', ['0x4b', [
      abi.encode(['address', 'uint256'], [recipient, 1]),
    ], 2])
    expect(universalRouterReportFindings(reservedBit, 1, '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b').complete).toBe(true)
  })

  test('names but fails closed on an unimplemented v1 NFT marketplace command', () => {
    const data = router.encodeFunctionData('execute', ['0x10', ['0x'], 2])
    const report = universalRouterReportFindings(data, 1, '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b')
    expect(report.complete).toBe(false)
    expect(report.findings[0].message).toContain('SEAPORT_V1_5')
    expect(report.limitations).toContainEqual(expect.objectContaining({ code: 'UNISWAP_COMMAND_NOT_DECODED' }))
  })

  test('refuses the historical LINK to USDT fixture trailing bytes while decoding its canonical ABI prefix', () => {
    const fixture = regressionFixtures['uniswap-link-to-usdt-1'].input
    // The stored fixture ends in ten bytes ("unix\\0\\0\\0\\0\\0\\x0c")
    // after the canonical execute ABI. Solidity would ignore them, but the
    // wallet signs them, so ClearSign must not silently omit them.
    expect(Buffer.from(fixture.data.slice(-20), 'hex').toString()).toBe('unix\0\0\0\0\0\f')
    expect(decodeUniversalRouter(fixture.data)).toBeUndefined()
    const decoded = decodeUniversalRouter(fixture.data.slice(0, -20))!
    expect(decoded.complete).toBe(true)
    expect(decoded.commands.map(command => command.name)).toEqual([
      'PERMIT2_PERMIT', 'V2_SWAP_EXACT_IN', 'V3_SWAP_EXACT_IN', 'UNWRAP_WETH',
    ])
    expect(decoded.commands[1].decoded).toMatchObject({ amountOutMin: '0', payerIsUser: true })
    expect(decoded.commands[2].decoded).toMatchObject({ amountOutMin: '0', payerIsUser: false })
    expect(decoded.commands[3].decoded).toMatchObject({
      recipient: fixture.from.toLowerCase(), amountMin: '1962416372287484',
    })
    expect(universalRouterReportFindings(fixture.data, fixture.chainId, fixture.to).complete).toBe(false)
    const report = universalRouterReportFindings(fixture.data.slice(0, -20), fixture.chainId, fixture.to)
    expect(report.complete).toBe(true)
    expect(report.limitations).toEqual([])
    expect(report.findings.find(item => item.code === 'UNISWAP_UNWRAP_WETH')?.message)
      .toContain('1962416372287484')
    expect(report.findings.filter(item => item.code === 'UNISWAP_EXACT_INPUT_SWAP')[1].message)
      .toContain("router's entire current token balance (CONTRACT_BALANCE sentinel)")
    expect(report.findings.filter(item => item.code === 'UNISWAP_EXACT_INPUT_SWAP')[1].message)
      .not.toContain('57896044618658097711785492504343953926634992332820282019728792003956564819968')
  })

  test('recognizes current official routers on every built-in Uniswap chain', () => {
    const data = router.encodeFunctionData('execute', ['0x0b', [
      abi.encode(['address', 'uint256'], [recipient, 1]),
    ], 2])
    const deployments: Array<[number, string]> = [
      [1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85'],
      [10, '0xc09255d86db563cbc11c2fcf4a0c512e160111b4'],
      [56, '0xdc264714f68d84cf29bc605589405e78bdbe7c9f'],
      [130, '0xd1b797d92d87b688193a2b976efc8d577d204343'],
      [137, '0xdc264714f68d84cf29bc605589405e78bdbe7c9f'],
      [143, '0xa6ce4f10d83dbddac17e68e1837ca9ce6a1b596e'],
      [196, '0x1cd182c94fcf42277b80dbb9060f88024809e61e'],
      [480, '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f'],
      [999, '0xed270a1bcdc63cf1356d695e7f40961d4819d6bf'],
      [1868, '0x661e93cca42afacb172121ef892830ca3b70f08d'],
      [4217, '0x182a927119d56008d921126764bf884221b10f59'],
      [4326, '0xaedd1cf4c14e833140a61e9c0d2b73a64795c823'],
      [4663, '0x204faca1764b154221e35c0d20abb3c525710498'],
      [5042, '0x8702463e73f74d0b6765abceb314ef07acb92650'],
      [8453, '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'],
      [42161, '0x2d01411773c8c24805306e89a41f7855c3c4fe65'],
      [42220, '0xe2023f3fa515cf070e07fd9d51c1d236e07843f4'],
      [43114, '0x661e93cca42afacb172121ef892830ca3b70f08d'],
      [57073, '0x661e93cca42afacb172121ef892830ca3b70f08d'],
      [59144, '0xdc264714f68d84cf29bc605589405e78bdbe7c9f'],
      [81457, '0x661e93cca42afacb172121ef892830ca3b70f08d'],
      [7777777, '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f'],
    ]
    for (const [chainId, target] of deployments) {
      const report = universalRouterReportFindings(data, chainId, target)
      expect(report.complete).toBe(true)
      expect(report.limitations).toEqual([])
      expect(report.findings[0].message).toContain('V2.1.2')
    }
  })

  test('authenticates 2.2 but refuses complete v4 coverage until adapter state is resolved', () => {
    const v4Plan = abi.encode(['bytes', 'bytes[]'], ['0x0c0f', [
      abi.encode(['address', 'uint256'], [weth, 100_000n]),
      abi.encode(['address', 'uint256'], [usdc, 250_000n]),
    ]])
    const data = router.encodeFunctionData('execute', ['0x10', [v4Plan], 5])
    const report = universalRouterReportFindings(data, 1, '0xab863e752bf67d8dcdd929eaae9be9dc83fb3bbb')
    expect(report.findings[0].message).toContain('V2.2.0 Permissioned Pools')
    expect(report.complete).toBe(false)
    expect(report.limitations).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_PERMISSIONED_CURRENCY_UNRESOLVED', severity: 'danger',
    }))

    const wrapOnly = router.encodeFunctionData('execute', ['0x0b', [
      abi.encode(['address', 'uint256'], [recipient, 1]),
    ], 5])
    expect(universalRouterReportFindings(wrapOnly, 1, '0xab863e752bf67d8dcdd929eaae9be9dc83fb3bbb').complete).toBe(true)
  })

  test('promotes a 2.2 v4 report only after block-pinned adapter state resolves', async () => {
    const factory = '0x2222222222222222222222222222222222222222'
    const underlying = '0x3333333333333333333333333333333333333333'
    const routerState = new ethersUtils.Interface(['function PERMISSIONS_ADAPTER_FACTORY() view returns (address)'])
    const factoryState = new ethersUtils.Interface(['function verifiedPermissionsAdapterOf(address) view returns (address)'])
    const adapterState = new ethersUtils.Interface([
      'function swappingEnabled() view returns (bool)', 'function isAllowed(address,bytes2) view returns (bool)',
    ])
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: any, init: any) => {
      const request = JSON.parse(init.body)
      if (request.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x123' }))
      const [{ to, data }] = request.params
      let result: string
      if (data.startsWith(routerState.getSighash('PERMISSIONS_ADAPTER_FACTORY'))) {
        result = routerState.encodeFunctionResult('PERMISSIONS_ADAPTER_FACTORY', [factory])
      } else if (data.startsWith(factoryState.getSighash('verifiedPermissionsAdapterOf'))) {
        const [currency] = factoryState.decodeFunctionData('verifiedPermissionsAdapterOf', data)
        result = factoryState.encodeFunctionResult('verifiedPermissionsAdapterOf', [
          String(currency).toLowerCase() === weth.toLowerCase() ? underlying : ethersUtils.getAddress('0x0000000000000000000000000000000000000000'),
        ])
      } else if (to.toLowerCase() === weth.toLowerCase() && data.startsWith(adapterState.getSighash('swappingEnabled'))) {
        result = adapterState.encodeFunctionResult('swappingEnabled', [true])
      } else if (to.toLowerCase() === weth.toLowerCase() && data.startsWith(adapterState.getSighash('isAllowed'))) {
        result = adapterState.encodeFunctionResult('isAllowed', [true])
      } else throw new Error(`unexpected state call ${to} ${data.slice(0, 10)}`)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    }) as typeof fetch
    try {
      const v4Plan = abi.encode(['bytes', 'bytes[]'], ['0x0c0f', [
        abi.encode(['address', 'uint256'], [weth, 100_000n]),
        abi.encode(['address', 'uint256'], [usdc, 250_000n]),
      ]])
      const data = router.encodeFunctionData('execute', ['0x10', [v4Plan], 5])
      const report = await uniswapReportFindingsWithState(
        data, 1, '0xab863e752bf67d8dcdd929eaae9be9dc83fb3bbb', recipient, 'https://rpc.invalid',
      )
      expect(report.complete).toBe(true)
      expect(report.limitations).toEqual([])
      expect(report.findings).toContainEqual(expect.objectContaining({
        code: 'UNISWAP_PERMISSIONED_CURRENCY_RESOLVED',
        message: expect.stringContaining(`resolves to underlying token ${underlying}`),
      }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('decodes the legacy five-field swap layout without confusing it with v2.1.2', () => {
    const data = router.encodeFunctionData('execute', [
      '0x08',
      [abi.encode(['address', 'uint256', 'uint256', 'address[]', 'bool'], [recipient, 1, 2, [weth, usdc], true])],
      3,
    ])
    expect(decodeUniversalRouter(data)!.commands[0].decoded).toMatchObject({ layout: 'legacy', payerIsUser: true })
  })

  test('fails closed for unknown and known-but-unimplemented commands', () => {
    const data = router.encodeFunctionData('execute', ['0x9015', ['0x', '0x'], 1_800_000_000])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(false)
    expect(decoded.commands[0]).toMatchObject({ name: 'V4_SWAP', allowRevert: true })
    const report = universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
    expect(report.limitations.map(item => item.code)).toEqual([
      'UNISWAP_COMMAND_NOT_DECODED', 'UNISWAP_UNKNOWN_COMMAND',
    ])
    expect(report.limitations.every(item => item.severity === 'danger')).toBe(true)
  })

  test('decodes Permit2 allowance terms without exposing signature bytes', () => {
    const permitInput = abi.encode([
      'tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)',
      'bytes',
    ], [[
      [usdc, (1n << 160n) - 1n, 1_900_000_000, 7],
      '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85', 1_800_000_000,
    ], `0x${'11'.repeat(65)}`])
    const data = router.encodeFunctionData('execute', ['0x0a', [permitInput], 1_800_000_001])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.commands[0].decoded).toMatchObject({
      details: { token: usdc.toLowerCase(), amount: ((1n << 160n) - 1n).toString(), expiration: '1900000000', nonce: '7' },
      spender: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85', sigDeadline: '1800000000', signatureBytes: 65,
    })
    expect(JSON.stringify(decoded)).not.toContain('1111111111111111')
  })

  test('recursively decodes subplans and propagates incomplete coverage', () => {
    const nestedInput = abi.encode(['bytes', 'bytes[]'], ['0x0b15', [
      abi.encode(['address', 'uint256'], [recipient, 1]), '0x',
    ]])
    const data = router.encodeFunctionData('execute', ['0x21', [nestedInput], 4])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(false)
    expect((decoded.commands[0].decoded as any).commands.map((command: any) => command.name)).toEqual([
      'WRAP_ETH', 'UNKNOWN_0x15',
    ])
  })

  test('rejects mismatched command and input counts', () => {
    const data = router.encodeFunctionData('execute', ['0x0b08', [abi.encode(['address', 'uint256'], [recipient, 1])], 2])
    expect(() => decodeUniversalRouter(data)).toThrow('command/input length mismatch')
  })

  test('rejects top-level trailing calldata that the ABI decoder would otherwise ignore', () => {
    const data = router.encodeFunctionData('execute', ['0x0b', [abi.encode(['address', 'uint256'], [recipient, 1])], 1800000000])
    expect(decodeUniversalRouter(`${data}00`)).toBeUndefined()
    const report = universalRouterReportFindings(`${data}00`, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
    expect(report.complete).toBe(false)
  })

  test('decodes an executable v4 exact-input plan and its settlement bounds', () => {
    const poolKeyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
    const swap = abi.encode([
      `tuple(${poolKeyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`,
    ], [[
      [weth, usdc, 500, 10, '0x0000000000000000000000000000000000000000'],
      true, 100_000n, 250_000n, 123n, '0x',
    ]])
    const settle = abi.encode(['address', 'uint256'], [weth, 100_000n])
    const take = abi.encode(['address', 'uint256'], [usdc, 250_000n])
    const v4Plan = abi.encode(['bytes', 'bytes[]'], ['0x060c0f', [swap, settle, take]])
    const data = router.encodeFunctionData('execute', ['0x10', [v4Plan], 5])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    expect((decoded.commands[0].decoded as any).actions[0].decoded).toMatchObject({
      amountIn: '100000', amountOutMinimum: '250000', minHopPriceX36: '123',
      poolKey: { currency0: weth.toLowerCase(), currency1: usdc.toLowerCase(), fee: '500', tickSpacing: '10' },
    })
    const report = universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
    expect(report.findings.map(item => item.code)).toContain('UNISWAP_V4_EXACT_INPUT_SWAP')
    expect(report.findings.map(item => item.code)).toContain('UNISWAP_V4_SETTLE_ALL')
    expect(report.findings.map(item => item.code)).toContain('UNISWAP_V4_TAKE_ALL')
    expect(report.limitations).toEqual([])
  })

  test('fails closed and exposes a limitation for unsupported nested v4 actions', () => {
    const v4Plan = abi.encode(['bytes', 'bytes[]'], ['0x02', ['0x']])
    const data = router.encodeFunctionData('execute', ['0x10', [v4Plan], 5])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(false)
    const report = universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
    expect(report.limitations).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_V4_ACTION_NOT_DECODED', severity: 'danger',
    }))
  })

  test('renders router recipient sentinels as human meanings', () => {
    const data = router.encodeFunctionData('execute', ['0x08', [
      abi.encode(['address', 'uint256', 'uint256', 'address[]', 'bool'], [
        '0x0000000000000000000000000000000000000001', 1, 2, [weth, usdc], true,
      ]),
    ], 6])
    const report = universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
    expect(report.findings.find(item => item.code === 'UNISWAP_EXACT_INPUT_SWAP')?.message)
      .toContain('transaction sender (router sentinel 0x…01)')
  })

  test('decodes signed router execution without exposing signature bytes', () => {
    const wrap = abi.encode(['address', 'uint256'], [recipient, 1])
    const data = router.encodeFunctionData('executeSigned', [
      '0x0b', [wrap], `0x${'12'.repeat(32)}`, `0x${'34'.repeat(32)}`, true,
      `0x${'56'.repeat(32)}`, `0x${'ab'.repeat(65)}`, 99,
    ])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.signedExecution).toEqual({
      intent: `0x${'12'.repeat(32)}`, data: `0x${'34'.repeat(32)}`, verifySender: true,
      nonce: `0x${'56'.repeat(32)}`, signatureBytes: 65,
    })
    expect(JSON.stringify(decoded)).not.toContain('abababababababab')
    expect(universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85').findings)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_SIGNED_EXECUTION' }))
  })

  test('decodes v4 pool initialization and Across bridge economic bounds', () => {
    const poolKeyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
    const initialize = abi.encode([poolKeyType, 'uint160'], [[
      weth, usdc, 3000, 60, '0x0000000000000000000000000000000000000000',
    ], 79_228_162_514_264_337_593_543_950_336n])
    const across = abi.encode([
      'tuple(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message,bool useNative)',
    ], [[recipient, recipient, weth, usdc, 100n, 95n, 8453, '0x0000000000000000000000000000000000000000', 10, 20, 0, '0x1234', false]])
    const data = router.encodeFunctionData('execute', ['0x1340', [initialize, across], 100])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.commands[0].decoded).toMatchObject({
      poolKey: { currency0: weth.toLowerCase(), currency1: usdc.toLowerCase(), fee: '3000', tickSpacing: '60' },
      sqrtPriceX96: '79228162514264337593543950336',
    })
    expect(decoded.commands[1].decoded).toMatchObject({
      recipient: recipient.toLowerCase(), inputAmount: '100', outputAmount: '95', destinationChainId: '8453',
      messageBytes: 2, useNative: false,
    })
    const codes = universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85')
      .findings.map(item => item.code)
    expect(codes).toContain('UNISWAP_V4_INITIALIZE_POOL')
    expect(codes).toContain('UNISWAP_ACROSS_BRIDGE')
  })

  test('decodes the router-safe v3 position permit and liquidity calls', () => {
    const manager = new ethersUtils.Interface([
      'function permit(address spender,uint256 tokenId,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
      'function decreaseLiquidity(tuple(uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)',
      'function collect(tuple(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params)',
      'function burn(uint256 tokenId)',
    ])
    const permit = manager.encodeFunctionData('permit', [recipient, 42, 100, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])
    const decrease = manager.encodeFunctionData('decreaseLiquidity', [[42, 500, 10, 20, 100]])
    const collect = manager.encodeFunctionData('collect', [[42, recipient, 10, 20]])
    const burn = manager.encodeFunctionData('burn', [42])
    const data = router.encodeFunctionData('execute', ['0x11121212', [permit, decrease, collect, burn], 100])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    expect(decoded.commands.map(command => (command.decoded as any).method)).toEqual([
      'permit', 'decreaseLiquidity', 'collect', 'burn',
    ])
    expect(decoded.commands[1].decoded).toMatchObject({
      tokenId: '42', liquidity: '500', amount0Min: '10', amount1Min: '20', deadline: '100',
    })
    expect(decoded.commands[2].decoded).toMatchObject({ tokenId: '42', recipient: recipient.toLowerCase() })
  })

  test('rejects a v3 position-manager method outside the router allowlist', () => {
    const unsafe = new ethersUtils.Interface(['function approve(address to,uint256 tokenId)'])
      .encodeFunctionData('approve', [recipient, 42])
    const data = router.encodeFunctionData('execute', ['0x12', [unsafe], 100])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(false)
    expect(decoded.commands[0].decodeError).toContain('no matching function')
  })

  test('decodes v4 position mint and payment plan with slippage maxima', () => {
    const manager = new ethersUtils.Interface(['function modifyLiquidities(bytes unlockData,uint256 deadline)'])
    const poolKeyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
    const mint = abi.encode([
      poolKeyType, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes',
    ], [[weth, usdc, 500, 10, '0x0000000000000000000000000000000000000000'], -100, 100, 1_000, 50, 60, recipient, '0x'])
    const settlePair = abi.encode(['address', 'address'], [weth, usdc])
    const takePair = abi.encode(['address', 'address', 'address'], [weth, usdc, recipient])
    const unlockData = abi.encode(['bytes', 'bytes[]'], ['0x020d11', [mint, settlePair, takePair]])
    const call = manager.encodeFunctionData('modifyLiquidities', [unlockData, 100])
    const data = router.encodeFunctionData('execute', ['0x14', [call], 100])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(true)
    const value = decoded.commands[0].decoded as any
    expect(value.actions.map((action: any) => action.name)).toEqual(['MINT_POSITION', 'SETTLE_PAIR', 'TAKE_PAIR'])
    expect(value.actions[0].decoded).toMatchObject({
      tickLower: '-100', tickUpper: '100', liquidity: '1000', amount0Max: '50', amount1Max: '60',
      owner: recipient.toLowerCase(),
    })
    expect(universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85').limitations).toEqual([])
  })

  test('fails closed for position-altering v4 actions rejected by the router gate', () => {
    const manager = new ethersUtils.Interface(['function modifyLiquidities(bytes unlockData,uint256 deadline)'])
    const unlockData = abi.encode(['bytes', 'bytes[]'], ['0x01', ['0x']])
    const call = manager.encodeFunctionData('modifyLiquidities', [unlockData, 100])
    const data = router.encodeFunctionData('execute', ['0x14', [call], 100])
    const decoded = decodeUniversalRouter(data)!
    expect(decoded.complete).toBe(false)
    expect(universalRouterReportFindings(data, 1, '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85').limitations)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_V4_ACTION_NOT_DECODED', severity: 'danger' }))
  })
})
