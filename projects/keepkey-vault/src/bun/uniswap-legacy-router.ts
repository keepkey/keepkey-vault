import { utils as ethersUtils } from 'ethers'

import type { EffectFinding } from '../shared/transaction-effects'

const V2 = new ethersUtils.Interface([
  'function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function swapETHForExactTokens(uint256 amountOut,address[] path,address to,uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function swapTokensForExactETH(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address to,uint256 deadline)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
  'function addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline)',
  'function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline)',
  'function removeLiquidity(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline)',
  'function removeLiquidityETH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline)',
  'function removeLiquidityWithPermit(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s)',
  'function removeLiquidityETHWithPermit(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s)',
  'function removeLiquidityETHSupportingFeeOnTransferTokens(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline)',
  'function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s)',
])

const V3 = new ethersUtils.Interface([
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)',
  'function exactOutputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params)',
  'function exactInput(tuple(bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params)',
  'function exactOutput(tuple(bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum) params)',
])

const SWAP_ROUTER_02 = new ethersUtils.Interface([
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to)',
  'function swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] path,address to)',
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)',
  'function exactOutputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params)',
  'function exactInput(tuple(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params)',
  'function exactOutput(tuple(bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params)',
  'function multicall(bytes[] data)',
  'function multicall(uint256 deadline,bytes[] data)',
  'function multicall(bytes32 previousBlockhash,bytes[] data)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient)',
  'function unwrapWETH9(uint256 amountMinimum)',
  'function wrapETH(uint256 value)',
  'function sweepToken(address token,uint256 amountMinimum,address recipient)',
  'function sweepToken(address token,uint256 amountMinimum)',
  'function pull(address token,uint256 value)',
  'function refundETH()',
  'function unwrapWETH9WithFee(uint256 amountMinimum,address recipient,uint256 feeBips,address feeRecipient)',
  'function unwrapWETH9WithFee(uint256 amountMinimum,uint256 feeBips,address feeRecipient)',
  'function sweepTokenWithFee(address token,uint256 amountMinimum,address recipient,uint256 feeBips,address feeRecipient)',
  'function sweepTokenWithFee(address token,uint256 amountMinimum,uint256 feeBips,address feeRecipient)',
  'function getApprovalType(address token,uint256 amount)',
  'function checkOracleSlippage(bytes path,uint24 maximumTickDivergence,uint32 secondsAgo)',
  'function checkOracleSlippage(bytes[] paths,uint128[] amounts,uint24 maximumTickDivergence,uint32 secondsAgo)',
  'function approveMax(address token)',
  'function approveMaxMinusOne(address token)',
  'function approveZeroThenMax(address token)',
  'function approveZeroThenMaxMinusOne(address token)',
  'function callPositionManager(bytes data)',
  'function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Min,uint256 amount1Min,address recipient) params)',
  'function increaseLiquidity(tuple(address token0,address token1,uint256 tokenId,uint256 amount0Min,uint256 amount1Min) params)',
  'function selfPermit(address token,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function selfPermitIfNecessary(address token,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function selfPermitAllowed(address token,uint256 nonce,uint256 expiry,uint8 v,bytes32 r,bytes32 s)',
  'function selfPermitAllowedIfNecessary(address token,uint256 nonce,uint256 expiry,uint8 v,bytes32 r,bytes32 s)',
])

const V3_POSITION_MANAGER = new ethersUtils.Interface([
  'function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params)',
  'function increaseLiquidity(tuple(uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)',
  'function decreaseLiquidity(tuple(uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)',
  'function collect(tuple(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params)',
  'function burn(uint256 tokenId)',
  'function permit(address spender,uint256 tokenId,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function multicall(bytes[] data)',
  'function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient)',
  'function sweepToken(address token,uint256 amountMinimum,address recipient)',
  'function refundETH()',
  'function approve(address to,uint256 tokenId)',
  'function setApprovalForAll(address operator,bool approved)',
  'function transferFrom(address from,address to,uint256 tokenId)',
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
  'function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)',
  'function selfPermit(address token,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function selfPermitIfNecessary(address token,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function selfPermitAllowed(address token,uint256 nonce,uint256 expiry,uint8 v,bytes32 r,bytes32 s)',
  'function selfPermitAllowedIfNecessary(address token,uint256 nonce,uint256 expiry,uint8 v,bytes32 r,bytes32 s)',
])

export function legacyUniswapSelectorInventory(): Record<'v2Router02' | 'v3SwapRouter' | 'swapRouter02' | 'v3PositionManager', Array<{ signature: string; selector: string }>> {
  const entries = (iface: ethersUtils.Interface) => Object.keys(iface.functions).sort().map(signature => ({
    signature, selector: iface.getSighash(signature),
  }))
  return {
    v2Router02: entries(V2),
    v3SwapRouter: entries(V3),
    swapRouter02: entries(SWAP_ROUTER_02),
    v3PositionManager: entries(V3_POSITION_MANAGER),
  }
}

type LegacyContractFamily = 'v2' | 'swap-router' | 'swap-router-02' | 'v3-position-manager'
type LegacyDeployments = Partial<Record<LegacyContractFamily, string>>

// Current canonical Uniswap/contracts deployment manifests. Contract family is
// part of identity: an official address for a different family is not enough.
export const OFFICIAL_LEGACY_UNISWAP_DEPLOYMENTS: Record<number, LegacyDeployments> = {
  1: { v2: '0x7a250d5630b4cf539739df2c5dacab4c659f2488d', 'swap-router': '0xe592427a0aece92de3edee1f18e0157c05861564', 'swap-router-02': '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'v3-position-manager': '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
  10: { v2: '0x4a7b5da61326a6379179b40d00f57e5bbdc962c2', 'swap-router-02': '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'v3-position-manager': '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
  10143: { v2: '0xfb8e1c3b833f9e67a71c859a132cf783b645e436', 'swap-router-02': '0x4c4eabd5fb1d1a7234a48692551eaecff8194ca7', 'v3-position-manager': '0x3dcc735c74f10fe2b9db2bb55c40fbbbf24490f7' },
  11155111: { v2: '0xee567fe1712faf6149d80da1e6934e354124cfe3', 'swap-router-02': '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e', 'v3-position-manager': '0x1238536071e1c677a632429e3655c799b22cda52' },
  130: { v2: '0x284f11109359a7e1306c3e447ef14d38400063ff', 'swap-router-02': '0x73855d06de49d0fe4a9c42636ba96c62da12ff9c', 'v3-position-manager': '0x943e6e07a7e8e791dafc44083e54041d743c46e9' },
  1301: { v2: '0x6e8c9d62a16419357ea998229126d2fd6b1ccfbf', 'swap-router-02': '0xd1aae39293221b77b0c71fbd6dcb7ea29bb5b166', 'v3-position-manager': '0xb7f724d6dddfd008eff5cc2834edde5f9ef0d075' },
  137: { v2: '0xedf6066a2b290c185783862c7f4776a2c8077ad1', 'swap-router': '0xe592427a0aece92de3edee1f18e0157c05861564', 'swap-router-02': '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'v3-position-manager': '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
  143: { v2: '0x4b2ab38dbf28d31d467aa8993f6c2585981d6804', 'swap-router': '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', 'swap-router-02': '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900', 'v3-position-manager': '0x7197e214c0b767cfb76fb734ab638e2c192f4e53' },
  1868: { v2: '0x273f68c234fa55b550b40e563c4a488e0d334320', 'swap-router-02': '0x7e40db01736f88464e5f4e42394f3d5bbb6705b9', 'v3-position-manager': '0x56c1205b0244332011c1e866f4ea5384eb6bfa2c' },
  196: { v2: '0x182a927119d56008d921126764bf884221b10f59', 'swap-router': '0x7078c4537c04c2b2e52ddba06074dbdacf23ca15', 'swap-router-02': '0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca', 'v3-position-manager': '0x315e413a11ab0df498ef83873012430ca36638ae' },
  30: { 'swap-router-02': '0x0b14ff67f0014046b4b99057aec4509640b3947a', 'v3-position-manager': '0x9d9386c042f194b460ec424a1e57acde25f5c4b1' },
  42161: { v2: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', 'swap-router': '0xe592427a0aece92de3edee1f18e0157c05861564', 'swap-router-02': '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', 'v3-position-manager': '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
  4217: { v2: '0x0fbac3c46f6f83b44c7fb4ea986d7309c701d73e', 'swap-router': '0x6a3988d2366ad79917a2399f18a1a82b157470e1', 'swap-router-02': '0x7e9d53081e961201837336bcd81f52ae92691a8f', 'v3-position-manager': '0xb71c33f096ceabdc0229110e0d76a6382d01c633' },
  42220: { 'swap-router-02': '0x5615cdab10dc425a742d643d949a7f474c01abc4', 'v3-position-manager': '0x3d79edaabc0eab6f08ed885c05fc0b014290d95a' },
  43114: { 'swap-router-02': '0xbb00ff08d01d300023c629e8ffffcb65a5a578ce', 'v3-position-manager': '0x655c406ebfa14ee2006250925e54ec43ad184f8b' },
  4326: { v2: '0xb73055db2b3a3eae87a331dd88e4a80b43602690', 'swap-router': '0x2eec3eb1c9dc14af773e04a177f960124295a067', 'swap-router-02': '0x48020de9208bafc183f5cad5118ffbe8f0f913f5', 'v3-position-manager': '0xcdc86e98184e96436f733a8bf31bd4f0214e6d7d' },
  4663: { v2: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba', 'swap-router-02': '0xcaf681a66d020601342297493863e78c959e5cb2', 'v3-position-manager': '0x73991a25c818bf1f1128deaab1492d45638de0d3' },
  480: { v2: '0x541ab7c31a119441ef3575f6973277de0ef460bd', 'v3-position-manager': '0xec12a9f9a09f50550686363766cc153d03c27b5e' },
  5042: { v2: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', 'swap-router-02': '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77', 'v3-position-manager': '0x39654a85a4c05127f5fd6ed22caec077a0fb1377' },
  56: { v2: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', 'swap-router-02': '0xb971ef87ede563556b2ed4b1c0b0019111dd85d2', 'v3-position-manager': '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613' },
  57073: { v2: '0xb3fb126acdd5adca2f50ac644a7a2303745f18b4', 'swap-router-02': '0x177778f19e89dd1012bdbe603f144088a95c4b53', 'v3-position-manager': '0xc0836e5b058bbe22ae2266e1ac488a1a0fd8dce8' },
  59144: { v2: '0x8702463e73f74d0b6765abceb314ef07acb92650', 'swap-router': '0xbbbcc62853a5fa27b93d6bab3e6f7ce841e25df2', 'swap-router-02': '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a', 'v3-position-manager': '0x4615c383f85d0a2bbed973d83ccecf5cb7121463' },
  81457: { v2: '0xbb66eb1c5e875933d44dae661dbd80e5d9b03035', 'v3-position-manager': '0xb218e4f7cf0533d4696fdfc419a0023d33345f28' },
  8453: { v2: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', 'swap-router-02': '0x2626664c2603336e57b271c5c0b26f421741e481', 'v3-position-manager': '0x03a520b32c04bf3beef7beb72e919cf822ed34f1' },
}

export function isOfficialLegacyUniswapTarget(chainId?: number, to?: string): boolean {
  if (!chainId || !to) return false
  const target = to.toLowerCase()
  return Object.values(OFFICIAL_LEGACY_UNISWAP_DEPLOYMENTS[chainId] || {}).includes(target)
}

const FAMILY_LABELS: Record<LegacyContractFamily, string> = {
  v2: 'Uniswap V2 Router02',
  'swap-router': 'Uniswap V3 SwapRouter',
  'swap-router-02': 'Uniswap SwapRouter02',
  'v3-position-manager': 'Uniswap V3 NonfungiblePositionManager',
}

export interface LegacyUniswapCall {
  method: string
  decoded: Record<string, unknown>
  children?: LegacyUniswapCall[]
}

const text = (value: any) => value?.toString?.() ?? String(value)
const address = (value: any) => String(value).toLowerCase()
const addresses = (value: any[]) => value.map(address)

function parseExact(iface: ethersUtils.Interface, data: string): ethersUtils.TransactionDescription | undefined {
  try {
    const parsed = iface.parseTransaction({ data })
    if (iface.encodeFunctionData(parsed.sighash, Array.from(parsed.args)).toLowerCase() !== data.toLowerCase()) return undefined
    return parsed
  } catch { return undefined }
}

function decodeV3Path(raw: string, exactOutput: boolean): string[] {
  const hex = raw.replace(/^0x/, '').toLowerCase()
  if (hex.length < 86 || (hex.length - 40) % 46 !== 0) throw new Error('invalid packed v3 path')
  const result = [`0x${hex.slice(0, 40)}`]
  for (let offset = 40; offset < hex.length; offset += 46) {
    const fee = parseInt(hex.slice(offset, offset + 6), 16)
    result.push(`fee ${fee}`, `0x${hex.slice(offset + 6, offset + 46)}`)
  }
  return exactOutput ? result.reverse() : result
}

export function decodeLegacyUniswapCall(data: string, depth = 0): LegacyUniswapCall | undefined {
  if (depth > 8 || !/^0x[0-9a-f]+$/i.test(data)) return undefined
  const v2 = parseExact(V2, data)
  if (v2) {
    const args: any = v2.args
    if (v2.name === 'addLiquidity') return { method: v2.name, decoded: {
      mode: 'add-liquidity', tokenA: address(args.tokenA), tokenB: address(args.tokenB),
      amountADesired: text(args.amountADesired), amountBDesired: text(args.amountBDesired),
      amountAMin: text(args.amountAMin), amountBMin: text(args.amountBMin), recipient: address(args.to), deadline: text(args.deadline),
    } }
    if (v2.name === 'addLiquidityETH') return { method: v2.name, decoded: {
      mode: 'add-liquidity', tokenA: address(args.token), tokenB: 'native',
      amountADesired: text(args.amountTokenDesired), amountBDesired: 'transaction native value',
      amountAMin: text(args.amountTokenMin), amountBMin: text(args.amountETHMin), recipient: address(args.to), deadline: text(args.deadline),
    } }
    if (v2.name.startsWith('removeLiquidity')) {
      const native = v2.name.includes('ETH')
      return { method: v2.name, decoded: {
        mode: 'remove-liquidity', tokenA: address(args.tokenA ?? args.token), tokenB: native ? 'native' : address(args.tokenB),
        liquidity: text(args.liquidity), amountAMin: text(args.amountAMin ?? args.amountTokenMin),
        amountBMin: text(args.amountBMin ?? args.amountETHMin), recipient: address(args.to), deadline: text(args.deadline),
        permitIncluded: v2.name.includes('WithPermit'), approveMax: args.approveMax === undefined ? undefined : Boolean(args.approveMax),
        feeOnTransferSupporting: v2.name.includes('SupportingFeeOnTransferTokens'),
      } }
    }
    const exactOut = v2.name === 'swapETHForExactTokens' || v2.name === 'swapTokensForExactETH' || v2.name === 'swapTokensForExactTokens'
    const nativeIn = v2.name.startsWith('swapExactETH') || v2.name === 'swapETHForExactTokens'
    const nativeOut = v2.name.includes('TokensForETH')
    return { method: v2.name, decoded: {
      mode: exactOut ? 'exact-output' : 'exact-input', nativeIn, nativeOut,
      ...(nativeIn ? {} : { [exactOut ? 'amountInMaximum' : 'amountIn']: text(args.amountInMax ?? args.amountIn) }),
      [exactOut ? 'amountOut' : 'amountOutMinimum']: text(args.amountOut ?? args.amountOutMin),
      path: addresses(args.path), recipient: address(args.to), deadline: text(args.deadline),
      feeOnTransferSupporting: v2.name.includes('SupportingFeeOnTransferTokens'),
    } }
  }
  const v3 = parseExact(V3, data) || parseExact(SWAP_ROUTER_02, data)
  if (!v3) {
    const position = parseExact(V3_POSITION_MANAGER, data)
    if (!position) return undefined
    const args: any = position.args
    if (position.name === 'multicall') {
      const children = Array.from(args.data as string[]).map(item => decodeLegacyUniswapCall(item, depth + 1))
      if (children.some(item => !item)) throw new Error('unrecognized nested v3 PositionManager multicall')
      return { method: 'multicall', decoded: { calls: children.length, positionManager: true }, children: children as LegacyUniswapCall[] }
    }
    if (position.name === 'createAndInitializePoolIfNecessary') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'initialize-pool', token0: address(args.token0), token1: address(args.token1), fee: text(args.fee), sqrtPriceX96: text(args.sqrtPriceX96),
    } }
    if (position.name === 'approve') return { method: position.name, decoded: { mode: 'v3-position', action: 'approve', spender: address(args.to), tokenId: text(args.tokenId) } }
    if (position.name === 'setApprovalForAll') return { method: position.name, decoded: { mode: 'v3-position', action: 'approve-all', operator: address(args.operator), approved: Boolean(args.approved) } }
    if (position.name === 'transferFrom' || position.name === 'safeTransferFrom') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'transfer', from: address(args.from), recipient: address(args.to), tokenId: text(args.tokenId), dataBytes: args.data === undefined ? undefined : (String(args.data).length - 2) / 2,
    } }
    if (position.name === 'refundETH') return { method: position.name, decoded: { mode: 'v3-position', action: 'refund-native' } }
    if (position.name === 'unwrapWETH9') return { method: position.name, decoded: { mode: 'v3-position', action: 'unwrap-weth', amountMinimum: text(args.amountMinimum), recipient: address(args.recipient) } }
    if (position.name === 'sweepToken') return { method: position.name, decoded: { mode: 'v3-position', action: 'sweep-token', token: address(args.token), amountMinimum: text(args.amountMinimum), recipient: address(args.recipient) } }
    if (position.name === 'burn') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'burn', tokenId: text(args.tokenId),
    } }
    if (position.name === 'permit') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'permit', spender: address(args.spender), tokenId: text(args.tokenId), deadline: text(args.deadline),
    } }
    const p = args.params
    if (position.name === 'mint') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'mint', token0: address(p.token0), token1: address(p.token1), fee: text(p.fee),
      tickLower: text(p.tickLower), tickUpper: text(p.tickUpper), amount0Desired: text(p.amount0Desired),
      amount1Desired: text(p.amount1Desired), amount0Min: text(p.amount0Min), amount1Min: text(p.amount1Min),
      recipient: address(p.recipient), deadline: text(p.deadline),
    } }
    if (position.name === 'increaseLiquidity') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'increase', tokenId: text(p.tokenId), amount0Desired: text(p.amount0Desired),
      amount1Desired: text(p.amount1Desired), amount0Min: text(p.amount0Min), amount1Min: text(p.amount1Min), deadline: text(p.deadline),
    } }
    if (position.name === 'decreaseLiquidity') return { method: position.name, decoded: {
      mode: 'v3-position', action: 'decrease', tokenId: text(p.tokenId), liquidity: text(p.liquidity),
      amount0Min: text(p.amount0Min), amount1Min: text(p.amount1Min), deadline: text(p.deadline),
    } }
    return { method: position.name, decoded: {
      mode: 'v3-position', action: 'collect', tokenId: text(p.tokenId), recipient: address(p.recipient),
      amount0Max: text(p.amount0Max), amount1Max: text(p.amount1Max),
    } }
  }
  if (v3.name === 'multicall') {
    const items = Array.from(v3.args.data as string[])
    const children = items.map(item => decodeLegacyUniswapCall(item, depth + 1))
    if (children.some(item => !item)) throw new Error('unrecognized nested SwapRouter02 multicall')
    return { method: 'multicall', decoded: {
      ...(v3.args.deadline !== undefined ? { deadline: text(v3.args.deadline) } : {}),
      ...(v3.args.previousBlockhash !== undefined ? { previousBlockhash: String(v3.args.previousBlockhash).toLowerCase() } : {}), calls: children.length,
    }, children: children as LegacyUniswapCall[] }
  }
  if (v3.name === 'swapExactTokensForTokens' || v3.name === 'swapTokensForExactTokens') {
    const exactOut = v3.name === 'swapTokensForExactTokens'
    return { method: v3.name, decoded: {
      mode: exactOut ? 'exact-output' : 'exact-input',
      [exactOut ? 'amountOut' : 'amountIn']: text(v3.args[exactOut ? 'amountOut' : 'amountIn']),
      [exactOut ? 'amountInMaximum' : 'amountOutMinimum']: text(v3.args[exactOut ? 'amountInMax' : 'amountOutMin']),
      path: addresses(v3.args.path), recipient: address(v3.args.to), router02V2: true,
    } }
  }
  if (v3.name === 'refundETH') return { method: v3.name, decoded: {} }
  if (v3.name === 'unwrapWETH9') return { method: v3.name, decoded: {
    amountMinimum: text(v3.args.amountMinimum), recipient: v3.args.recipient === undefined ? 'transaction sender' : address(v3.args.recipient),
  } }
  if (v3.name === 'sweepToken') return { method: v3.name, decoded: {
    token: address(v3.args.token), amountMinimum: text(v3.args.amountMinimum), recipient: v3.args.recipient === undefined ? 'transaction sender' : address(v3.args.recipient),
  } }
  if (v3.name === 'wrapETH') return { method: v3.name, decoded: { mode: 'router-payment', action: 'wrap-native', amount: text(v3.args.value) } }
  if (v3.name === 'pull') return { method: v3.name, decoded: { mode: 'router-payment', action: 'pull-token', token: address(v3.args.token), amount: text(v3.args.value) } }
  if (v3.name === 'unwrapWETH9WithFee') return { method: v3.name, decoded: {
    amountMinimum: text(v3.args.amountMinimum), recipient: v3.args.recipient === undefined ? 'transaction sender' : address(v3.args.recipient), feeBips: text(v3.args.feeBips), feeRecipient: address(v3.args.feeRecipient),
  } }
  if (v3.name === 'sweepTokenWithFee') return { method: v3.name, decoded: {
    token: address(v3.args.token), amountMinimum: text(v3.args.amountMinimum), recipient: v3.args.recipient === undefined ? 'transaction sender' : address(v3.args.recipient), feeBips: text(v3.args.feeBips), feeRecipient: address(v3.args.feeRecipient),
  } }
  if (v3.name === 'getApprovalType') return { method: v3.name, decoded: { mode: 'router-approval-lens', token: address(v3.args.token), amount: text(v3.args.amount) } }
  if (v3.name === 'checkOracleSlippage') {
    const paths = Array.isArray(v3.args.paths)
      ? Array.from(v3.args.paths as string[]).map(path => decodeV3Path(path, false))
      : [decodeV3Path(String(v3.args.path), false)]
    const amounts = v3.args.amounts === undefined ? undefined : Array.from(v3.args.amounts as any[]).map(text)
    if (amounts && amounts.length !== paths.length) throw new Error('oracle path/weight length mismatch')
    return { method: v3.name, decoded: {
      mode: 'oracle-slippage', paths, amounts, maximumTickDivergence: text(v3.args.maximumTickDivergence), secondsAgo: text(v3.args.secondsAgo),
    } }
  }
  if (v3.name.startsWith('approve')) return { method: v3.name, decoded: {
    mode: 'router-approval', token: address(v3.args.token), approvalKind: v3.name,
  } }
  if (v3.name === 'callPositionManager') {
    const child = decodeLegacyUniswapCall(String(v3.args.data), depth + 1)
    if (!child || contractFamily(child) !== 'v3-position-manager') throw new Error('unrecognized nested position-manager call')
    return { method: v3.name, decoded: { calls: 1 }, children: [child] }
  }
  if (v3.name === 'mint' || v3.name === 'increaseLiquidity') {
    const p = v3.args.params
    return { method: v3.name, decoded: {
      mode: 'router-position', action: v3.name, token0: address(p.token0), token1: address(p.token1),
      ...(v3.name === 'mint' ? { fee: text(p.fee), tickLower: text(p.tickLower), tickUpper: text(p.tickUpper), recipient: address(p.recipient) } : { tokenId: text(p.tokenId) }),
      amount0Min: text(p.amount0Min), amount1Min: text(p.amount1Min),
    } }
  }
  if (v3.name.startsWith('selfPermitAllowed')) return { method: v3.name, decoded: {
    mode: 'self-permit', token: address(v3.args.token), permitKind: 'allowed', nonce: text(v3.args.nonce),
    expiry: text(v3.args.expiry), onlyIfNecessary: v3.name.endsWith('IfNecessary'),
  } }
  if (v3.name.startsWith('selfPermit')) return { method: v3.name, decoded: {
    mode: 'self-permit', token: address(v3.args.token), permitKind: 'amount', value: text(v3.args.value),
    deadline: text(v3.args.deadline), onlyIfNecessary: v3.name.endsWith('IfNecessary'),
  } }
  const value = v3.args.params
  const exactOut = v3.name.startsWith('exactOutput')
  const single = v3.name.endsWith('Single')
  return { method: v3.name, decoded: {
    mode: exactOut ? 'exact-output' : 'exact-input',
    path: single
      ? [address(value.tokenIn), `fee ${text(value.fee)}`, address(value.tokenOut)]
      : decodeV3Path(value.path, exactOut),
    recipient: address(value.recipient),
    ...(value.deadline !== undefined ? { deadline: text(value.deadline) } : {}),
    [exactOut ? 'amountOut' : 'amountIn']: text(value[exactOut ? 'amountOut' : 'amountIn']),
    [exactOut ? 'amountInMaximum' : 'amountOutMinimum']: text(value[exactOut ? 'amountInMaximum' : 'amountOutMinimum']),
    ...(single ? { sqrtPriceLimitX96: text(value.sqrtPriceLimitX96) } : {}),
  } }
}

function flatten(call: LegacyUniswapCall): LegacyUniswapCall[] {
  return call.children ? call.children.flatMap(flatten) : [call]
}

function contractFamily(call: LegacyUniswapCall): LegacyContractFamily {
  const value: any = call.decoded
  if (value.positionManager) return 'v3-position-manager'
  if (value.mode === 'v3-position') return 'v3-position-manager'
  if (value.mode === 'add-liquidity' || value.mode === 'remove-liquidity' || value.nativeIn !== undefined || value.nativeOut !== undefined) return 'v2'
  if (call.method === 'multicall' || call.method === 'refundETH' || call.method === 'unwrapWETH9' || call.method === 'sweepToken' || value.mode === 'self-permit') return 'swap-router-02'
  return value.deadline === undefined ? 'swap-router-02' : 'swap-router'
}

function positionManagerCompatible(call: LegacyUniswapCall): boolean {
  if ((call.decoded as any).mode === 'v3-position') return true
  if (call.method === 'multicall') return Boolean(call.children?.length) && call.children!.every(positionManagerCompatible)
  return ['refundETH', 'unwrapWETH9', 'sweepToken', 'selfPermit', 'selfPermitIfNecessary',
    'selfPermitAllowed', 'selfPermitAllowedIfNecessary'].includes(call.method)
}

function swapRouter02Compatible(call: LegacyUniswapCall): boolean {
  if ((call.decoded as any).mode === 'v3-position') return false
  if (call.method === 'callPositionManager') return true
  if (call.method === 'multicall') return Boolean(call.children?.length) && call.children!.every(swapRouter02Compatible)
  return true
}

export function legacyUniswapReportFindings(data: string, chainId?: number, to?: string): {
  findings: EffectFinding[]
  limitations: EffectFinding[]
  complete: boolean
} {
  let call: LegacyUniswapCall | undefined
  try { call = decodeLegacyUniswapCall(data) } catch (error: any) {
    return { findings: [], limitations: [{
      code: 'UNISWAP_LEGACY_CALL_INCOMPLETE', message: error?.message || 'Nested legacy router call is not fully decoded.', severity: 'danger',
    }], complete: false }
  }
  if (!call) return { findings: [], limitations: [], complete: false }
  const deployments = chainId === undefined ? undefined : OFFICIAL_LEGACY_UNISWAP_DEPLOYMENTS[chainId]
  const target = to?.toLowerCase()
  const family = target && deployments?.['v3-position-manager'] === target && positionManagerCompatible(call)
    ? 'v3-position-manager'
    : contractFamily(call)
  const expectedTarget = family === 'swap-router-02' && !swapRouter02Compatible(call) ? undefined : deployments?.[family]
  const official = Boolean(expectedTarget && target && expectedTarget === target)
  const findings: EffectFinding[] = [{
    code: 'UNISWAP_LEGACY_ROUTER_CALL', message: `${official ? FAMILY_LABELS[family] : 'Uniswap-compatible router'} call: ${call.method}.`, severity: 'info',
  }]
  for (const item of flatten(call)) {
    const value: any = item.decoded
    if (value.mode === 'exact-input') findings.push({
      code: 'UNISWAP_EXACT_INPUT_SWAP',
      message: `${item.method} spends ${value.nativeIn ? 'the transaction native value' : `${value.amountIn} base units`} for at least ${value.amountOutMinimum} base units; path ${value.path.join(' → ')}; recipient ${value.recipient}; deadline ${value.deadline ?? 'set by enclosing multicall or absent'}.`,
      severity: 'warning',
    })
    if (value.mode === 'exact-output') findings.push({
      code: 'UNISWAP_EXACT_OUTPUT_SWAP',
      message: `${item.method} receives ${value.amountOut} base units while spending at most ${value.nativeIn ? 'the transaction native value' : `${value.amountInMaximum} base units`}; path ${value.path.join(' → ')}; recipient ${value.recipient}; deadline ${value.deadline ?? 'set by enclosing multicall or absent'}.`,
      severity: 'warning',
    })
    if (value.mode === 'add-liquidity') findings.push({
      code: 'UNISWAP_V2_ADD_LIQUIDITY',
      message: `${item.method} supplies up to ${value.amountADesired} ${value.tokenA} and ${value.amountBDesired} ${value.tokenB}, accepting no less than ${value.amountAMin} and ${value.amountBMin}; LP tokens go to ${value.recipient}; deadline ${value.deadline}.`,
      severity: 'warning',
    })
    if (value.mode === 'remove-liquidity') findings.push({
      code: 'UNISWAP_V2_REMOVE_LIQUIDITY',
      message: `${item.method} burns ${value.liquidity} LP units for at least ${value.amountAMin} ${value.tokenA} and ${value.amountBMin} ${value.tokenB}; proceeds go to ${value.recipient}; deadline ${value.deadline}${value.permitIncluded ? `; embedded permit${value.approveMax ? ' approves the maximum LP amount' : ' approves the requested LP amount'}` : ''}.`,
      severity: 'warning',
    })
    if (value.mode === 'self-permit') findings.push({
      code: 'UNISWAP_SELF_PERMIT',
      message: value.permitKind === 'amount'
        ? `${item.method} authorizes this router to spend ${value.value} base units of ${value.token} until ${value.deadline}${value.onlyIfNecessary ? ' only when allowance is insufficient' : ''}.`
        : `${item.method} submits an allowed-style permit for ${value.token}, nonce ${value.nonce}, expiry ${value.expiry}${value.onlyIfNecessary ? ' only when allowance is insufficient' : ''}.`,
      severity: 'warning',
    })
    if (value.mode === 'router-approval') findings.push({
      code: 'UNISWAP_ROUTER_TOKEN_APPROVAL',
      message: `${item.method} changes the SwapRouter02 contract's allowance of ${value.token}; this is router-owned authority, not approval to spend the user's wallet tokens.`,
      severity: 'warning',
    })
    if (value.mode === 'router-approval-lens') findings.push({
      code: 'UNISWAP_ROUTER_APPROVAL_CHECK', message: `Check which router-owned approval form ${value.token} requires for ${value.amount} base units; this does not grant wallet-token authority.`, severity: 'info',
    })
    if (value.mode === 'router-payment') findings.push({
      code: value.action === 'wrap-native' ? 'UNISWAP_WRAP_NATIVE' : 'UNISWAP_PULL_TOKEN',
      message: value.action === 'wrap-native'
        ? `Wrap ${value.amount} wei of the router's native-currency balance into WETH.`
        : `Pull ${value.amount} base units of ${value.token} from the transaction sender into the router using existing allowance.`,
      severity: 'warning',
    })
    if (value.mode === 'oracle-slippage') findings.push({
      code: 'UNISWAP_ORACLE_SLIPPAGE_CHECK',
      message: `Require ${value.paths.length} v3 path${value.paths.length === 1 ? '' : 's'} to remain within ${value.maximumTickDivergence} ticks of the ${value.secondsAgo}-second oracle reference${value.amounts ? `, weighted by ${value.amounts.join('/')}` : ''}: ${value.paths.map((path: string[]) => path.join(' → ')).join('; ')}.`,
      severity: 'info',
    })
    if (value.mode === 'router-position') findings.push({
      code: `UNISWAP_ROUTER_POSITION_${String(value.action).toUpperCase()}`,
      message: value.action === 'mint'
        ? `Forward a v3 position mint for ${value.token0}/${value.token1}, fee ${value.fee}, ticks ${value.tickLower}..${value.tickUpper}, minima ${value.amount0Min}/${value.amount1Min}; NFT recipient ${value.recipient}.`
        : `Forward a v3 liquidity increase for position ${value.tokenId} (${value.token0}/${value.token1}), minima ${value.amount0Min}/${value.amount1Min}.`,
      severity: 'warning',
    })
    if (value.mode === 'v3-position') findings.push({
      code: `UNISWAP_V3_POSITION_${String(value.action).toUpperCase()}`,
      message: value.action === 'mint'
        ? `Mint v3 position ${value.token0}/${value.token1} fee ${value.fee}, ticks ${value.tickLower}..${value.tickUpper}; supply up to ${value.amount0Desired}/${value.amount1Desired}, minima ${value.amount0Min}/${value.amount1Min}; NFT recipient ${value.recipient}; deadline ${value.deadline}.`
        : value.action === 'increase'
          ? `Increase v3 position ${value.tokenId}: supply up to ${value.amount0Desired}/${value.amount1Desired}, minima ${value.amount0Min}/${value.amount1Min}; deadline ${value.deadline}.`
          : value.action === 'decrease'
            ? `Decrease v3 position ${value.tokenId} by ${value.liquidity}; minima ${value.amount0Min}/${value.amount1Min}; deadline ${value.deadline}.`
            : value.action === 'collect'
              ? `Collect up to ${value.amount0Max}/${value.amount1Max} from v3 position ${value.tokenId} to ${value.recipient}.`
              : value.action === 'permit'
                ? `Permit ${value.spender} to control v3 position NFT ${value.tokenId} until ${value.deadline}.`
                : value.action === 'approve'
                  ? `Approve ${value.spender} to control v3 position NFT ${value.tokenId}.`
                  : value.action === 'approve-all'
                    ? `Set operator ${value.operator} approval to ${value.approved} for every v3 position NFT.`
                    : value.action === 'transfer'
                      ? `Transfer v3 position NFT ${value.tokenId} from ${value.from} to ${value.recipient}.`
                      : value.action === 'initialize-pool'
                        ? `Create or initialize v3 pool ${value.token0}/${value.token1}, fee ${value.fee}, sqrtPriceX96 ${value.sqrtPriceX96}.`
                        : value.action === 'unwrap-weth'
                          ? `Unwrap at least ${value.amountMinimum} WETH and send native currency to ${value.recipient}.`
                          : value.action === 'sweep-token'
                            ? `Sweep at least ${value.amountMinimum} base units of ${value.token} to ${value.recipient}.`
                            : value.action === 'refund-native'
                              ? 'Refund all native currency held by the position manager to the transaction sender.'
                              : `Burn emptied v3 position NFT ${value.tokenId}.`,
      severity: 'warning',
    })
    if (item.method === 'unwrapWETH9') findings.push({
      code: 'UNISWAP_UNWRAP_WETH', message: `Unwrap WETH and send at least ${value.amountMinimum} wei to ${value.recipient}.`, severity: 'info',
    })
    if (item.method === 'sweepToken') findings.push({
      code: 'UNISWAP_SWEEP', message: `Sweep at least ${value.amountMinimum} base units of ${value.token} to ${value.recipient}.`, severity: 'info',
    })
    if (item.method === 'unwrapWETH9WithFee') findings.push({
      code: 'UNISWAP_UNWRAP_WETH_WITH_FEE', message: `Unwrap at least ${value.amountMinimum} WETH; send proceeds to ${value.recipient} after ${value.feeBips} bips to ${value.feeRecipient}.`, severity: 'warning',
    })
    if (item.method === 'sweepTokenWithFee') findings.push({
      code: 'UNISWAP_SWEEP_WITH_FEE', message: `Sweep at least ${value.amountMinimum} base units of ${value.token}; send proceeds to ${value.recipient} after ${value.feeBips} bips to ${value.feeRecipient}.`, severity: 'warning',
    })
  }
  const limitations: EffectFinding[] = official ? [] : [{
    code: 'UNISWAP_ROUTER_IDENTITY_UNVERIFIED',
    message: `The target is not the authenticated official ${FAMILY_LABELS[family]} deployment for this chain; compatible calldata or another Uniswap contract address does not prove the required contract identity.`,
    severity: 'danger',
  }]
  // Compatible calldata at an arbitrary address does not establish protocol
  // identity. Keep the decoded warning, but refuse completeness/promotion.
  return { findings, limitations, complete: official }
}
