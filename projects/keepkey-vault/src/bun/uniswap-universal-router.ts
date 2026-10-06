import { utils as ethersUtils } from 'ethers'

import type { EffectFinding } from '../shared/transaction-effects'
import { legacyUniswapReportFindings } from './uniswap-legacy-router'

const EXECUTE = new ethersUtils.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
  'function execute(bytes commands, bytes[] inputs)',
  'function executeSigned(bytes commands, bytes[] inputs, bytes32 intent, bytes32 data, bool verifySender, bytes32 nonce, bytes signature, uint256 deadline)',
])

const V3_POSITION_MANAGER = new ethersUtils.Interface([
  'function permit(address spender,uint256 tokenId,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function decreaseLiquidity(tuple(uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params)',
  'function collect(tuple(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params)',
  'function burn(uint256 tokenId)',
])
const V4_POSITION_MANAGER = new ethersUtils.Interface([
  'function modifyLiquidities(bytes unlockData,uint256 deadline)',
])

const COMMAND_NAMES: Record<number, string> = {
  0x00: 'V3_SWAP_EXACT_IN', 0x01: 'V3_SWAP_EXACT_OUT',
  0x02: 'PERMIT2_TRANSFER_FROM', 0x03: 'PERMIT2_PERMIT_BATCH',
  0x04: 'SWEEP', 0x05: 'TRANSFER', 0x06: 'PAY_PORTION',
  0x07: 'PAY_PORTION_FULL_PRECISION', 0x08: 'V2_SWAP_EXACT_IN',
  0x09: 'V2_SWAP_EXACT_OUT', 0x0a: 'PERMIT2_PERMIT',
  0x0b: 'WRAP_ETH', 0x0c: 'UNWRAP_WETH',
  0x0d: 'PERMIT2_TRANSFER_FROM_BATCH', 0x0e: 'BALANCE_CHECK_ERC20',
  0x10: 'V4_SWAP', 0x11: 'V3_POSITION_MANAGER_PERMIT',
  0x12: 'V3_POSITION_MANAGER_CALL', 0x13: 'V4_INITIALIZE_POOL',
  0x14: 'V4_POSITION_MANAGER_CALL', 0x21: 'EXECUTE_SUB_PLAN',
  0x40: 'ACROSS_V4_DEPOSIT_V3',
}

const V1_COMMAND_NAMES: Record<number, string> = {
  ...Object.fromEntries(Object.entries(COMMAND_NAMES).filter(([id]) => Number(id) < 0x10)),
  0x10: 'SEAPORT_V1_5', 0x11: 'LOOKS_RARE_V2', 0x12: 'NFTX', 0x13: 'CRYPTOPUNKS',
  0x15: 'OWNER_CHECK_721', 0x16: 'OWNER_CHECK_1155', 0x17: 'SWEEP_ERC721',
  0x18: 'X2Y2_721', 0x19: 'SUDOSWAP', 0x1a: 'NFT20', 0x1b: 'X2Y2_1155',
  0x1c: 'FOUNDATION', 0x1d: 'SWEEP_ERC1155', 0x1e: 'ELEMENT_MARKET',
  0x20: 'SEAPORT_V1_4', 0x21: 'EXECUTE_SUB_PLAN', 0x22: 'APPROVE_ERC20',
}

const V4_ACTION_NAMES: Record<number, string> = {
  0x06: 'SWAP_EXACT_IN_SINGLE', 0x07: 'SWAP_EXACT_IN',
  0x08: 'SWAP_EXACT_OUT_SINGLE', 0x09: 'SWAP_EXACT_OUT',
  0x0b: 'SETTLE', 0x0c: 'SETTLE_ALL', 0x0e: 'TAKE',
  0x0f: 'TAKE_ALL', 0x10: 'TAKE_PORTION',
}

const POOL_KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const PATH_KEY = 'tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)'

// Vendored from Uniswap/universal-router deploy-addresses. These labels prove
// only that the target address is in the reviewed manifest; runtime code-hash
// binding remains a separate evidence requirement.
const OFFICIAL_ROUTERS: Record<number, Record<string, string>> = {
  1: {
    '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'V1',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'V1.2 V2 Support',
    '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'V2',
    '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca': 'V2.1.1',
    '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85': 'V2.1.2',
    '0xab863e752bf67d8dcdd929eaae9be9dc83fb3bbb': 'V2.2.0 Permissioned Pools',
  },
  10: { '0xc09255d86db563cbc11c2fcf4a0c512e160111b4': 'V2.1.2' },
  56: { '0xdc264714f68d84cf29bc605589405e78bdbe7c9f': 'V2.1.2' },
  130: { '0xd1b797d92d87b688193a2b976efc8d577d204343': 'V2.1.2' },
  137: { '0xdc264714f68d84cf29bc605589405e78bdbe7c9f': 'V2.1.2' },
  143: { '0xa6ce4f10d83dbddac17e68e1837ca9ce6a1b596e': 'V2.1.2' },
  196: { '0x1cd182c94fcf42277b80dbb9060f88024809e61e': 'V2.1.2' },
  480: { '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f': 'V2.1.2' },
  999: { '0xed270a1bcdc63cf1356d695e7f40961d4819d6bf': 'V2.1.2' },
  1301: { '0xdf38f24fe153761634be942f9d859f3dba857e95': 'V2.1.2' },
  1868: { '0x661e93cca42afacb172121ef892830ca3b70f08d': 'V2.1.2' },
  4217: { '0x182a927119d56008d921126764bf884221b10f59': 'V2.1.2' },
  4326: { '0xaedd1cf4c14e833140a61e9c0d2b73a64795c823': 'V2.1.2' },
  4663: { '0x204faca1764b154221e35c0d20abb3c525710498': 'V2.1.2' },
  5042: { '0x8702463e73f74d0b6765abceb314ef07acb92650': 'V2.1.2' },
  8453: { '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40': 'V2.1.2' },
  84532: { '0x8702463e73f74d0b6765abceb314ef07acb92650': 'V2.1.2' },
  42161: { '0x2d01411773c8c24805306e89a41f7855c3c4fe65': 'V2.1.2' },
  42220: { '0xe2023f3fa515cf070e07fd9d51c1d236e07843f4': 'V2.1.2' },
  43114: { '0x661e93cca42afacb172121ef892830ca3b70f08d': 'V2.1.2' },
  57073: {
    '0x661e93cca42afacb172121ef892830ca3b70f08d': 'V2.1.2',
    '0x8bbcaeb326ad590521a921c9e457ee09f336b48c': 'V2.2.0 Permissioned Pools',
  },
  59144: { '0xdc264714f68d84cf29bc605589405e78bdbe7c9f': 'V2.1.2' },
  81457: { '0x661e93cca42afacb172121ef892830ca3b70f08d': 'V2.1.2' },
  11155111: {
    '0x7e4f6c5e954da5c61b3423d81e2277431ac043f3': 'V2.1.2',
    '0x5093f1cded83d99ffed6602da6260672ae16787c': 'V2.2.0 Permissioned Pools',
  },
  7777777: { '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f': 'V2.1.2' },
}

export function officialUniversalRouterVersion(chainId?: number, to?: string): string | undefined {
  return chainId && to ? OFFICIAL_ROUTERS[chainId]?.[to.toLowerCase()] : undefined
}

export interface PermissionedV4Reference { currency: string; hooks?: string }

/** Addresses whose meaning can depend on the 2.2 permissions-adapter factory. */
export function permissionedV4References(data: string): PermissionedV4Reference[] {
  const decoded = decodeUniversalRouter(data)
  if (!decoded) return []
  const refs: PermissionedV4Reference[] = []
  const add = (currency?: string, hooks?: string) => {
    if (currency && /^0x[0-9a-f]{40}$/i.test(currency) && currency !== '0x0000000000000000000000000000000000000000') {
      refs.push({ currency: currency.toLowerCase(), ...(hooks ? { hooks: hooks.toLowerCase() } : {}) })
    }
  }
  const visit = (commands: UniversalRouterCommand[]) => {
    for (const command of commands) {
      const value = command.decoded as any
      if (command.id === 0x04) add(value?.token)
      if (command.id === 0x21 && value?.commands) visit(value.commands)
      if (command.id !== 0x10) continue
      for (const action of value?.actions || []) {
        const detail = action.decoded
        if (detail?.poolKey) {
          add(detail.poolKey.currency0, detail.poolKey.hooks)
          add(detail.poolKey.currency1, detail.poolKey.hooks)
        }
        add(detail?.currencyIn)
        add(detail?.currencyOut)
        add(detail?.currency)
        for (const hop of detail?.path || []) add(hop.intermediateCurrency, hop.hooks)
      }
    }
  }
  visit(decoded.commands)
  return Array.from(new Map(refs.map(ref => [`${ref.currency}:${ref.hooks || ''}`, ref])).values())
}

export interface UniversalRouterCommand {
  index: number
  id: number
  name: string
  allowRevert: boolean
  decoded?: Record<string, unknown>
  decodeError?: string
}

export interface UniversalRouterDecode {
  selector: string
  deadline?: string
  signedExecution?: {
    intent: string
    data: string
    verifySender: boolean
    nonce: string
    signatureBytes: number
  }
  commands: UniversalRouterCommand[]
  complete: boolean
}

interface V4Action {
  index: number
  id: number
  name: string
  decoded?: Record<string, unknown>
  decodeError?: string
}

const text = (value: any) => value?.toString?.() ?? String(value)
const CONTRACT_BALANCE = (1n << 255n).toString()
const exactInputAmount = (value: string) => value === CONTRACT_BALANCE
  ? "the router's entire current token balance (CONTRACT_BALANCE sentinel)"
  : `${value} base units`
const address = (value: any) => String(value).toLowerCase()
const addresses = (value: any[]) => value.map(address)
const poolKey = (value: any) => ({
  currency0: address(value.currency0 ?? value[0]), currency1: address(value.currency1 ?? value[1]),
  fee: text(value.fee ?? value[2]), tickSpacing: text(value.tickSpacing ?? value[3]),
  hooks: address(value.hooks ?? value[4]),
})
const pathKey = (value: any) => ({
  intermediateCurrency: address(value.intermediateCurrency ?? value[0]), fee: text(value.fee ?? value[1]),
  tickSpacing: text(value.tickSpacing ?? value[2]), hooks: address(value.hooks ?? value[3]),
  hookDataBytes: (String(value.hookData ?? value[4]).length - 2) / 2,
})
const displayRecipient = (value: string) => {
  if (value === '0x0000000000000000000000000000000000000001') return 'transaction sender (router sentinel 0x…01)'
  if (value === '0x0000000000000000000000000000000000000002') return 'router itself (router sentinel 0x…02)'
  return value
}
const permitDetail = (value: any) => ({
  token: address(value.token ?? value[0]), amount: text(value.amount ?? value[1]),
  expiration: text(value.expiration ?? value[2]), nonce: text(value.nonce ?? value[3]),
})

function decodeExact(types: string[], input: string): ethersUtils.Result {
  const decoded = ethersUtils.defaultAbiCoder.decode(types, input)
  const canonicalInput = `0x${input.slice(2).toLowerCase()}`
  const reencoded = ethersUtils.defaultAbiCoder.encode(types, Array.from(decoded)).toLowerCase()
  if (reencoded !== canonicalInput) throw new Error('non-canonical or trailing ABI data')
  return decoded
}

function parseExactTransaction(iface: ethersUtils.Interface, input: string): ethersUtils.TransactionDescription {
  const parsed = iface.parseTransaction({ data: input })
  const reencoded = iface.encodeFunctionData(parsed.sighash, Array.from(parsed.args)).toLowerCase()
  if (reencoded !== input.toLowerCase()) throw new Error('non-canonical or trailing function calldata')
  return parsed
}

function decodeV3PositionManager(input: string, permitOnly: boolean): Record<string, unknown> {
  const parsed = parseExactTransaction(V3_POSITION_MANAGER, input)
  if (permitOnly && parsed.name !== 'permit') throw new Error('only ERC-721 permit is allowed')
  if (!permitOnly && !['decreaseLiquidity', 'collect', 'burn'].includes(parsed.name)) {
    throw new Error('only decreaseLiquidity, collect, or burn is allowed')
  }
  if (parsed.name === 'permit') return {
    method: parsed.name, spender: address(parsed.args.spender), tokenId: text(parsed.args.tokenId),
    deadline: text(parsed.args.deadline), signatureV: text(parsed.args.v),
  }
  if (parsed.name === 'burn') return { method: parsed.name, tokenId: text(parsed.args.tokenId) }
  const value = parsed.args.params
  if (parsed.name === 'decreaseLiquidity') return {
    method: parsed.name, tokenId: text(value.tokenId), liquidity: text(value.liquidity),
    amount0Min: text(value.amount0Min), amount1Min: text(value.amount1Min), deadline: text(value.deadline),
  }
  return {
    method: parsed.name, tokenId: text(value.tokenId), recipient: address(value.recipient),
    amount0Max: text(value.amount0Max), amount1Max: text(value.amount1Max),
  }
}

function decodeSwap(input: string, pathType: 'bytes' | 'address[]'): {
  values: ethersUtils.Result
  currentLayout: boolean
} {
  const current = ['address', 'uint256', 'uint256', pathType, 'bool', 'uint256[]']
  try { return { values: decodeExact(current, input), currentLayout: true } } catch { /* legacy layout below */ }
  return { values: decodeExact(current.slice(0, 5), input), currentLayout: false }
}

function decodeV4Action(id: number, input: string): Record<string, unknown> | undefined {
  if (id === 0x06 || id === 0x08) {
    const fieldNames = id === 0x06
      ? ['amountIn', 'amountOutMinimum']
      : ['amountOut', 'amountInMaximum']
    const [value] = decodeExact([
      `tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 ${fieldNames[0]},uint128 ${fieldNames[1]},uint256 minHopPriceX36,bytes hookData)`,
    ], input)
    return {
      poolKey: poolKey(value.poolKey), zeroForOne: value.zeroForOne,
      [fieldNames[0]]: text(value[fieldNames[0]]), [fieldNames[1]]: text(value[fieldNames[1]]),
      minHopPriceX36: text(value.minHopPriceX36), hookDataBytes: (String(value.hookData).length - 2) / 2,
    }
  }
  if (id === 0x07 || id === 0x09) {
    const fieldNames = id === 0x07
      ? ['currencyIn', 'amountIn', 'amountOutMinimum']
      : ['currencyOut', 'amountOut', 'amountInMaximum']
    const [value] = decodeExact([
      `tuple(address ${fieldNames[0]},${PATH_KEY}[] path,uint256[] minHopPriceX36,uint128 ${fieldNames[1]},uint128 ${fieldNames[2]})`,
    ], input)
    return {
      [fieldNames[0]]: address(value[fieldNames[0]]), path: Array.from(value.path).map(pathKey),
      minHopPriceX36: Array.from(value.minHopPriceX36).map(text),
      [fieldNames[1]]: text(value[fieldNames[1]]), [fieldNames[2]]: text(value[fieldNames[2]]),
    }
  }
  if (id === 0x0b) {
    const [currency, amount, payerIsUser] = decodeExact(['address', 'uint256', 'bool'], input)
    return { currency: address(currency), amount: text(amount), payerIsUser }
  }
  if (id === 0x0c || id === 0x0f) {
    const [currency, amount] = decodeExact(['address', 'uint256'], input)
    return { currency: address(currency), [id === 0x0c ? 'maxAmount' : 'minAmount']: text(amount) }
  }
  if (id === 0x0e || id === 0x10) {
    const [currency, recipient, amount] = decodeExact(['address', 'address', 'uint256'], input)
    return { currency: address(currency), recipient: address(recipient), [id === 0x0e ? 'amount' : 'bips']: text(amount) }
  }
  return undefined
}

function decodeV4Actions(input: string): { actions: V4Action[]; complete: boolean } {
  const [actionsHex, params] = decodeExact(['bytes', 'bytes[]'], input)
  const actionBytes = Buffer.from(String(actionsHex).slice(2), 'hex')
  const inputs = Array.from(params as string[])
  if (actionBytes.length !== inputs.length) throw new Error('v4 action/parameter length mismatch')
  const actions = inputs.map((item, index): V4Action => {
    const id = actionBytes[index]
    const action: V4Action = { index, id, name: V4_ACTION_NAMES[id] || `UNSUPPORTED_0x${id.toString(16).padStart(2, '0')}` }
    try {
      const decoded = decodeV4Action(id, item)
      if (decoded) action.decoded = decoded
      else action.decodeError = 'action is not supported by the Universal Router V4SwapRouter'
    } catch (error: any) {
      action.decodeError = `invalid ${action.name} input: ${error?.reason || error?.message || 'decode failed'}`
    }
    return action
  })
  return { actions, complete: actions.every(action => action.decoded && !action.decodeError) }
}

function decodeV4PositionAction(id: number, input: string): Record<string, unknown> | undefined {
  if (id === 0x02 || id === 0x05) {
    const types = id === 0x02
      ? [POOL_KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes']
      : [POOL_KEY, 'int24', 'int24', 'uint128', 'uint128', 'address', 'bytes']
    const values = decodeExact(types, input)
    const offset = id === 0x02 ? 1 : 0
    return {
      poolKey: poolKey(values[0]), tickLower: text(values[1]), tickUpper: text(values[2]),
      ...(id === 0x02 ? { liquidity: text(values[3]) } : {}),
      amount0Max: text(values[3 + offset]), amount1Max: text(values[4 + offset]),
      owner: address(values[5 + offset]), hookDataBytes: (String(values[6 + offset]).length - 2) / 2,
      deprecated: id === 0x05,
    }
  }
  if (id === 0x0b) return decodeV4Action(id, input)
  if (id === 0x0d) {
    const [currency0, currency1] = decodeExact(['address', 'address'], input)
    return { currency0: address(currency0), currency1: address(currency1) }
  }
  if (id === 0x0e) return decodeV4Action(id, input)
  if (id === 0x11) {
    const [currency0, currency1, recipient] = decodeExact(['address', 'address', 'address'], input)
    return { currency0: address(currency0), currency1: address(currency1), recipient: address(recipient) }
  }
  if (id === 0x12) {
    const [currency] = decodeExact(['address'], input)
    return { currency: address(currency) }
  }
  if (id === 0x13) {
    const [currency, amountMax] = decodeExact(['address', 'uint256'], input)
    return { currency: address(currency), amountMax: text(amountMax) }
  }
  if (id === 0x14) {
    const [currency, recipient] = decodeExact(['address', 'address'], input)
    return { currency: address(currency), recipient: address(recipient) }
  }
  if (id === 0x15 || id === 0x16) {
    const [amount] = decodeExact(['uint256'], input)
    return { amount: text(amount) }
  }
  return undefined
}

function decodeV4PositionManager(input: string): Record<string, unknown> {
  const parsed = parseExactTransaction(V4_POSITION_MANAGER, input)
  const [actionsHex, params] = decodeExact(['bytes', 'bytes[]'], parsed.args.unlockData)
  const actionBytes = Buffer.from(String(actionsHex).slice(2), 'hex')
  const inputs = Array.from(params as string[])
  if (actionBytes.length !== inputs.length) throw new Error('v4 position action/parameter length mismatch')
  const actions = inputs.map((item, index): V4Action => {
    const id = actionBytes[index]
    const action: V4Action = { index, id, name: ({
      0x02: 'MINT_POSITION', 0x05: 'MINT_POSITION_FROM_DELTAS', 0x0b: 'SETTLE',
      0x0d: 'SETTLE_PAIR', 0x0e: 'TAKE', 0x11: 'TAKE_PAIR', 0x12: 'CLOSE_CURRENCY',
      0x13: 'CLEAR_OR_TAKE', 0x14: 'SWEEP', 0x15: 'WRAP', 0x16: 'UNWRAP',
    } as Record<number, string>)[id] || `FORBIDDEN_0x${id.toString(16).padStart(2, '0')}` }
    try {
      const decoded = decodeV4PositionAction(id, item)
      if (decoded) action.decoded = decoded
      else action.decodeError = 'action is forbidden or unsupported by the Universal Router position-manager gate'
    } catch (error: any) {
      action.decodeError = `invalid ${action.name} input: ${error?.reason || error?.message || 'decode failed'}`
    }
    return action
  })
  return { method: parsed.name, deadline: text(parsed.args.deadline), actions, complete: actions.every(a => a.decoded && !a.decodeError) }
}

function decodeCommand(id: number, input: string, dialect: 'current' | 'v1'): Record<string, unknown> | undefined {
  switch (id) {
    case 0x00:
    case 0x01: {
      const { values, currentLayout } = decodeSwap(input, 'bytes')
      const [recipient, amountA, amountB, path, payerIsUser, minHopPriceX36] = values
      return {
        recipient: address(recipient),
        [id === 0x00 ? 'amountIn' : 'amountOut']: text(amountA),
        [id === 0x00 ? 'amountOutMin' : 'amountInMax']: text(amountB),
        path: String(path).toLowerCase(), payerIsUser,
        layout: currentLayout ? 'v2.1.2' : 'legacy',
        ...(currentLayout ? { minHopPriceX36: Array.from(minHopPriceX36).map(text) } : {}),
      }
    }
    case 0x02: {
      const [token, recipient, amount] = decodeExact(['address', 'address', 'uint160'], input)
      return { token: address(token), recipient: address(recipient), amount: text(amount) }
    }
    case 0x03: {
      const [permit, signature] = decodeExact([
        'tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline)',
        'bytes',
      ], input)
      return {
        details: Array.from(permit.details).map(permitDetail), spender: address(permit.spender),
        sigDeadline: text(permit.sigDeadline), signatureBytes: (String(signature).length - 2) / 2,
      }
    }
    case 0x04:
    case 0x0c: {
      const [tokenOrRecipient, recipientOrAmount, amountMinMaybe] = id === 0x04
        ? decodeExact(['address', 'address', 'uint256'], input)
        : decodeExact(['address', 'uint256'], input)
      return id === 0x04
        ? { token: address(tokenOrRecipient), recipient: address(recipientOrAmount), amountMin: text(amountMinMaybe) }
        : { recipient: address(tokenOrRecipient), amountMin: text(recipientOrAmount) }
    }
    case 0x05: {
      const [token, recipient, value] = decodeExact(['address', 'address', 'uint256'], input)
      return { token: address(token), recipient: address(recipient), value: text(value) }
    }
    case 0x06:
    case 0x07: {
      const [token, recipient, bips] = decodeExact(['address', 'address', 'uint256'], input)
      return { token: address(token), recipient: address(recipient), [id === 0x06 ? 'bips' : 'portion']: text(bips) }
    }
    case 0x08:
    case 0x09: {
      const { values, currentLayout } = decodeSwap(input, 'address[]')
      const [recipient, amountA, amountB, path, payerIsUser, minHopPriceX36] = values
      return {
        recipient: address(recipient),
        [id === 0x08 ? 'amountIn' : 'amountOut']: text(amountA),
        [id === 0x08 ? 'amountOutMin' : 'amountInMax']: text(amountB),
        path: addresses(path), payerIsUser,
        layout: currentLayout ? 'v2.1.2' : 'legacy',
        ...(currentLayout ? { minHopPriceX36: Array.from(minHopPriceX36).map(text) } : {}),
      }
    }
    case 0x0b: {
      const [recipient, amount] = decodeExact(['address', 'uint256'], input)
      return { recipient: address(recipient), amount: text(amount) }
    }
    case 0x0a: {
      const [permit, signature] = decodeExact([
        'tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)',
        'bytes',
      ], input)
      return {
        details: permitDetail(permit.details), spender: address(permit.spender),
        sigDeadline: text(permit.sigDeadline), signatureBytes: (String(signature).length - 2) / 2,
      }
    }
    case 0x0d: {
      const [details] = decodeExact([
        'tuple(address from,address to,uint160 amount,address token)[]',
      ], input)
      return {
        transfers: Array.from(details).map((value: any) => ({
          from: address(value.from), to: address(value.to), amount: text(value.amount), token: address(value.token),
        })),
      }
    }
    case 0x0e: {
      const [owner, token, amountMin] = decodeExact(['address', 'address', 'uint256'], input)
      return { owner: address(owner), token: address(token), amountMin: text(amountMin) }
    }
    case 0x10:
      return decodeV4Actions(input)
    case 0x11:
      return decodeV3PositionManager(input, true)
    case 0x12:
      return decodeV3PositionManager(input, false)
    case 0x13: {
      const [key, sqrtPriceX96] = decodeExact([POOL_KEY, 'uint160'], input)
      return { poolKey: poolKey(key), sqrtPriceX96: text(sqrtPriceX96) }
    }
    case 0x14:
      return decodeV4PositionManager(input)
    case 0x40: {
      const [value] = decodeExact([
        'tuple(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message,bool useNative)',
      ], input)
      return {
        depositor: address(value.depositor), recipient: address(value.recipient), inputToken: address(value.inputToken),
        outputToken: address(value.outputToken), inputAmount: text(value.inputAmount), outputAmount: text(value.outputAmount),
        destinationChainId: text(value.destinationChainId), exclusiveRelayer: address(value.exclusiveRelayer),
        quoteTimestamp: text(value.quoteTimestamp), fillDeadline: text(value.fillDeadline),
        exclusivityDeadline: text(value.exclusivityDeadline), messageBytes: (String(value.message).length - 2) / 2,
        useNative: value.useNative,
      }
    }
    case 0x21: {
      const [commands, inputs] = decodeExact(['bytes', 'bytes[]'], input)
      const nested = decodeUniversalRouter(EXECUTE.encodeFunctionData('execute(bytes,bytes[])', [commands, inputs]), dialect)
      if (!nested) throw new Error('invalid nested subplan')
      return { commands: nested.commands, complete: nested.complete }
    }
    default:
      return undefined
  }
}

/** Decode only the Universal Router's outer command program and bounded core commands. */
export function decodeUniversalRouter(data: string, dialect: 'current' | 'v1' = 'current'): UniversalRouterDecode | undefined {
  if (!/^0x[0-9a-f]+$/i.test(data) || data.length < 10) return undefined
  const selector = data.slice(0, 10).toLowerCase()
  let parsed: ethersUtils.TransactionDescription
  try { parsed = parseExactTransaction(EXECUTE, data) } catch { return undefined }
  const commandsHex = String(parsed.args.commands)
  const commandBytes = Buffer.from(commandsHex.slice(2), 'hex')
  const inputs = Array.from(parsed.args.inputs as string[])
  if (commandBytes.length !== inputs.length) throw new Error('Universal Router command/input length mismatch')
  const commands = inputs.map((input, index): UniversalRouterCommand => {
    const raw = commandBytes[index]
    const id = raw & (dialect === 'v1' ? 0x3f : 0x7f)
    const names = dialect === 'v1' ? V1_COMMAND_NAMES : COMMAND_NAMES
    const item: UniversalRouterCommand = {
      index, id, name: names[id] || `UNKNOWN_0x${id.toString(16).padStart(2, '0')}`,
      allowRevert: Boolean(raw & 0x80),
    }
    try {
      const decoded = decodeCommand(id, input, dialect)
      if (decoded) item.decoded = decoded
      else item.decodeError = names[id] ? 'command semantics not implemented' : 'unknown command'
    } catch (error: any) {
      item.decodeError = `invalid ${item.name} input: ${error?.reason || error?.message || 'decode failed'}`
    }
    return item
  })
  return {
    selector,
    ...(parsed.args.deadline !== undefined ? { deadline: text(parsed.args.deadline) } : {}),
    ...(parsed.name === 'executeSigned' ? { signedExecution: {
      intent: String(parsed.args.intent).toLowerCase(), data: String(parsed.args.data).toLowerCase(),
      verifySender: parsed.args.verifySender, nonce: String(parsed.args.nonce).toLowerCase(),
      signatureBytes: (String(parsed.args.signature).length - 2) / 2,
    } } : {}),
    commands,
    complete: commands.every(command => command.decoded && !command.decodeError
      && ((command.id !== 0x21 && command.id !== 0x10 && command.id !== 0x14) || command.decoded.complete === true)),
  }
}

export function universalRouterReportFindings(
  data: string | undefined,
  chainId?: number,
  to?: string,
): {
  findings: EffectFinding[]
  limitations: EffectFinding[]
  complete: boolean
} {
  if (!data) return { findings: [], limitations: [], complete: false }
  const routerVersion = officialUniversalRouterVersion(chainId, to)
  const dialect = routerVersion?.startsWith('V1') ? 'v1' : 'current'
  let decoded: UniversalRouterDecode | undefined
  try { decoded = decodeUniversalRouter(data, dialect) } catch (error: any) {
    return { findings: [], limitations: [{
      code: 'UNISWAP_UNIVERSAL_ROUTER_MALFORMED',
      message: error?.message || 'Universal Router calldata is malformed.', severity: 'danger',
    }], complete: false }
  }
  if (!decoded) return legacyUniswapReportFindings(data, chainId, to)
  const supportedRouterDialect = !routerVersion || ['V1', 'V1.2 V2 Support', 'V2', 'V2.1.1', 'V2.1.2', 'V2.2.0 Permissioned Pools'].includes(routerVersion)
  const sequence = decoded.commands.map(command => `${command.allowRevert ? 'ALLOW_REVERT ' : ''}${command.name}`).join(' → ')
  const findings: EffectFinding[] = [{
    code: 'UNISWAP_UNIVERSAL_ROUTER_COMMANDS',
    message: `Transaction bytes encode ${decoded.commands.length} ${routerVersion ? `Uniswap Universal Router ${routerVersion}` : 'Universal Router-format'} command${decoded.commands.length === 1 ? '' : 's'}: ${sequence}.`,
    severity: decoded.commands.some(command => command.allowRevert) ? 'warning' : 'info',
  }]
  if (decoded.deadline) findings.push({
    code: 'UNISWAP_DEADLINE', message: `Universal Router deadline is ${decoded.deadline}.`, severity: 'info',
  })
  if (decoded.signedExecution) findings.push({
    code: 'UNISWAP_SIGNED_EXECUTION',
    message: `Router execution is authorized by an embedded ${decoded.signedExecution.signatureBytes}-byte EIP-712 signature; sender binding is ${decoded.signedExecution.verifySender ? 'required' : 'not required'}, nonce ${decoded.signedExecution.nonce}, intent ${decoded.signedExecution.intent}.`,
    severity: decoded.signedExecution.verifySender ? 'info' : 'warning',
  })
  for (const command of decoded.commands) {
    const value = command.decoded as any
    if (!value) continue
    if (command.id === 0x08 || command.id === 0x00) findings.push({
      code: 'UNISWAP_EXACT_INPUT_SWAP',
      message: `${command.name} spends ${exactInputAmount(value.amountIn)} for at least ${value.amountOutMin} base units; path ${Array.isArray(value.path) ? value.path.join(' → ') : value.path}; recipient ${displayRecipient(value.recipient)}; payer ${value.payerIsUser ? 'user' : 'router'}.`,
      severity: 'warning',
    })
    if (command.id === 0x09 || command.id === 0x01) findings.push({
      code: 'UNISWAP_EXACT_OUTPUT_SWAP',
      message: `${command.name} receives exactly ${value.amountOut} base units while spending at most ${value.amountInMax} base units; path ${Array.isArray(value.path) ? value.path.join(' → ') : value.path}; recipient ${displayRecipient(value.recipient)}; payer ${value.payerIsUser ? 'user' : 'router'}.`,
      severity: 'warning',
    })
    if (command.id === 0x04) findings.push({
      code: 'UNISWAP_SWEEP',
      message: `Sweep token ${value.token} to ${displayRecipient(value.recipient)}, requiring at least ${value.amountMin} base units.`, severity: 'info',
    })
    if (command.id === 0x02) findings.push({
      code: 'UNISWAP_PERMIT2_TRANSFER',
      message: `Transfer ${value.amount} base units of ${value.token} from the user to ${displayRecipient(value.recipient)} using an existing Permit2 allowance.`,
      severity: 'warning',
    })
    if (command.id === 0x05) findings.push({
      code: 'UNISWAP_TRANSFER', message: `Transfer ${value.value} base units of ${value.token} from router-held funds to ${displayRecipient(value.recipient)}.`, severity: 'warning',
    })
    if (command.id === 0x06 || command.id === 0x07) findings.push({
      code: 'UNISWAP_PAY_PORTION',
      message: `Pay portion ${command.id === 0x06 ? value.bips : value.portion} (${command.id === 0x06 ? 'basis-points scale' : 'full-precision scale'}) of router-held ${value.token} to ${displayRecipient(value.recipient)}.`,
      severity: 'warning',
    })
    if (command.id === 0x0b) findings.push({
      code: 'UNISWAP_WRAP_ETH', message: `Wrap ${value.amount} wei of ETH to WETH for ${displayRecipient(value.recipient)}.`, severity: 'info',
    })
    if (command.id === 0x0c) findings.push({
      code: 'UNISWAP_UNWRAP_WETH', message: `Unwrap router-held WETH to ETH for ${displayRecipient(value.recipient)}, requiring at least ${value.amountMin} wei.`, severity: 'info',
    })
    if (command.id === 0x0d) findings.push({
      code: 'UNISWAP_PERMIT2_BATCH_TRANSFER',
      message: `Permit2 batch transfer: ${value.transfers.map((transfer: any) => `${transfer.amount} of ${transfer.token} from ${transfer.from} to ${displayRecipient(transfer.to)}`).join('; ')}.`,
      severity: 'warning',
    })
    if (command.id === 0x0e) findings.push({
      code: 'UNISWAP_BALANCE_CHECK', message: `Require ${value.owner} to hold at least ${value.amountMin} base units of ${value.token}.`, severity: 'info',
    })
    if (command.id === 0x0a || command.id === 0x03) findings.push({
      code: 'UNISWAP_PERMIT2_ALLOWANCE',
      message: `Permit2 authorizes spender ${value.spender} until signature deadline ${value.sigDeadline}: ${(value.details instanceof Array ? value.details : [value.details]).map((detail: any) => `${detail.amount} of ${detail.token} until ${detail.expiration}, nonce ${detail.nonce}`).join('; ')}.`, severity: 'warning',
    })
    if (command.id === 0x10) {
      findings.push({
        code: 'UNISWAP_V4_ACTIONS',
        message: `V4 action plan: ${value.actions.map((action: V4Action) => action.name).join(' → ')}.`,
        severity: 'warning',
      })
      for (const action of value.actions as V4Action[]) {
        const detail = action.decoded as any
        if (!detail) continue
        if (action.id === 0x06 || action.id === 0x07) findings.push({
          code: 'UNISWAP_V4_EXACT_INPUT_SWAP',
          message: `${action.name} spends ${detail.amountIn} base units for at least ${detail.amountOutMinimum} base units.`,
          severity: 'warning',
        })
        if (action.id === 0x08 || action.id === 0x09) findings.push({
          code: 'UNISWAP_V4_EXACT_OUTPUT_SWAP',
          message: `${action.name} receives ${detail.amountOut} base units while spending at most ${detail.amountInMaximum} base units.`,
          severity: 'warning',
        })
        if (action.id === 0x0c) findings.push({
          code: 'UNISWAP_V4_SETTLE_ALL', message: `Settle token ${detail.currency}, capped at ${detail.maxAmount} base units.`, severity: 'warning',
        })
        if (action.id === 0x0f) findings.push({
          code: 'UNISWAP_V4_TAKE_ALL', message: `Take token ${detail.currency} back to the user, requiring at least ${detail.minAmount} base units.`, severity: 'info',
        })
        if (action.id === 0x0b) findings.push({
          code: 'UNISWAP_V4_SETTLE',
          message: `Settle ${detail.amount} base units of ${detail.currency}; payer ${detail.payerIsUser ? 'user' : 'router'}.`, severity: 'warning',
        })
        if (action.id === 0x0e) findings.push({
          code: 'UNISWAP_V4_TAKE',
          message: `Take ${detail.amount} base units of ${detail.currency} to ${displayRecipient(detail.recipient)}.`, severity: 'info',
        })
        if (action.id === 0x10) findings.push({
          code: 'UNISWAP_V4_TAKE_PORTION',
          message: `Take ${detail.bips} basis points of available ${detail.currency} credit to ${displayRecipient(detail.recipient)}.`, severity: 'warning',
        })
      }
    }
    if (command.id === 0x13) findings.push({
      code: 'UNISWAP_V4_INITIALIZE_POOL',
      message: `Initialize v4 pool ${value.poolKey.currency0}/${value.poolKey.currency1}, fee ${value.poolKey.fee}, tick spacing ${value.poolKey.tickSpacing}, hooks ${value.poolKey.hooks}, initial sqrtPriceX96 ${value.sqrtPriceX96}.`,
      severity: 'warning',
    })
    if (command.id === 0x11) findings.push({
      code: 'UNISWAP_V3_POSITION_PERMIT',
      message: `Permit spender ${value.spender} to control v3 position NFT ${value.tokenId} until ${value.deadline}.`,
      severity: 'warning',
    })
    if (command.id === 0x12 && value.method === 'decreaseLiquidity') findings.push({
      code: 'UNISWAP_V3_DECREASE_LIQUIDITY',
      message: `Remove ${value.liquidity} liquidity units from v3 position ${value.tokenId}, requiring at least token0 ${value.amount0Min} and token1 ${value.amount1Min} by ${value.deadline}.`,
      severity: 'warning',
    })
    if (command.id === 0x12 && value.method === 'collect') findings.push({
      code: 'UNISWAP_V3_COLLECT',
      message: `Collect up to token0 ${value.amount0Max} and token1 ${value.amount1Max} from v3 position ${value.tokenId} to ${displayRecipient(value.recipient)}.`,
      severity: 'warning',
    })
    if (command.id === 0x12 && value.method === 'burn') findings.push({
      code: 'UNISWAP_V3_BURN_POSITION', message: `Burn emptied v3 position NFT ${value.tokenId}.`, severity: 'warning',
    })
    if (command.id === 0x14) {
      findings.push({
        code: 'UNISWAP_V4_POSITION_ACTIONS',
        message: `V4 position plan (deadline ${value.deadline}): ${value.actions.map((action: V4Action) => action.name).join(' → ')}.`,
        severity: 'warning',
      })
      for (const action of value.actions as V4Action[]) {
        const detail = action.decoded as any
        if (!detail || (action.id !== 0x02 && action.id !== 0x05)) continue
        findings.push({
          code: action.id === 0x05 ? 'UNISWAP_V4_DEPRECATED_MINT' : 'UNISWAP_V4_MINT_POSITION',
          message: `${action.name} creates a position owned by ${displayRecipient(detail.owner)} for pool ${detail.poolKey.currency0}/${detail.poolKey.currency1}, ticks ${detail.tickLower} to ${detail.tickUpper}, spending at most token0 ${detail.amount0Max} and token1 ${detail.amount1Max}${detail.liquidity ? ` for ${detail.liquidity} liquidity units` : ''}.`,
          severity: action.id === 0x05 ? 'danger' : 'warning',
        })
      }
    }
    if (command.id === 0x40) findings.push({
      code: 'UNISWAP_ACROSS_BRIDGE',
      message: `Across bridge sends ${value.inputAmount} base units of ${value.inputToken} for at least ${value.outputAmount} base units of ${value.outputToken} on chain ${value.destinationChainId} to ${value.recipient}; fill deadline ${value.fillDeadline}.`,
      severity: 'warning',
    })
  }
  const limitations: EffectFinding[] = []
  if (!routerVersion) limitations.push({
    code: 'UNISWAP_ROUTER_IDENTITY_UNVERIFIED',
    message: 'The target is not in the bundled official Uniswap deployment manifest for this chain; decoded bytes do not prove protocol identity.',
    severity: 'danger',
  })
  if (routerVersion && !supportedRouterDialect) limitations.push({
    code: 'UNISWAP_LEGACY_ROUTER_DIALECT_UNVERIFIED',
    message: `The target is an official Uniswap Universal Router ${routerVersion}, but this report supports only the reviewed V2.1.1/V2.1.2 command dialect. Legacy command meanings require a version-specific decoder.`,
    severity: 'danger',
  })
  const permissionedCurrencyCouldBeHidden = routerVersion === 'V2.2.0 Permissioned Pools'
    && decoded.commands.some(command => command.id === 0x10 || command.id === 0x04)
  if (permissionedCurrencyCouldBeHidden) limitations.push({
    code: 'UNISWAP_PERMISSIONED_CURRENCY_UNRESOLVED',
    message: 'Universal Router 2.2 can encode a permissions-adapter address where calldata appears to name a token. Chain-state lookup through the router adapter factory is required to prove the underlying permissioned token and current swap authorization.',
    severity: 'danger',
  })
  limitations.push(...decoded.commands
    .filter(command => command.decodeError)
    .map(command => ({
      code: command.name.startsWith('UNKNOWN_') ? 'UNISWAP_UNKNOWN_COMMAND' : 'UNISWAP_COMMAND_NOT_DECODED',
      message: `Command ${command.index} (${command.name}) is not fully decoded: ${command.decodeError}.`,
      severity: 'danger' as const,
    })))
  for (const command of decoded.commands) {
    const nested: V4Action[] | UniversalRouterCommand[] | undefined = command.id === 0x10 || command.id === 0x14
      ? (command.decoded as any)?.actions
      : command.id === 0x21 ? (command.decoded as any)?.commands : undefined
    for (const item of nested || []) {
      if (!item.decodeError) continue
      limitations.push({
        code: command.id === 0x10 || command.id === 0x14 ? 'UNISWAP_V4_ACTION_NOT_DECODED' : 'UNISWAP_NESTED_COMMAND_NOT_DECODED',
        message: `${command.name} item ${item.index} (${item.name}) is not fully decoded: ${item.decodeError}.`,
        severity: 'danger',
      })
    }
  }
  // Semantic decoding is still useful for an unknown target, but it is not
  // authenticated Uniswap coverage and must not promote the report tier.
  return { findings, limitations, complete: decoded.complete && supportedRouterDialect && Boolean(routerVersion) && !permissionedCurrencyCouldBeHidden }
}
