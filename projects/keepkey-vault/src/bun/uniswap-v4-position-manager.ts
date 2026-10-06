import { utils as ethersUtils } from 'ethers'

import type { EffectFinding } from '../shared/transaction-effects'

const POOL_KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const POSITION_MANAGER = new ethersUtils.Interface([
  'function modifyLiquidities(bytes unlockData,uint256 deadline)',
  'function modifyLiquiditiesWithoutUnlock(bytes actions,bytes[] params)',
  `function initializePool(${POOL_KEY} key,uint160 sqrtPriceX96)`,
  'function multicall(bytes[] data)',
  'function permit(address spender,uint256 tokenId,uint256 deadline,uint256 nonce,bytes signature)',
  'function permitForAll(address owner,address operator,bool approved,uint256 deadline,uint256 nonce,bytes signature)',
  'function permit(address owner,tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)',
  'function permitBatch(address owner,tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline) permitBatch,bytes signature)',
  'function subscribe(uint256 tokenId,address newSubscriber,bytes data)',
  'function unsubscribe(uint256 tokenId)',
  'function revokeNonce(uint256 nonce)',
  'function unwindPosition(uint256 tokenId,uint128 amount0Min,uint128 amount1Min,bytes hookData)',
  'function withdrawClaim(address currency,uint256 amount,address to)',
  'function approve(address to,uint256 tokenId)',
  'function setApprovalForAll(address operator,bool approved)',
  'function transferFrom(address from,address to,uint256 tokenId)',
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
  'function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)',
])

const STANDARD: Record<number, string> = {
  1: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  10: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
  130: '0x4529a01c7a0410167c5740c487a8de60232617bf',
  1301: '0x12a98709bb5d0641d61458f85dcafbe17ac2d05c',
  137: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
  143: '0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016',
  1868: '0x1b35d13a2e2528f192637f14b05f0dc0e7deb566',
  196: '0xcf1eafc6928dc385a342e7c6491d371d2871458b',
  42161: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
  4217: '0x3fc79444f8eacc1894775493ff3fa41f1e35ce11',
  42220: '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9',
  4326: '0x9ae0921e981aaa7308f176f8d4f9129b9247c89d',
  4663: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  480: '0xc585e0f504613b5fbf874f21af14c65260fb41fa',
  5042: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',
  56: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
  57073: '0x1b35d13a2e2528f192637f14b05f0dc0e7deb566',
  59144: '0xddcad5775b2816a87495f207731b3571d7ee3c76',
  7777777: '0xf66c7b99e2040f0d9b326b3b7c152e9663543d63',
  81457: '0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad',
  8453: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  11155111: '0x429ba70129df741b2ca2a85bc3a2a3328e5c09b4',
}
const PERMISSIONED: Record<number, string> = {
  1: '0xd7be746b6b29f6185a01013e944313e1704c971f',
  11155111: '0x864c37908aa5e10b100cacee1c62e3954d76f5e1',
}

export function isOfficialPermissionedPositionManager(chainId?: number, to?: string): boolean {
  return Boolean(chainId && to && PERMISSIONED[chainId] === to.toLowerCase())
}

export function isOfficialV4PositionManager(chainId?: number, to?: string): boolean {
  if (!chainId || !to) return false
  const target = to.toLowerCase()
  return STANDARD[chainId] === target || PERMISSIONED[chainId] === target
}

export interface V4PositionAction { index: number; id: number; name: string; decoded?: Record<string, unknown>; decodeError?: string }
export interface V4PositionCall { method: string; decoded: Record<string, unknown>; actions?: V4PositionAction[]; children?: V4PositionCall[]; complete: boolean }
export interface PermissionedPositionReference {
  currencies?: string[]
  hooks?: string
  principal?: string
  tokenId?: string
  requireVerifiedAdapter?: boolean
  requireLiquidityPermission?: boolean
  requireAllowedHook?: boolean
}

const text = (value: any) => value?.toString?.() ?? String(value)
const address = (value: any) => String(value).toLowerCase()
const displayCurrency = (value: string) => value === '0x0000000000000000000000000000000000000000' ? 'native currency' : value
const displayRecipient = (value: string) => value === '0x0000000000000000000000000000000000000001'
  ? 'transaction sender (0x…01 sentinel)'
  : value === '0x0000000000000000000000000000000000000002' ? 'PositionManager itself (0x…02 sentinel)' : value
const poolKey = (value: any) => ({
  currency0: address(value.currency0 ?? value[0]), currency1: address(value.currency1 ?? value[1]),
  fee: text(value.fee ?? value[2]), tickSpacing: text(value.tickSpacing ?? value[3]), hooks: address(value.hooks ?? value[4]),
})

function exact(types: string[], input: string): ethersUtils.Result {
  const decoded = ethersUtils.defaultAbiCoder.decode(types, input)
  if (ethersUtils.defaultAbiCoder.encode(types, Array.from(decoded)).toLowerCase() !== input.toLowerCase()) {
    throw new Error('non-canonical or trailing ABI data')
  }
  return decoded
}

function parse(data: string): ethersUtils.TransactionDescription | undefined {
  try {
    const parsed = POSITION_MANAGER.parseTransaction({ data })
    if (POSITION_MANAGER.encodeFunctionData(parsed.sighash, Array.from(parsed.args)).toLowerCase() !== data.toLowerCase()) return undefined
    return parsed
  } catch { return undefined }
}

const ACTION_NAMES: Record<number, string> = {
  0x00: 'INCREASE_LIQUIDITY', 0x01: 'DECREASE_LIQUIDITY', 0x02: 'MINT_POSITION', 0x03: 'BURN_POSITION',
  0x04: 'INCREASE_LIQUIDITY_FROM_DELTAS', 0x05: 'MINT_POSITION_FROM_DELTAS', 0x0b: 'SETTLE',
  0x0d: 'SETTLE_PAIR', 0x0e: 'TAKE', 0x11: 'TAKE_PAIR', 0x12: 'CLOSE_CURRENCY',
  0x13: 'CLEAR_OR_TAKE', 0x14: 'SWEEP', 0x15: 'WRAP', 0x16: 'UNWRAP',
  0x17: 'MINT_6909', 0x18: 'BURN_6909', 0x19: 'UNWIND_WITH_FALLBACK',
}

function decodeAction(id: number, input: string): Record<string, unknown> | undefined {
  if (id === 0x00 || id === 0x01) {
    const [tokenId, liquidity, amount0, amount1, hookData] = exact(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], input)
    return { tokenId: text(tokenId), liquidity: text(liquidity), [id ? 'amount0Min' : 'amount0Max']: text(amount0), [id ? 'amount1Min' : 'amount1Max']: text(amount1), hookDataBytes: (String(hookData).length - 2) / 2 }
  }
  if (id === 0x02 || id === 0x05) {
    const types = id === 0x02
      ? [POOL_KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes']
      : [POOL_KEY, 'int24', 'int24', 'uint128', 'uint128', 'address', 'bytes']
    const v = exact(types, input); const offset = id === 0x02 ? 1 : 0
    return { poolKey: poolKey(v[0]), tickLower: text(v[1]), tickUpper: text(v[2]), ...(id === 0x02 ? { liquidity: text(v[3]) } : {}), amount0Max: text(v[3 + offset]), amount1Max: text(v[4 + offset]), owner: address(v[5 + offset]), hookDataBytes: (String(v[6 + offset]).length - 2) / 2, deprecated: id === 0x05 }
  }
  if (id === 0x03) {
    const [tokenId, amount0Min, amount1Min, hookData] = exact(['uint256', 'uint128', 'uint128', 'bytes'], input)
    return { tokenId: text(tokenId), amount0Min: text(amount0Min), amount1Min: text(amount1Min), hookDataBytes: (String(hookData).length - 2) / 2 }
  }
  if (id === 0x04) {
    const [tokenId, amount0Max, amount1Max, hookData] = exact(['uint256', 'uint128', 'uint128', 'bytes'], input)
    return { tokenId: text(tokenId), amount0Max: text(amount0Max), amount1Max: text(amount1Max), hookDataBytes: (String(hookData).length - 2) / 2, deprecated: true }
  }
  if (id === 0x0b) { const [currency, amount, payerIsUser] = exact(['address', 'uint256', 'bool'], input); return { currency: address(currency), amount: text(amount), payerIsUser } }
  if (id === 0x0d) { const [currency0, currency1] = exact(['address', 'address'], input); return { currency0: address(currency0), currency1: address(currency1) } }
  if (id === 0x0e) { const [currency, recipient, amount] = exact(['address', 'address', 'uint256'], input); return { currency: address(currency), recipient: address(recipient), amount: text(amount) } }
  if (id === 0x11) { const [currency0, currency1, recipient] = exact(['address', 'address', 'address'], input); return { currency0: address(currency0), currency1: address(currency1), recipient: address(recipient) } }
  if (id === 0x12) { const [currency] = exact(['address'], input); return { currency: address(currency) } }
  if (id === 0x13) { const [currency, amountMax] = exact(['address', 'uint256'], input); return { currency: address(currency), amountMax: text(amountMax) } }
  if (id === 0x14) { const [currency, recipient] = exact(['address', 'address'], input); return { currency: address(currency), recipient: address(recipient) } }
  if (id === 0x15 || id === 0x16) { const [amount] = exact(['uint256'], input); return { amount: text(amount) } }
  if (id === 0x17) { const [currency] = exact(['address'], input); return { currency: address(currency) } }
  if (id === 0x18 || id === 0x19) {
    const [currency, ownerOrRecipient, amount] = exact(['address', 'address', 'uint256'], input)
    return { currency: address(currency), [id === 0x18 ? 'owner' : 'recipient']: address(ownerOrRecipient), amount: text(amount) }
  }
  return undefined
}

function actions(actionsHex: string, params: string[]): V4PositionAction[] {
  const ids = Buffer.from(actionsHex.slice(2), 'hex')
  if (ids.length !== params.length) throw new Error('v4 position action/parameter length mismatch')
  return params.map((input, index) => {
    const id = ids[index]; const item: V4PositionAction = { index, id, name: ACTION_NAMES[id] || `UNSUPPORTED_0x${id.toString(16).padStart(2, '0')}` }
    try { const decoded = decodeAction(id, input); if (decoded) item.decoded = decoded; else item.decodeError = 'unsupported PositionManager action' }
    catch (error: any) { item.decodeError = `invalid ${item.name} input: ${error?.reason || error?.message || 'decode failed'}` }
    return item
  })
}

export function decodeV4PositionManagerCall(data: string, depth = 0): V4PositionCall | undefined {
  if (depth > 8) throw new Error('v4 PositionManager multicall nesting exceeds 8')
  const parsed = parse(data); if (!parsed) return undefined
  const a: any = parsed.args
  if (parsed.name === 'multicall') {
    const children = Array.from(a.data as string[]).map(item => decodeV4PositionManagerCall(item, depth + 1))
    if (children.some(item => !item)) throw new Error('unrecognized nested v4 PositionManager multicall')
    return { method: parsed.name, decoded: { calls: children.length }, children: children as V4PositionCall[], complete: children.every(item => item?.complete) }
  }
  if (parsed.name === 'modifyLiquidities' || parsed.name === 'modifyLiquiditiesWithoutUnlock') {
    const [actionsHex, params] = parsed.name === 'modifyLiquidities'
      ? exact(['bytes', 'bytes[]'], a.unlockData)
      : [a.actions, a.params]
    const list = actions(String(actionsHex), Array.from(params as string[]))
    return { method: parsed.name, decoded: { ...(a.deadline !== undefined ? { deadline: text(a.deadline) } : {}) }, actions: list, complete: list.every(item => item.decoded && !item.decodeError) }
  }
  if (parsed.name === 'initializePool') return { method: parsed.name, decoded: { poolKey: poolKey(a.key), sqrtPriceX96: text(a.sqrtPriceX96) }, complete: true }
  if (parsed.name === 'permitForAll') return { method: parsed.name, decoded: { owner: address(a.owner), operator: address(a.operator), approved: a.approved, deadline: text(a.deadline), nonce: text(a.nonce), signatureBytes: (String(a.signature).length - 2) / 2 }, complete: true }
  if (parsed.name === 'permitBatch') return { method: parsed.name, decoded: { mode: 'permit2-batch', owner: address(a.owner), spender: address(a.permitBatch.spender), details: Array.from(a.permitBatch.details).map((d: any) => ({ token: address(d.token), amount: text(d.amount), expiration: text(d.expiration), nonce: text(d.nonce) })), sigDeadline: text(a.permitBatch.sigDeadline), signatureBytes: (String(a.signature).length - 2) / 2 }, complete: true }
  if (parsed.name === 'permit' && a.permitSingle) return { method: parsed.name, decoded: { mode: 'permit2-single', owner: address(a.owner), spender: address(a.permitSingle.spender), details: { token: address(a.permitSingle.details.token), amount: text(a.permitSingle.details.amount), expiration: text(a.permitSingle.details.expiration), nonce: text(a.permitSingle.details.nonce) }, sigDeadline: text(a.permitSingle.sigDeadline), signatureBytes: (String(a.signature).length - 2) / 2 }, complete: true }
  const decoded: Record<string, unknown> = {}
  for (const key of Object.keys(a).filter(key => !/^\d+$/.test(key))) {
    const value = a[key]
    decoded[key] = key === 'signature' || key === 'data' ? `${(String(value).length - 2) / 2} bytes` : key.match(/owner|operator|spender|subscriber|from|to/) ? address(value) : text(value)
  }
  return { method: parsed.name, decoded, complete: true }
}

function flatten(call: V4PositionCall): V4PositionCall[] { return call.children ? call.children.flatMap(flatten) : [call] }

/** Extract the state-dependent inputs used by PermissionedPositionManager.
 * Token-id references require a block-pinned getPoolAndPositionInfo lookup. */
export function permissionedPositionReferences(data: string, from?: string): PermissionedPositionReference[] {
  const call = decodeV4PositionManagerCall(data)
  if (!call) return []
  const refs: PermissionedPositionReference[] = []
  for (const item of flatten(call)) {
    if (item.method === 'initializePool') {
      const key: any = item.decoded.poolKey
      refs.push({ currencies: [key.currency0, key.currency1], hooks: key.hooks })
    }
    if (item.method === 'unwindPosition') refs.push({ tokenId: String(item.decoded.tokenId) })
    if (item.method === 'withdrawClaim') refs.push({ currencies: [String(item.decoded.currency)], principal: from })
    for (const action of item.actions || []) {
      const value: any = action.decoded
      if (!value) continue
      if (action.id === 0x02 || action.id === 0x05) refs.push({
        currencies: [value.poolKey.currency0, value.poolKey.currency1], hooks: value.poolKey.hooks,
        principal: value.owner, requireVerifiedAdapter: true, requireLiquidityPermission: true, requireAllowedHook: true,
      })
      else if (action.id === 0x00 || action.id === 0x04) refs.push({
        tokenId: value.tokenId, requireLiquidityPermission: true, requireAllowedHook: true,
      })
      else if (action.id === 0x01 || action.id === 0x03) refs.push({ tokenId: value.tokenId })
      else if (action.id === 0x0b || action.id === 0x0e || action.id === 0x12 || action.id === 0x13 || action.id === 0x14) refs.push({
        currencies: [value.currency], principal: action.id === 0x0b && value.payerIsUser ? from : undefined,
        requireLiquidityPermission: action.id === 0x0b && value.payerIsUser,
      })
      else if (action.id === 0x0d || action.id === 0x11) refs.push({ currencies: [value.currency0, value.currency1] })
      else if (action.id === 0x17 || action.id === 0x18 || action.id === 0x19) refs.push({ currencies: [value.currency] })
    }
  }
  return refs
}

export function v4PositionManagerReportFindings(data: string, chainId?: number, to?: string): { findings: EffectFinding[]; limitations: EffectFinding[]; complete: boolean } {
  let call: V4PositionCall | undefined
  try { call = decodeV4PositionManagerCall(data) } catch (error: any) { return { findings: [], limitations: [{ code: 'UNISWAP_V4_POSITION_CALL_INCOMPLETE', message: error?.message || 'v4 PositionManager call is incomplete.', severity: 'danger' }], complete: false } }
  if (!call) return { findings: [], limitations: [], complete: false }
  const target = to?.toLowerCase(); const standard = chainId ? STANDARD[chainId] === target : false; const permissioned = chainId ? PERMISSIONED[chainId] === target : false
  const findings: EffectFinding[] = [{ code: 'UNISWAP_V4_POSITION_CALL', message: `${standard ? 'Official Uniswap v4 PositionManager' : permissioned ? 'Official Uniswap permissioned v4 PositionManager' : 'v4 PositionManager-format'} call: ${call.method}.`, severity: 'info' }]
  for (const item of flatten(call)) {
    for (const action of item.actions || []) {
      const v: any = action.decoded; if (!v) continue
      const deprecated = action.id === 0x04 || action.id === 0x05
      findings.push({
        code: `UNISWAP_V4_POSITION_${action.name}`,
        message: action.id === 0x02 || action.id === 0x05
          ? `${action.name} creates a position for ${v.owner} in ${v.poolKey.currency0}/${v.poolKey.currency1}, fee ${v.poolKey.fee}, ticks ${v.tickLower}..${v.tickUpper}, spending at most ${v.amount0Max}/${v.amount1Max}${v.liquidity ? ` for ${v.liquidity} liquidity units` : ''}.`
          : action.id === 0x00 || action.id === 0x04
            ? `${action.name} increases position ${v.tokenId}${v.liquidity ? ` by ${v.liquidity} liquidity units` : ''}, spending at most ${v.amount0Max}/${v.amount1Max}.`
            : action.id === 0x01
              ? `${action.name} decreases position ${v.tokenId} by ${v.liquidity} liquidity units, requiring at least ${v.amount0Min}/${v.amount1Min}.`
              : action.id === 0x03
                ? `${action.name} burns position ${v.tokenId}, requiring at least ${v.amount0Min}/${v.amount1Min}.`
                : action.id === 0x0d
                  ? `Settle outstanding deltas for ${displayCurrency(v.currency0)} and ${displayCurrency(v.currency1)}.`
                  : action.id === 0x11
                    ? `Take available ${displayCurrency(v.currency0)} and ${displayCurrency(v.currency1)} to ${displayRecipient(v.recipient)}.`
                    : action.id === 0x14
                      ? `Sweep all available ${displayCurrency(v.currency)} to ${displayRecipient(v.recipient)}.`
                      : action.id === 0x0b
                        ? `Settle ${v.amount} base units of ${displayCurrency(v.currency)}; payer ${v.payerIsUser ? 'user' : 'PositionManager'}.`
                        : action.id === 0x0e
                          ? `Take ${v.amount} base units of ${displayCurrency(v.currency)} to ${displayRecipient(v.recipient)}.`
                          : action.id === 0x17
                            ? `Settle the full positive delta for ${displayCurrency(v.currency)} as an ERC-6909 claim owned by the permissioned PositionManager.`
                            : action.id === 0x18
                              ? `Burn ${v.amount} units of ${displayCurrency(v.currency)} ERC-6909 claim owned by ${v.owner}; the contract requires that owner to equal the action executor.`
                              : action.id === 0x19
                                ? `Burn ${v.amount} units of the permissioned PositionManager's ${displayCurrency(v.currency)} ERC-6909 claim and take the underlying asset to ${displayRecipient(v.recipient)}.`
                          : `${action.name}: ${JSON.stringify(v)}.`,
        severity: deprecated ? 'danger' : 'warning',
      })
    }
    if (item.method === 'permitForAll') findings.push({ code: 'UNISWAP_V4_POSITION_PERMIT_ALL', message: `Set operator ${item.decoded.operator} approval to ${item.decoded.approved} for every position owned by ${item.decoded.owner}; deadline ${item.decoded.deadline}, nonce ${item.decoded.nonce}.`, severity: 'warning' })
    if (item.method === 'permit' && item.decoded.spender) findings.push({ code: 'UNISWAP_V4_POSITION_PERMIT', message: `Permit ${item.decoded.spender} to control position NFT ${item.decoded.tokenId}; deadline ${item.decoded.deadline}, unordered nonce ${item.decoded.nonce}.`, severity: 'warning' })
    if (item.method === 'permit' && item.decoded.mode) findings.push({ code: 'UNISWAP_V4_POSITION_PERMIT2', message: `Forward Permit2 authorization from ${item.decoded.owner} to spender ${item.decoded.spender}; signature deadline ${item.decoded.sigDeadline}; ${JSON.stringify(item.decoded.details)}.`, severity: 'warning' })
    if (item.method === 'permitBatch') findings.push({ code: 'UNISWAP_V4_POSITION_PERMIT2_BATCH', message: `Forward ${Array.isArray(item.decoded.details) ? item.decoded.details.length : 0} Permit2 authorizations from ${item.decoded.owner} to spender ${item.decoded.spender}; signature deadline ${item.decoded.sigDeadline}.`, severity: 'warning' })
    if (item.method === 'approve') findings.push({ code: 'UNISWAP_V4_POSITION_APPROVE', message: `Approve ${item.decoded.to} to control position NFT ${item.decoded.tokenId}.`, severity: 'warning' })
    if (item.method === 'setApprovalForAll') findings.push({ code: 'UNISWAP_V4_POSITION_APPROVE_ALL', message: `Set operator ${item.decoded.operator} approval to ${item.decoded.approved} for every position NFT.`, severity: 'warning' })
    if (item.method === 'transferFrom' || item.method === 'safeTransferFrom') findings.push({ code: 'UNISWAP_V4_POSITION_TRANSFER', message: `Transfer position NFT ${item.decoded.tokenId} from ${item.decoded.from} to ${item.decoded.to}.`, severity: 'warning' })
    if (item.method === 'subscribe') findings.push({ code: 'UNISWAP_V4_POSITION_SUBSCRIBE', message: `Subscribe position ${item.decoded.tokenId} to callback contract ${item.decoded.newSubscriber}.`, severity: 'warning' })
    if (item.method === 'unsubscribe') findings.push({ code: 'UNISWAP_V4_POSITION_UNSUBSCRIBE', message: `Remove the callback subscription from position ${item.decoded.tokenId}.`, severity: 'info' })
    if (item.method === 'revokeNonce') findings.push({ code: 'UNISWAP_V4_POSITION_REVOKE_NONCE', message: `Permanently revoke unordered permit nonce ${item.decoded.nonce}.`, severity: 'warning' })
    if (item.method === 'initializePool') { const key: any = item.decoded.poolKey; findings.push({ code: 'UNISWAP_V4_INITIALIZE_POOL', message: `Initialize v4 pool ${key.currency0}/${key.currency1}, fee ${key.fee}, tick spacing ${key.tickSpacing}, hooks ${key.hooks}, sqrtPriceX96 ${item.decoded.sqrtPriceX96}.`, severity: 'warning' }) }
    if (item.method === 'unwindPosition') findings.push({ code: 'UNISWAP_PERMISSIONED_POSITION_UNWIND', message: `Permission administrator force-exits position ${item.decoded.tokenId}, requiring at least ${item.decoded.amount0Min}/${item.decoded.amount1Min}.`, severity: 'danger' })
    if (item.method === 'withdrawClaim') findings.push({ code: 'UNISWAP_PERMISSIONED_CLAIM_WITHDRAW', message: `Burn ${item.decoded.amount} units of ERC-6909 claim for currency ${item.decoded.currency} and deliver the underlying asset to ${item.decoded.to}.`, severity: 'warning' })
  }
  const limitations: EffectFinding[] = []
  if (!standard && !permissioned) limitations.push({ code: 'UNISWAP_POSITION_MANAGER_IDENTITY_UNVERIFIED', message: 'The target is not the PositionManager in the bundled canonical Uniswap deployment manifest for this chain.', severity: 'danger' })
  if (standard && flatten(call).some(item => item.actions?.some(action => action.id === 0x17 || action.id === 0x18 || action.id === 0x19))) limitations.push({
    code: 'UNISWAP_PERMISSIONED_POSITION_ACTION_ON_STANDARD_MANAGER',
    message: 'ERC-6909 claim and unwind actions are implemented only by PermissionedPositionManager; this standard PositionManager call should revert.',
    severity: 'danger',
  })
  for (const item of flatten(call)) for (const action of item.actions || []) if (action.decodeError) limitations.push({ code: 'UNISWAP_V4_POSITION_ACTION_NOT_DECODED', message: `Action ${action.index} (${action.name}) is not fully decoded: ${action.decodeError}.`, severity: 'danger' })
  const flat = flatten(call)
  const permissionStateRequired = permissioned && flat.some(item =>
    Boolean(item.actions?.length) || item.method === 'unwindPosition' || item.method === 'withdrawClaim' || item.method === 'initializePool')
  if (permissioned && flat.some(item => item.method === 'transferFrom' || item.method === 'safeTransferFrom')) limitations.push({
    code: 'UNISWAP_PERMISSIONED_POSITION_TRANSFER_DISABLED',
    message: 'The official permissioned PositionManager unconditionally disables position NFT transfers; this call should revert.',
    severity: 'danger',
  })
  if (permissionStateRequired) limitations.push({ code: 'UNISWAP_PERMISSIONED_POSITION_STATE_UNRESOLVED', message: 'Permissioned position currencies and live liquidity authorization require block-pinned adapter-factory and allowlist checks.', severity: 'danger' })
  for (const item of flatten(call)) {
    const deadline = item.decoded.deadline
    if (deadline !== undefined && /^\d+$/.test(String(deadline)) && BigInt(String(deadline)) < BigInt(Math.floor(Date.now() / 1000))) {
      limitations.push({ code: 'UNISWAP_DEADLINE_EXPIRED', message: `${item.method} deadline ${deadline} has expired; execution should revert.`, severity: 'danger' })
    }
  }
  return { findings, limitations, complete: call.complete && (standard || permissioned) && limitations.length === 0 }
}
