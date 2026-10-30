/**
 * Host-side decoders for three swap routes the device cannot show yet. Advice
 * checked on this computer (D-018 item 4): nothing here sets or relaxes a gate,
 * and the device still shows these calls as raw data.
 *
 *   0x      AllowanceHolder.exec (0x2213bc0b) into a genuine Settler's
 *           execute (0x1fff991f). Settler pays at least slippage.minAmountOut
 *           of slippage.buyToken to slippage.recipient, or reverts.
 *   CoW     EthFlow createOrder (0x322bba21): sells ETH for at least buyAmount
 *           of buyToken to receiver.
 *   Relay   Router multicall (0xcd6e13f7) and ApprovalProxy
 *           transferAndMulticall (0xf9e4bab4): the same-chain swaps Desktop
 *           builds from a Pioneer quote. Every step must be one listed in
 *           relayStep (Relay fee and payouts, a KyberSwap or 0x swap, WETH
 *           wrap/unwrap, an approval to those routers).
 *
 * Recognised only at the pinned contracts below, on the chains below, and only
 * when every field and step decodes. Anything else returns null and keeps the
 * generic blind path.
 *
 * Every address below was checked 2026-10-29 on Ethereum and Base with
 * eth_getCode (ethereum-rpc.publicnode.com, mainnet.base.org: non-empty), and
 * its source is verified on Sourcify under the contract name given.
 */
import { utils } from 'ethers'
import type { CalldataDecodedField, CalldataDecodedInfo } from '../shared/types'
import { ACROSS_NAMED_TOKENS, REVIEWED_EVM_TOKENS } from '../shared/reviewed-evm-tokens'

/** WETH: symbol() "WETH" and decimals() 18 on chain, checked 2026-10-29. */
const CHAINS: Record<number, { name: string; weth: string }> = {
  1: { name: 'Ethereum', weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  8453: { name: 'Base', weth: '0x4200000000000000000000000000000000000006' },
}

// https://github.com/0xProject/0x-settler/blob/master/README.md ("AllowanceHolder
// addresses", "How do I find the most recent deployment?"). Sourcify: AllowanceHolder.
const ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734'
const ZERO_EX_DEPLOYER = '0x00000000000004533fe15556b1e086bb1a72ceae'
/** computeGenuineSettler in the same README, Cancun chains (Ethereum, Base). */
const SETTLER_SHIM_INIT_HASH = '0x3bf3f97f0be1e2c00023033eefeb4fc062ac552ff36778b17060d90b6764902f'
/** Deployer feature 2: taker-submitted swaps (the AllowanceHolder flow). */
const SETTLER_TAKER_FEATURE = 2n
/** ownerOf(2) on 2026-10-29: deployment 20 on Ethereum, 21 on Base. */
const SETTLER_MAX_DEPLOYMENT = 256

// https://github.com/cowprotocol/ethflowcontract/blob/main-artifacts/networks.prod.json
// (production). Sourcify: CoWSwapEthFlow.
const COW_ETHFLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec'

// https://docs.relay.link/references/api/api_resources/contract-addresses
// (Cancun column; v3 and v3.2 stay live together). Sourcify: RelayRouterV3 /
// RelayApprovalProxyV3 (v3), RelayRouter / RelayApprovalProxy (v3.2).
const RELAY_CONTRACTS = [
  { version: 'v3', router: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', approvalProxy: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be' },
  { version: 'v3.2', router: '0x0729e2a4716d9f7dd17858d5d504426d228697f7', approvalProxy: '0x5567954cd026cebfe486062cb75848e0f1c12e58' },
]
/** Same page, "Solver Addresses" (EVM). An EOA: eth_getCode is empty. */
const RELAY_SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef'
// https://docs.kyberswap.com/developer-guide/aggregator-api/contracts
// Sourcify: MetaAggregationRouterV2.
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const ZERO = '0x0000000000000000000000000000000000000000'

/** ABI reader over hex with no selector. Offsets are bytes; anything out of
 *  bounds, a dirty address word or an oversized offset throws. */
class Abi {
  constructor(readonly hex: string) {}
  word(at: number): string {
    if (!Number.isSafeInteger(at) || at < 0 || (at + 32) * 2 > this.hex.length) throw new Error('short calldata')
    return this.hex.slice(at * 2, at * 2 + 64)
  }
  uint(at: number): bigint { return BigInt(`0x${this.word(at)}`) }
  num(at: number): number {
    const v = this.uint(at)
    if (v > 0xffffffn) throw new Error('offset too large')
    return Number(v)
  }
  addr(at: number): string {
    const w = this.word(at)
    if (!/^0{24}[0-9a-f]{40}$/.test(w)) throw new Error('dirty address')
    return `0x${w.slice(24)}`
  }
  bool(at: number): boolean {
    const v = this.uint(at)
    if (v > 1n) throw new Error('dirty bool')
    return v === 1n
  }
  /** bytes whose offset sits at `head`, relative to `base`: hex, no 0x. */
  bytes(base: number, head: number): string {
    const start = base + this.num(head)
    const len = this.num(start)
    if ((start + 32 + len) * 2 > this.hex.length) throw new Error('short bytes')
    return this.hex.slice((start + 32) * 2, (start + 32 + len) * 2)
  }
  /** A dynamic array whose offset sits at `head`: its length and where its elements start. */
  array(base: number, head: number): { at: number; n: number } {
    const start = base + this.num(head)
    const n = this.num(start)
    if (n > 64) throw new Error('array too long')
    return { at: start + 32, n }
  }
  addrs(base: number, head: number): string[] {
    const a = this.array(base, head)
    return Array.from({ length: a.n }, (_, i) => this.addr(a.at + 32 * i))
  }
  uints(base: number, head: number): bigint[] {
    const a = this.array(base, head)
    return Array.from({ length: a.n }, (_, i) => this.uint(a.at + 32 * i))
  }
}

/** msg.value as the request carries it (hex, decimal, number); undefined if unreadable. */
function txValue(raw: unknown): bigint | undefined {
  if (raw == null || raw === '' || raw === '0x') return 0n
  const s = String(raw).trim()
  return /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s) ? BigInt(s) : undefined
}

const field = (name: string, value: string, type = 'string', format: CalldataDecodedField['format'] = 'raw'): CalldataDecodedField =>
  ({ name, value, type, format })

function units(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const frac = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${raw / scale}${frac ? `.${frac}` : ''}`
}

/** Names only from KeepKey's reviewed lists, plus ETH and the chain's WETH. */
function tokenInfo(chainId: number, token: string): { symbol: string; decimals: number } | undefined {
  if (token === NATIVE || token === ZERO) return { symbol: 'ETH', decimals: 18 }
  if (token === CHAINS[chainId].weth) return { symbol: 'WETH', decimals: 18 }
  return REVIEWED_EVM_TOKENS[`${chainId}:${token}`] ?? ACROSS_NAMED_TOKENS[`${chainId}:${token}`]
}

interface Amount { token: string; raw: bigint }

function amountText(chainId: number, a: Amount): string {
  const t = tokenInfo(chainId, a.token)
  return t ? `${units(a.raw, t.decimals)} ${t.symbol}` : `${a.raw} base units of token ${a.token}`
}

const utcDate = (secs: number) => new Date(secs * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')

/** The deployment number when `address` is a Settler 0x's Deployer created
 *  for taker swaps on this chain (README computeGenuineSettler), else null.
 *  Offline: no RPC, no hard-coded Settler list (0x rotates them). */
const settlerCache = new Map<string, number | null>()
function genuineSettler(chainId: number, address: string): number | null {
  const key = `${chainId}:${address}`
  if (settlerCache.has(key)) return settlerCache.get(key)!
  let found: number | null = null
  for (let n = 1; n <= SETTLER_MAX_DEPLOYMENT && found === null; n++) {
    const salt = utils.hexZeroPad(`0x${((SETTLER_TAKER_FEATURE << 128n) | (BigInt(chainId) << 64n) | BigInt(n)).toString(16)}`, 32)
    const shim = `0x${utils.keccak256(utils.concat(['0xff', ZERO_EX_DEPLOYER, salt, SETTLER_SHIM_INIT_HASH])).slice(26)}`
    if (`0x${utils.keccak256(utils.concat(['0xd694', shim, '0x01'])).slice(26)}` === address) found = n
  }
  settlerCache.set(key, found)
  return found
}

/** '0x Settler' when `address` is a genuine taker Settler on a chain listed
 *  above (the spender of a 0x Swap API permit2 quote), else undefined. */
export function zeroExSettlerName(chainId: number, address: string): string | undefined {
  if (!CHAINS[chainId] || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined
  return genuineSettler(chainId, address.toLowerCase()) === null ? undefined : '0x Settler'
}

/** AllowanceHolder.exec args (no selector) into Settler.execute. `value` is
 *  the coin sent with the exec call. */
function settlerSwap(chainId: number, r: Abi, value: bigint) {
  const operator = r.addr(0), token = r.addr(32), amount = r.uint(64), target = r.addr(96)
  const inner = r.bytes(0, 128)
  if (operator !== target || !inner.startsWith('1fff991f')) return null
  const deployment = genuineSettler(chainId, target)
  if (deployment === null) return null
  // Selling the coin: exec forwards msg.value. Selling a token: no coin.
  const native = token === ZERO || token === NATIVE
  if (native ? value !== amount || amount === 0n : value !== 0n) return null
  const s = new Abi(inner.slice(8))
  return {
    settler: target, deployment, actions: s.array(0, 96).n,
    sell: { token: native ? NATIVE : token, raw: amount },
    // Settler compares buyToken to the ETH sentinel for a coin payout.
    min: { token: s.addr(32), raw: s.uint(64) },
    recipient: s.addr(0),
  }
}

interface Swap {
  dappName: string
  protocol: string
  contractName: string
  method: string
  pay: Amount[]
  min: Amount[]
  recipient: string
  extra: CalldataDecodedField[]
}

/** Card rows in the shape thorDepositFields uses ('Action' "Swap …",
 *  'Minimum output', 'Output destination'), which the risk bar and the
 *  signing overlay's swap card already read. */
function swapInfo(chainId: number, selector: string, s: Swap): CalldataDecodedInfo {
  const pay = s.pay.map((a) => amountText(chainId, a)).join(' + ')
  const min = s.min.map((a) => amountText(chainId, a)).join(' + ')
  const unnamed = (list: Amount[]) => list.filter((a) => !tokenInfo(chainId, a.token)).map((a) => a.token)
  const unnamedIn = unnamed(s.pay), unnamedOut = unnamed(s.min)
  return {
    dappName: s.dappName, contractName: s.contractName, method: s.method, selector, functionType: 'swap', source: 'local',
    fields: [
      field('Action', `Swap ${pay} for at least ${min}`),
      field('Protocol', s.protocol),
      field('Input amount', pay, 'uint256', 'amount'),
      field('Output chain', CHAINS[chainId].name),
      field('Output asset', s.min.map((a) => tokenInfo(chainId, a.token)?.symbol ?? a.token).join(' + ')),
      field('Minimum output', min, 'uint256', 'amount'),
      field('Output destination', s.recipient, 'address', 'address'),
      ...s.extra,
      ...(unnamedIn.length ? [field('Input token warning', `Token ${unnamedIn.join(', ')} is not on KeepKey's reviewed list`)] : []),
      ...(unnamedOut.length ? [field('Token warning', `Token ${unnamedOut.join(', ')} is not on KeepKey's reviewed list`)] : []),
    ],
  }
}

function zeroEx(chainId: number, data: string, value: bigint): CalldataDecodedInfo | null {
  const z = settlerSwap(chainId, new Abi(data.slice(10)), value)
  if (!z) return null
  return swapInfo(chainId, '0x2213bc0b', {
    dappName: '0x', protocol: '0x Settler', contractName: '0x AllowanceHolder', method: 'Swap (0x AllowanceHolder.exec → Settler.execute)',
    pay: [z.sell], min: [z.min], recipient: z.recipient,
    extra: [
      field('Settler', `${z.settler} (0x Settler deployment ${z.deployment} for taker swaps, made by 0x's Deployer ${ZERO_EX_DEPLOYER})`, 'address'),
      field('Settler steps', `${z.actions} route actions, not decoded here; Settler checks the minimum output when they finish`),
      field('AllowanceHolder', `${ALLOWANCE_HOLDER} (0x AllowanceHolder, ${CHAINS[chainId].name})`, 'address'),
    ],
  })
}

function cowEthFlow(chainId: number, data: string, value: bigint): CalldataDecodedInfo | null {
  // createOrder(EthFlowOrder.Data): a static 9-word tuple, nothing after it.
  if (data.length !== 10 + 9 * 64) return null
  const r = new Abi(data.slice(10))
  const buyToken = r.addr(0), receiver = r.addr(32), sellAmount = r.uint(64), buyAmount = r.uint(96)
  const appData = `0x${r.word(128)}`, feeAmount = r.uint(160), validTo = r.uint(192), partiallyFillable = r.bool(224)
  const quoteWord = r.uint(256)
  const quoteId = quoteWord >= 1n << 255n ? quoteWord - (1n << 256n) : quoteWord
  if (validTo >= 1n << 32n || quoteId < -(1n << 63n) || quoteId >= 1n << 63n) return null
  // The EthFlow contract reverts unless msg.value == sellAmount + feeAmount.
  if (sellAmount === 0n || value !== sellAmount + feeAmount) return null
  const eth = (raw: bigint) => amountText(chainId, { token: NATIVE, raw })
  return swapInfo(chainId, '0x322bba21', {
    dappName: 'CoW Protocol', protocol: 'CoW EthFlow', contractName: 'CoW Protocol EthFlow', method: 'Place a CoW order (EthFlow createOrder)',
    pay: [{ token: NATIVE, raw: value }], min: [{ token: buyToken, raw: buyAmount }], recipient: receiver,
    extra: [
      field('Sell amount', eth(sellAmount), 'uint256', 'amount'),
      field('Fee amount', eth(feeAmount), 'uint256', 'amount'),
      field('Valid until', `${utcDate(Number(validTo))}${Number(validTo) * 1000 < Date.now() ? ' (EXPIRED)' : ''}`, 'uint32'),
      field('Partially fillable', partiallyFillable ? 'Yes' : 'No', 'bool'),
      field('App data', appData, 'bytes32', 'hex'),
      field('Quote id', quoteId.toString(), 'int64'),
      field('EthFlow contract', `${COW_ETHFLOW} (CoW Protocol EthFlow, ${CHAINS[chainId].name})`, 'address'),
    ],
  })
}

/** What the router is sure to hold so far, step by step. A swap step credits
 *  its guaranteed output; a step that spends a credited token (a later swap,
 *  an approval, a wrap or unwrap) removes the credit, and sweeping that token
 *  afterwards, or sweeping any token twice, leaves the whole call blind. */
interface Ledger { held: Map<string, bigint>; voided: Set<string>; swept: Set<string> }
/** `claim`: for a sweep, what the ledger held of that token at that step. */
interface Payout { token: string; to: string; exact?: bigint; claim?: bigint }

/** One Call3Value the Relay Router runs (as msg.sender). Returns false for a
 *  step this computer does not read, which leaves the whole call blind. */
function relayStep(
  chainId: number, router: string, call: { target: string; value: bigint; data: string },
  produced: Ledger, payouts: Payout[],
): boolean {
  const { target, value, data } = call
  const sel = data.slice(0, 8)
  const r = new Abi(data.slice(8))
  const { held, voided, swept } = produced
  const add = (token: string, raw: bigint) => held.set(token, (held.get(token) ?? 0n) + raw)
  const spend = (token: string) => { if (held.delete(token)) voided.add(token) }
  // cleanup*: an exact amount moves just that much; 0 sweeps the router's whole balance.
  const payout = (token: string, to: string, amount: bigint): boolean => {
    if (amount !== 0n) {
      const h = held.get(token)
      if (h !== undefined) held.set(token, h > amount ? h - amount : 0n)
      if (to !== ZERO) payouts.push({ token, to, exact: amount })
      return true
    }
    if (voided.has(token) || swept.has(token)) return false
    swept.add(token)
    const claim = held.get(token)
    held.delete(token)
    if (to !== ZERO) payouts.push({ token, to, claim })
    return true
  }
  if (value > 0n && target !== router) spend(NATIVE)
  if (target === router) {
    if (data === '') return true // coin moved to the router itself
    if (sel === 'a6bd8c96') { // cleanupNative(amount, recipient, metadata)
      return value === 0n && payout(NATIVE, r.addr(32), r.uint(0))
    }
    if (sel === '9bb43718') { // cleanupErc20s(tokens, recipients, amounts, metadata)
      const tokens = r.addrs(0, 0), to = r.addrs(0, 32), amounts = r.uints(0, 64)
      if (tokens.length !== to.length || tokens.length !== amounts.length) return false
      return value === 0n && tokens.every((token, i) => payout(token, to[i], amounts[i]))
    }
    return false
  }
  if (target === KYBER_ROUTER && sel === 'e21fd0e9') {
    // swap(SwapExecutionParams): desc is its 4th member. Kyber reverts unless
    // dstReceiver (0 = the caller) gains at least minReturnAmount of dstToken.
    const t = r.num(0)
    const d = t + r.num(t + 96)
    if (r.array(d, d + 128).n !== 0 || (r.uint(d + 288) & 1n) === 1n) return false // no Kyber fees, no partial fill
    const receiver = r.addr(d + 192)
    if (receiver !== ZERO && receiver !== router) return false
    spend(r.addr(d))
    add(r.addr(d + 32), r.uint(d + 256))
    return true
  }
  if (target === ALLOWANCE_HOLDER && sel === '2213bc0b') {
    const z = settlerSwap(chainId, r, value)
    if (!z || z.recipient !== router) return false
    spend(z.sell.token)
    add(z.min.token, z.min.raw)
    return true
  }
  const weth = CHAINS[chainId].weth
  if (target === weth && sel === '2e1a7d4d' && value === 0n && data.length === 8 + 64) { spend(weth); add(NATIVE, r.uint(0)); return true }
  if (target === weth && sel === 'd0e30db0' && data.length === 8) { add(weth, value); return true }
  // approve(spender, amount) from the router to the swap router it calls next
  // (or to itself, which Relay's unwrap route does and which moves nothing).
  if (sel === '095ea7b3' && value === 0n && data.length === 8 + 128 && [KYBER_ROUTER, ALLOWANCE_HOLDER, router].includes(r.addr(0))) {
    spend(target)
    return true
  }
  return false
}

function relaySwap(chainId: number, to: string, data: string, value: bigint): CalldataDecodedInfo | null {
  const sel = data.slice(0, 10)
  const relay = RELAY_CONTRACTS.find((c) => (sel === '0xcd6e13f7' && to === c.router) || (sel === '0xf9e4bab4' && to === c.approvalProxy))
  if (!relay) return null
  const r = new Abi(data.slice(10))
  const viaProxy = sel === '0xf9e4bab4'
  // transferAndMulticall(tokens, amounts, calls, refundTo, nftRecipient, metadata)
  // pulls each token from the signer into the router, then runs multicall.
  const pay: Amount[] = []
  if (viaProxy) {
    const tokens = r.addrs(0, 0), amounts = r.uints(0, 32)
    if (tokens.length !== amounts.length) return null
    tokens.forEach((token, i) => pay.push({ token, raw: amounts[i] }))
  }
  if (value > 0n) pay.unshift({ token: NATIVE, raw: value })
  if (pay.length === 0) return null
  const head = viaProxy ? 64 : 0
  const calls = r.array(0, head)
  const refundTo = r.addr(head + 32)
  const produced: Ledger = { held: new Map(), voided: new Set(), swept: new Set() }
  const payouts: Payout[] = []
  for (let i = 0; i < calls.n; i++) {
    const at = calls.at + r.num(calls.at + 32 * i)
    if (r.bool(at + 32)) return null // allowFailure: a failed swap step would be skipped silently
    if (!relayStep(chainId, relay.router, { target: r.addr(at), value: r.uint(at + 64), data: r.bytes(at, at + 96) }, produced, payouts)) return null
  }
  // An explicit amount to Relay's solver is its fee; everything else is output.
  const fees = payouts.filter((p) => p.to === RELAY_SOLVER && p.exact !== undefined)
  const outputs = payouts.filter((p) => !fees.includes(p))
  const recipients = [...new Set(outputs.map((p) => p.to))]
  if (recipients.length !== 1) return null
  // An "all of it" payout is at least what the ledger held of it at that step.
  const min: Amount[] = []
  const sweeps: string[] = []
  for (const p of outputs) {
    const raw = p.exact ?? p.claim
    if (raw !== undefined) min.push({ token: p.token, raw })
    else sweeps.push(tokenInfo(chainId, p.token)?.symbol ?? p.token)
  }
  if (min.length === 0) return null
  const chain = CHAINS[chainId].name
  return swapInfo(chainId, sel, {
    dappName: 'Relay', protocol: 'Relay Router', contractName: viaProxy ? 'Relay ApprovalProxy' : 'Relay Router',
    method: viaProxy ? 'Relay swap (transferAndMulticall)' : 'Relay swap (multicall)',
    pay, min, recipient: recipients[0],
    extra: [
      ...fees.map((f) => field('Relay fee', `${amountText(chainId, { token: f.token, raw: f.exact! })} to Relay's solver ${RELAY_SOLVER}`, 'uint256', 'amount')),
      ...(sweeps.length ? [field('Also returns', `Any ${sweeps.join(', ')} left in the router`)] : []),
      field('Leftover refund to', refundTo === ZERO ? 'the sending account' : refundTo, 'address', 'address'),
      field('Relay contract', `${to} (Relay ${viaProxy ? 'ApprovalProxy' : 'Router'} ${relay.version}, ${chain})`, 'address'),
    ],
  })
}

/** A 0x, CoW EthFlow or Relay Router swap to its pinned contract, decoded in
 *  full; null for anything else (and for anything this code cannot read). */
export function decodeSwapCall(to: string | undefined, data: string | undefined, chainId: number | undefined, value: unknown): CalldataDecodedInfo | null {
  const dest = String(to || '').toLowerCase()
  const hex = String(data || '').toLowerCase()
  const v = txValue(value)
  if (!chainId || !CHAINS[chainId] || v === undefined || !/^0x([0-9a-f]{2})*$/.test(hex) || hex.length < 10) return null
  try {
    if (dest === ALLOWANCE_HOLDER && hex.startsWith('0x2213bc0b')) return zeroEx(chainId, hex, v)
    if (dest === COW_ETHFLOW && hex.startsWith('0x322bba21')) return cowEthFlow(chainId, hex, v)
    return relaySwap(chainId, dest, hex, v)
  } catch {
    return null
  }
}
