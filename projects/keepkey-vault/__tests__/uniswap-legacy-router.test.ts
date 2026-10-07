import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import { decodeLegacyUniswapCall, legacyUniswapReportFindings, legacyUniswapSelectorInventory } from '../src/bun/uniswap-legacy-router'
import { uniswapReportFindings } from '../src/bun/uniswap-report'

const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const recipient = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'

describe('Uniswap legacy router ClearSign decoding', () => {
  test('pins the official user-transaction selector denominator by contract family', () => {
    const inventory = legacyUniswapSelectorInventory()
    expect(Object.fromEntries(Object.entries(inventory).map(([family, entries]) => [family, entries.length]))).toEqual({
      v2Router02: 17, v3SwapRouter: 4, swapRouter02: 34, v3PositionManager: 20,
    })
    for (const entries of Object.values(inventory)) {
      expect(new Set(entries.map(entry => entry.signature)).size).toBe(entries.length)
      expect(new Set(entries.map(entry => entry.selector)).size).toBe(entries.length)
      expect(entries.every(entry => /^0x[0-9a-f]{8}$/.test(entry.selector))).toBe(true)
    }
    expect(inventory.swapRouter02.map(entry => entry.signature)).toEqual(expect.arrayContaining([
      'swapExactTokensForTokens(uint256,uint256,address[],address)',
      'checkOracleSlippage(bytes[],uint128[],uint24,uint32)',
      'multicall(bytes32,bytes[])',
      'callPositionManager(bytes)',
      'unwrapWETH9WithFee(uint256,uint256,address)',
    ]))
    expect(inventory.v3PositionManager.map(entry => entry.signature)).toEqual(expect.arrayContaining([
      'createAndInitializePoolIfNecessary(address,address,uint24,uint160)',
      'setApprovalForAll(address,bool)',
      'selfPermitAllowedIfNecessary(address,uint256,uint256,uint8,bytes32,bytes32)',
    ]))
  })

  test('decodes V2 exact-input native swap bounds', () => {
    const iface = new ethersUtils.Interface([
      'function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)',
    ])
    const data = iface.encodeFunctionData('swapExactETHForTokens', [250_000, [weth, usdc], recipient, 1_800_000_000])
    expect(decodeLegacyUniswapCall(data)).toMatchObject({
      method: 'swapExactETHForTokens',
      decoded: { mode: 'exact-input', nativeIn: true, amountOutMinimum: '250000', recipient: recipient.toLowerCase() },
    })
    const report = legacyUniswapReportFindings(data, 1, '0x7a250d5630b4cf539739df2c5dacab4c659f2488d')
    expect(report.complete).toBe(true)
    expect(report.limitations).toEqual([])
    expect(report.findings[1].message).toContain('transaction native value')
  })

  test('decodes SwapRouter02 v3 swap inside multicall', () => {
    const iface = new ethersUtils.Interface([
      'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)',
      'function multicall(uint256 deadline,bytes[] data)',
      'function unwrapWETH9(uint256 amountMinimum,address recipient)',
    ])
    const swap = iface.encodeFunctionData('exactInputSingle', [[weth, usdc, 500, recipient, 100_000, 250_000, 0]])
    const unwrap = iface.encodeFunctionData('unwrapWETH9', [1, recipient])
    const data = iface.encodeFunctionData('multicall', [1_800_000_000, [swap, unwrap]])
    const decoded = decodeLegacyUniswapCall(data)!
    expect(decoded.method).toBe('multicall')
    expect(decoded.children?.map(call => call.method)).toEqual(['exactInputSingle', 'unwrapWETH9'])
    const report = legacyUniswapReportFindings(data, 1, '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45')
    expect(report.limitations).toEqual([])
    expect(report.findings.map(item => item.code)).toContain('UNISWAP_EXACT_INPUT_SWAP')
    expect(report.findings.map(item => item.code)).toContain('UNISWAP_UNWRAP_WETH')
  })

  test('fails closed when one nested multicall is unknown', () => {
    const iface = new ethersUtils.Interface(['function multicall(bytes[] data)'])
    const data = iface.encodeFunctionData('multicall', [['0x12345678']])
    const report = legacyUniswapReportFindings(data, 1, '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45')
    expect(report.complete).toBe(false)
    expect(report.limitations).toContainEqual(expect.objectContaining({ code: 'UNISWAP_LEGACY_CALL_INCOMPLETE' }))
  })

  test('does not authenticate compatible calldata sent to an unknown contract', () => {
    const iface = new ethersUtils.Interface([
      'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
    ])
    const data = iface.encodeFunctionData('swapExactTokensForTokens', [100, 90, [weth, usdc], recipient, 1000])
    const report = legacyUniswapReportFindings(data, 1, '0x1111111111111111111111111111111111111111')
    expect(report.complete).toBe(false)
    expect(report.limitations)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_ROUTER_IDENTITY_UNVERIFIED', severity: 'danger' }))
  })

  test('does not misclassify an Arbitrum ERC-20 Permit2 approval as a position NFT approval', () => {
    const iface = new ethersUtils.Interface(['function approve(address spender,uint256 amount)'])
    const data = iface.encodeFunctionData('approve', [
      '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    ])
    const report = uniswapReportFindings(data, 42161, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9')
    expect(report).toMatchObject({
      complete: true,
      limitations: [],
      findings: [{ code: 'UNISWAP_PERMIT2_TOKEN_APPROVAL', message: expect.stringContaining('unlimited amount of USDT') }],
    })
    expect(JSON.stringify(report)).not.toContain('position NFT')
    expect(JSON.stringify(report)).not.toContain('Uniswap-compatible')
  })

  test('authenticates the same legacy family across canonical multichain deployments', () => {
    const iface = new ethersUtils.Interface([
      'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
    ])
    const data = iface.encodeFunctionData('swapExactTokensForTokens', [100, 90, [weth, usdc], recipient, 1_800_000_000])
    const deployments: Array<[number, string]> = [
      [10, '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2'],
      [56, '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'],
      [8453, '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'],
      [11155111, '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3'],
    ]
    for (const [chainId, target] of deployments) {
      expect(legacyUniswapReportFindings(data, chainId, target)).toMatchObject({ complete: true, limitations: [] })
    }
  })

  test('rejects an official Uniswap address from the wrong contract family', () => {
    const iface = new ethersUtils.Interface([
      'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
    ])
    const data = iface.encodeFunctionData('swapExactTokensForTokens', [100, 90, [weth, usdc], recipient, 1_800_000_000])
    const wrongFamily = legacyUniswapReportFindings(data, 1, '0xc36442b4a4522e871399cd717abdd847ab11fe88')
    expect(wrongFamily.complete).toBe(false)
    expect(wrongFamily.limitations).toContainEqual(expect.objectContaining({
      code: 'UNISWAP_ROUTER_IDENTITY_UNVERIFIED',
      message: expect.stringContaining('V2 Router02'),
    }))
  })

  test('distinguishes the original SwapRouter ABI from SwapRouter02 identity', () => {
    const iface = new ethersUtils.Interface([
      'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)',
    ])
    const data = iface.encodeFunctionData('exactInputSingle', [[weth, usdc, 500, recipient, 1_800_000_000, 100, 90, 0]])
    expect(legacyUniswapReportFindings(data, 137, '0xE592427A0AEce92De3Edee1F18E0157C05861564').complete).toBe(true)
    expect(legacyUniswapReportFindings(data, 137, '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45').complete).toBe(false)
  })

  test('decodes v2 liquidity bounds and embedded permit scope', () => {
    const iface = new ethersUtils.Interface([
      'function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline)',
      'function removeLiquidityWithPermit(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s)',
    ])
    const add = iface.encodeFunctionData('addLiquidityETH', [usdc, 1_000, 900, 800, recipient, 2_000])
    expect(decodeLegacyUniswapCall(add)).toMatchObject({ decoded: {
      mode: 'add-liquidity', amountADesired: '1000', amountAMin: '900', amountBMin: '800', tokenB: 'native',
    } })
    expect(legacyUniswapReportFindings(add, 1, '0x7a250d5630b4cf539739df2c5dacab4c659f2488d').findings)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_V2_ADD_LIQUIDITY' }))

    const remove = iface.encodeFunctionData('removeLiquidityWithPermit', [
      weth, usdc, 500, 40, 50, recipient, 2_000, true, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
    ])
    const decoded = decodeLegacyUniswapCall(remove)!
    expect(decoded.decoded).toMatchObject({
      mode: 'remove-liquidity', liquidity: '500', amountAMin: '40', amountBMin: '50', permitIncluded: true, approveMax: true,
    })
    expect(JSON.stringify(decoded)).not.toContain('1111111111111111')
  })

  test('decodes SwapRouter02 selfPermit without retaining signature bytes', () => {
    const iface = new ethersUtils.Interface([
      'function selfPermitIfNecessary(address token,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
    ])
    const data = iface.encodeFunctionData('selfPermitIfNecessary', [
      usdc, 1_000, 2_000, 27, `0x${'ab'.repeat(32)}`, `0x${'cd'.repeat(32)}`,
    ])
    const decoded = decodeLegacyUniswapCall(data)!
    expect(decoded.decoded).toMatchObject({
      mode: 'self-permit', token: usdc.toLowerCase(), value: '1000', deadline: '2000', onlyIfNecessary: true,
    })
    expect(JSON.stringify(decoded)).not.toContain('abababababababab')
    expect(legacyUniswapReportFindings(data, 1, '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45').findings)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_SELF_PERMIT' }))
  })

  test('decodes SwapRouter02 v2 swaps, blockhash guards, and fee payments', () => {
    const iface = new ethersUtils.Interface([
      'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to)',
      'function unwrapWETH9WithFee(uint256 amountMinimum,address recipient,uint256 feeBips,address feeRecipient)',
      'function multicall(bytes32 previousBlockhash,bytes[] data)',
    ])
    const swap = iface.encodeFunctionData('swapExactTokensForTokens', [100, 90, [weth, usdc], recipient])
    const fee = iface.encodeFunctionData('unwrapWETH9WithFee', [80, recipient, 25, weth])
    const blockhash = `0x${'12'.repeat(32)}`
    const data = iface.encodeFunctionData('multicall', [blockhash, [swap, fee]])
    const decoded = decodeLegacyUniswapCall(data)!
    expect(decoded.decoded).toMatchObject({ previousBlockhash: blockhash, calls: 2 })
    expect(decoded.children?.[0].decoded).toMatchObject({ mode: 'exact-input', amountIn: '100', amountOutMinimum: '90', router02V2: true })
    const report = legacyUniswapReportFindings(data, 1, '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45')
    expect(report.complete).toBe(true)
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_UNWRAP_WETH_WITH_FEE', message: expect.stringContaining('25 bips') }))
  })

  test('decodes extended payments and oracle guards used inside SwapRouter02 multicalls', () => {
    const iface = new ethersUtils.Interface([
      'function pull(address token,uint256 value)',
      'function wrapETH(uint256 value)',
      'function sweepToken(address token,uint256 amountMinimum)',
      'function checkOracleSlippage(bytes path,uint24 maximumTickDivergence,uint32 secondsAgo)',
      'function multicall(bytes[] data)',
    ])
    const path = ethersUtils.solidityPack(['address', 'uint24', 'address'], [weth, 500, usdc])
    const data = iface.encodeFunctionData('multicall', [[
      iface.encodeFunctionData('pull', [usdc, 100]),
      iface.encodeFunctionData('wrapETH', [200]),
      iface.encodeFunctionData('sweepToken', [usdc, 90]),
      iface.encodeFunctionData('checkOracleSlippage', [path, 25, 300]),
    ]])
    const report = legacyUniswapReportFindings(data, 1, '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45')
    expect(report.complete).toBe(true)
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_PULL_TOKEN', message: expect.stringContaining('100 base units') }))
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_WRAP_NATIVE', message: expect.stringContaining('200 wei') }))
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_ORACLE_SLIPPAGE_CHECK', message: expect.stringContaining('25 ticks') }))
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_SWEEP', message: expect.stringContaining('transaction sender') }))
  })

  test('authenticates v3 PositionManager authority calls inside multicall', () => {
    const iface = new ethersUtils.Interface([
      'function approve(address to,uint256 tokenId)',
      'function setApprovalForAll(address operator,bool approved)',
      'function multicall(bytes[] data)',
    ])
    const approve = iface.encodeFunctionData('approve', [recipient, 42])
    const approveAll = iface.encodeFunctionData('setApprovalForAll', [weth, true])
    const data = iface.encodeFunctionData('multicall', [[approve, approveAll]])
    const report = legacyUniswapReportFindings(data, 1, '0xc36442b4a4522e871399cd717abdd847ab11fe88')
    expect(report.complete).toBe(true)
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_V3_POSITION_APPROVE' }))
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_V3_POSITION_APPROVE-ALL' }))
    expect(legacyUniswapReportFindings(data, 1, '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45').complete).toBe(false)
  })

  test('decodes direct v3 position-manager mint bounds', () => {
    const iface = new ethersUtils.Interface([
      'function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params)',
    ])
    const data = iface.encodeFunctionData('mint', [[weth, usdc, 500, -100, 100, 1_000, 2_000, 900, 1_800, recipient, 3_000]])
    const decoded = decodeLegacyUniswapCall(data)!
    expect(decoded.decoded).toMatchObject({
      mode: 'v3-position', action: 'mint', fee: '500', tickLower: '-100', tickUpper: '100',
      amount0Desired: '1000', amount1Desired: '2000', amount0Min: '900', amount1Min: '1800',
    })
    const report = legacyUniswapReportFindings(data, 1, '0xc36442b4a4522e871399cd717abdd847ab11fe88')
    expect(report.complete).toBe(true)
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'UNISWAP_V3_POSITION_MINT' }))
    expect(uniswapReportFindings(data, 1, '0xc36442b4a4522e871399cd717abdd847ab11fe88').findings)
      .toContainEqual(expect.objectContaining({ code: 'UNISWAP_V3_POSITION_MINT' }))
  })
})
