/**
 * Calldata decoder — decodes EVM transaction calldata into human-readable fields
 * for the signing approval UI. Fully vendored/local — no network round-trip.
 *
 * Two tiers:
 * 1. Local decoders for common contracts (ERC-20, Uniswap, THORChain, 0x, …)
 * 2. Unknown — selector only
 *
 * (Pioneer's remote /descriptors/decode + /descriptors/sign are gone — the
 *  per-tx online signer was removed by design, and both endpoints now 404.
 *  Firmware clear-signing is driven off the vendored `firmwareClearSigns`
 *  allowlist below, which mirrors the device's own `ethereum_contractHandled`.)
 */
import type { CalldataDecodedInfo, CalldataDecodedField } from '../shared/types'

// ── Helpers ──────────────────────────────────────────────────────────────

function formatAddress(raw: string): string {
  if (!raw || raw === '0x') return ''
  const hex = raw.replace(/^0x/, '')
  const addr = hex.length > 40 ? hex.slice(-40) : hex
  return '0x' + addr
}

function formatUint256(raw: string): string {
  if (!raw || raw === '0x') return '0'
  try {
    const bn = BigInt(raw.startsWith('0x') ? raw : '0x' + raw)
    return bn.toString()
  } catch {
    return raw
  }
}

// ── Local ERC-20 decoder (offline fallback) ──────────────────────────────

interface LocalDecoder {
  selector: string
  method: string
  decode: (data: string) => CalldataDecodedField[]
}

// THORChain/Maya router deposit head layout: vault (word0), asset (word1) and
// amount (word2) sit at identical offsets for both deposit(...,memo) and
// depositWithExpiry(...,memo,expiry), so one decoder serves both selectors.
// The firmware (thortx.c) clear-signs BOTH — so the Vault must recognize both,
// otherwise the plain deposit() path decodes as source:'none', the signing
// overlay flags needsBlindSigning and forces AdvancedMode ON, which turns OFF
// the device's own blind-sign gate and defeats the router-pin fix (PR #261).
function decodeThorDeposit(data: string): CalldataDecodedField[] {
  const vault = formatAddress('0x' + data.slice(10, 74))
  const asset = formatAddress('0x' + data.slice(74, 138))
  const amount = formatUint256('0x' + data.slice(138, 202))
  const isNativeAsset = asset === '0x0000000000000000000000000000000000000000'
  return [
    { name: 'Protocol', type: 'string', value: 'THORChain Router', format: 'raw' },
    { name: 'Vault', type: 'address', value: vault, format: 'address' },
    { name: 'Asset', type: 'string', value: isNativeAsset ? 'Native (ETH)' : asset, format: isNativeAsset ? 'raw' : 'address' },
    { name: 'Amount', type: 'uint256', value: amount, format: 'amount' },
  ]
}

const LOCAL_DECODERS: LocalDecoder[] = [
  // ERC-20 transfer(address,uint256)
  {
    selector: '0xa9059cbb',
    method: 'transfer',
    decode: (data) => {
      const to = formatAddress('0x' + data.slice(10, 74))
      const amount = formatUint256('0x' + data.slice(74, 138))
      return [
        { name: 'Recipient', type: 'address', value: to, format: 'address' },
        { name: 'Amount', type: 'uint256', value: amount, format: 'amount' },
      ]
    },
  },
  // ERC-20 approve(address,uint256)
  {
    selector: '0x095ea7b3',
    method: 'approve',
    decode: (data) => {
      const spender = formatAddress('0x' + data.slice(10, 74))
      const amount = formatUint256('0x' + data.slice(74, 138))
      const isMaxApproval = amount === '115792089237316195423570985008687907853269984665640564039457584007913129639935'
      return [
        { name: 'Spender', type: 'address', value: spender, format: 'address' },
        { name: 'Amount', type: 'uint256', value: isMaxApproval ? 'Unlimited' : amount, format: 'amount' },
      ]
    },
  },
  // ERC-20 transferFrom(address,address,uint256)
  {
    selector: '0x23b872dd',
    method: 'transferFrom',
    decode: (data) => {
      const from = formatAddress('0x' + data.slice(10, 74))
      const to = formatAddress('0x' + data.slice(74, 138))
      const amount = formatUint256('0x' + data.slice(138, 202))
      return [
        { name: 'From', type: 'address', value: from, format: 'address' },
        { name: 'To', type: 'address', value: to, format: 'address' },
        { name: 'Amount', type: 'uint256', value: amount, format: 'amount' },
      ]
    },
  },
  // ── Common DeFi selectors (decode what we can without ABI) ──
  // Uniswap V2/V3 swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
  {
    selector: '0x38ed1739',
    method: 'swapExactTokensForTokens',
    decode: (data) => {
      const amountIn = formatUint256('0x' + data.slice(10, 74))
      const amountOutMin = formatUint256('0x' + data.slice(74, 138))
      const to = formatAddress('0x' + data.slice(202, 266))
      return [
        { name: 'Amount In', type: 'uint256', value: amountIn, format: 'amount' },
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
        { name: 'Recipient', type: 'address', value: to, format: 'address' },
      ]
    },
  },
  // Uniswap V2 swapExactETHForTokens(uint256,address[],address,uint256)
  {
    selector: '0x7ff36ab5',
    method: 'swapExactETHForTokens',
    decode: (data) => {
      const amountOutMin = formatUint256('0x' + data.slice(10, 74))
      const to = formatAddress('0x' + data.slice(138, 202))
      return [
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
        { name: 'Recipient', type: 'address', value: to, format: 'address' },
      ]
    },
  },
  // Uniswap V2 swapExactTokensForETH(uint256,uint256,address[],address,uint256)
  {
    selector: '0x18cbafe5',
    method: 'swapExactTokensForETH',
    decode: (data) => {
      const amountIn = formatUint256('0x' + data.slice(10, 74))
      const amountOutMin = formatUint256('0x' + data.slice(74, 138))
      const to = formatAddress('0x' + data.slice(202, 266))
      return [
        { name: 'Amount In', type: 'uint256', value: amountIn, format: 'amount' },
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
        { name: 'Recipient', type: 'address', value: to, format: 'address' },
      ]
    },
  },
  // WETH deposit() — wrapping ETH
  {
    selector: '0xd0e30db0',
    method: 'deposit (Wrap ETH)',
    decode: () => [{ name: 'Action', type: 'string', value: 'Wrap ETH to WETH', format: 'raw' }],
  },
  // WETH withdraw(uint256) — unwrapping WETH
  {
    selector: '0x2e1a7d4d',
    method: 'withdraw (Unwrap WETH)',
    decode: (data) => {
      const amount = formatUint256('0x' + data.slice(10, 74))
      return [{ name: 'Amount', type: 'uint256', value: amount, format: 'amount' }]
    },
  },
  // ERC-721 safeTransferFrom(address,address,uint256)
  {
    selector: '0x42842e0e',
    method: 'safeTransferFrom (NFT)',
    decode: (data) => {
      const from = formatAddress('0x' + data.slice(10, 74))
      const to = formatAddress('0x' + data.slice(74, 138))
      const tokenId = formatUint256('0x' + data.slice(138, 202))
      return [
        { name: 'From', type: 'address', value: from, format: 'address' },
        { name: 'To', type: 'address', value: to, format: 'address' },
        { name: 'Token ID', type: 'uint256', value: tokenId, format: 'raw' },
      ]
    },
  },
  // ERC-721 setApprovalForAll(address,bool)
  {
    selector: '0xa22cb465',
    method: 'setApprovalForAll (NFT)',
    decode: (data) => {
      const operator = formatAddress('0x' + data.slice(10, 74))
      const approved = BigInt('0x' + data.slice(74, 138)) !== 0n
      return [
        { name: 'Operator', type: 'address', value: operator, format: 'address' },
        { name: 'Approved', type: 'bool', value: String(approved), format: 'raw' },
      ]
    },
  },
  // ── Uniswap Universal Router ──
  // execute(bytes commands, bytes[] inputs, uint256 deadline)
  {
    selector: '0x3593564c',
    method: 'Swap (Universal Router)',
    decode: (data) => {
      // commands is a packed byte array — each byte is a command type
      // inputs is an array of encoded params for each command
      // deadline is the last 32 bytes before the dynamic data
      const deadline = formatUint256('0x' + data.slice(74, 138))
      const deadlineDate = Number(deadline) > 1e9 && Number(deadline) < 1e11
        ? new Date(Number(deadline) * 1000).toISOString()
        : deadline
      return [
        { name: 'Protocol', type: 'string', value: 'Uniswap Universal Router', format: 'raw' },
        { name: 'Deadline', type: 'uint256', value: deadlineDate, format: 'raw' },
      ]
    },
  },
  // Uniswap V3 SwapRouter02 multicall(uint256 deadline, bytes[] data)
  {
    selector: '0x5ae401dc',
    method: 'Multicall (Uniswap V3)',
    decode: (data) => {
      const deadline = formatUint256('0x' + data.slice(10, 74))
      const deadlineDate = Number(deadline) > 1e9 && Number(deadline) < 1e11
        ? new Date(Number(deadline) * 1000).toISOString()
        : deadline
      return [
        { name: 'Protocol', type: 'string', value: 'Uniswap V3 Router', format: 'raw' },
        { name: 'Deadline', type: 'uint256', value: deadlineDate, format: 'raw' },
      ]
    },
  },
  // Uniswap V3 SwapRouter02 multicall(bytes[] data) — no deadline variant
  {
    selector: '0xac9650d8',
    method: 'Multicall (Uniswap V3)',
    decode: () => [
      { name: 'Protocol', type: 'string', value: 'Uniswap V3 Router', format: 'raw' },
    ],
  },
  // Uniswap V3 SwapRouter02 exactInputSingle
  {
    selector: '0x04e45aaf',
    method: 'Exact Input Single (Uniswap V3)',
    decode: (data) => {
      const tokenIn = formatAddress('0x' + data.slice(10, 74))
      const tokenOut = formatAddress('0x' + data.slice(74, 138))
      const recipient = formatAddress('0x' + data.slice(202, 266))
      const amountIn = formatUint256('0x' + data.slice(266, 330))
      const amountOutMin = formatUint256('0x' + data.slice(330, 394))
      return [
        { name: 'Token In', type: 'address', value: tokenIn, format: 'address' },
        { name: 'Token Out', type: 'address', value: tokenOut, format: 'address' },
        { name: 'Recipient', type: 'address', value: recipient, format: 'address' },
        { name: 'Amount In', type: 'uint256', value: amountIn, format: 'amount' },
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
      ]
    },
  },
  // Uniswap V3 SwapRouter exactInputSingle (original router)
  {
    selector: '0x414bf389',
    method: 'Exact Input Single (Uniswap V3)',
    decode: (data) => {
      const tokenIn = formatAddress('0x' + data.slice(10, 74))
      const tokenOut = formatAddress('0x' + data.slice(74, 138))
      const recipient = formatAddress('0x' + data.slice(202, 266))
      const deadline = formatUint256('0x' + data.slice(266, 330))
      const amountIn = formatUint256('0x' + data.slice(330, 394))
      const amountOutMin = formatUint256('0x' + data.slice(394, 458))
      const deadlineDate = Number(deadline) > 1e9 && Number(deadline) < 1e11
        ? new Date(Number(deadline) * 1000).toISOString()
        : deadline
      return [
        { name: 'Token In', type: 'address', value: tokenIn, format: 'address' },
        { name: 'Token Out', type: 'address', value: tokenOut, format: 'address' },
        { name: 'Recipient', type: 'address', value: recipient, format: 'address' },
        { name: 'Deadline', type: 'uint256', value: deadlineDate, format: 'raw' },
        { name: 'Amount In', type: 'uint256', value: amountIn, format: 'amount' },
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
      ]
    },
  },
  // Uniswap V3 SwapRouter exactInput(ExactInputParams)
  {
    selector: '0xc04b8d59',
    method: 'Exact Input (Uniswap V3)',
    decode: (data) => {
      const recipient = formatAddress('0x' + data.slice(74, 138))
      const amountIn = formatUint256('0x' + data.slice(202, 266))
      const amountOutMin = formatUint256('0x' + data.slice(266, 330))
      return [
        { name: 'Recipient', type: 'address', value: recipient, format: 'address' },
        { name: 'Amount In', type: 'uint256', value: amountIn, format: 'amount' },
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
      ]
    },
  },
  // ── 1inch Aggregation Router ──
  // swap(address executor, SwapDescription desc, bytes permit, bytes data)
  {
    selector: '0x12aa3caf',
    method: 'Swap (1inch)',
    decode: (data) => {
      // executor is first param, then desc struct starts at offset
      const executor = formatAddress('0x' + data.slice(10, 74))
      return [
        { name: 'Protocol', type: 'string', value: '1inch Aggregation Router', format: 'raw' },
        { name: 'Executor', type: 'address', value: executor, format: 'address' },
      ]
    },
  },
  // 1inch unoswapTo(address,address,uint256,uint256,uint256[])
  {
    selector: '0xe449022e',
    method: 'Swap (1inch)',
    decode: (data) => {
      const amountIn = formatUint256('0x' + data.slice(10, 74))
      const amountOutMin = formatUint256('0x' + data.slice(74, 138))
      return [
        { name: 'Protocol', type: 'string', value: '1inch Router', format: 'raw' },
        { name: 'Amount In', type: 'uint256', value: amountIn, format: 'amount' },
        { name: 'Min Amount Out', type: 'uint256', value: amountOutMin, format: 'amount' },
      ]
    },
  },
  // ── 0x Exchange Proxy / Uniswap (firmware clear-signs these) ──
  // The firmware (zxswap.c / zxliquidtx.c) natively clear-signs these to their
  // pinned routers, so decode them — otherwise they read as source:'none' and
  // the signing overlay over-gates into blind-signing (forcing AdvancedMode ON,
  // which disables the device's own gate). The device stays authoritative: it
  // re-checks the array offset / LP recipient and rejects spoofed variants
  // regardless of what we display here.
  // sellToUniswap(address[] tokens, uint256 sellAmount, uint256 minBuyAmount, bool isSushi)
  {
    selector: '0xd9627aa4',
    method: 'Sell to Uniswap (0x)',
    decode: (data) => {
      const sellAmount = formatUint256('0x' + data.slice(74, 138))
      const minBuyAmount = formatUint256('0x' + data.slice(138, 202))
      return [
        { name: 'Protocol', type: 'string', value: '0x Exchange Proxy', format: 'raw' },
        { name: 'Sell Amount', type: 'uint256', value: sellAmount, format: 'amount' },
        { name: 'Min Buy Amount', type: 'uint256', value: minBuyAmount, format: 'amount' },
      ]
    },
  },
  // addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline)
  {
    selector: '0xf305d719',
    method: 'Add Liquidity (Uniswap)',
    decode: (data) => {
      const token = formatAddress('0x' + data.slice(10, 74))
      const recipient = formatAddress('0x' + data.slice(266, 330))
      return [
        { name: 'Protocol', type: 'string', value: 'Uniswap V2 Router', format: 'raw' },
        { name: 'Token', type: 'address', value: token, format: 'address' },
        { name: 'LP Recipient', type: 'address', value: recipient, format: 'address' },
      ]
    },
  },
  // ── THORChain Router ──
  // deposit(vault, asset, amount, memo) [0x1fece7b4] and
  // depositWithExpiry(vault, asset, amount, memo, expiry) [0x44bc937b].
  // Firmware clear-signs both; recognize both so the plain deposit() path is
  // not over-gated into blind-signing. (keepkey-firmware thortx.h selectors.)
  { selector: '0x1fece7b4', method: 'Deposit (THORChain)', decode: decodeThorDeposit },
  { selector: '0x44bc937b', method: 'Deposit (THORChain)', decode: decodeThorDeposit },
]

/**
 * Synchronous, OFFLINE calldata decode — runs ONLY the local registry above
 * (no Pioneer/network). For contexts that must not block on I/O, like the
 * emulator confirm dialog. Returns the method name + decoded fields, or null if
 * the selector isn't known locally. Never throws.
 */
export function decodeCalldataLocal(
  data: string,
): { method: string; selector: string; fields: CalldataDecodedField[] } | null {
  if (!data || data.length < 10) return null
  const selector = data.slice(0, 10).toLowerCase()
  for (const d of LOCAL_DECODERS) {
    if (d.selector === selector) {
      try {
        return { method: d.method, selector, fields: d.decode(data) }
      } catch {
        return { method: d.method, selector, fields: [] }
      }
    }
  }
  return null
}

// ── Firmware clear-sign allowlist (mirrors device ethereum_contractHandled) ──
//
// rc3 firmware clear-signs a contract call WITHOUT AdvancedMode and WITHOUT any
// signed-metadata blob ONLY for the pinned (selector, to) pairs below, plus a
// standard 68-byte ERC-20 transfer/approve. Anything else the device blind-signs
// (hard "Blocked" unless AdvancedMode is on). The signing overlay MUST gate off
// THIS — not off "did our decoder recognize the calldata" — otherwise it either
// under-warns (Uniswap/1inch/relay look verified but the device blind-signs) or
// over-forces global AdvancedMode on txs the device would clear-sign natively
// (the drain vector PR #261/#303 closed). Addresses copied from firmware
// lib/firmware/ethereum_contracts/*.{c,h} on origin/develop (the rc3 line).
const ADDR = {
  ZX_EXCHANGE_PROXY: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x transformERC20 / sellToUniswap
  UNISWAP_V2_ROUTER: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // 0x liquid add/remove + approve-to-router
  SALARY_PROXY:      '0xbd6a40bb904aea5a49c59050b5395f7484a4203d', // saproxy withdrawFromSalary
  THOR_ROUTER:       '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146',
  MAYA_ROUTER:       '0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2',
}

// selector → the ONE contract address the firmware pins that selector to.
const FIRMWARE_PINNED: Record<string, string> = {
  '0x415565b0': ADDR.ZX_EXCHANGE_PROXY, // transformERC20
  '0xd9627aa4': ADDR.ZX_EXCHANGE_PROXY, // sellToUniswap (0x)
  '0xf305d719': ADDR.UNISWAP_V2_ROUTER, // addLiquidityETH
  '0x02751cec': ADDR.UNISWAP_V2_ROUTER, // removeLiquidityETH
  '0xfea7c53f': ADDR.SALARY_PROXY,      // withdrawFromSalary
  '0x1fece7b4': ADDR.THOR_ROUTER,       // THORChain deposit
  '0x44bc937b': ADDR.THOR_ROUTER,       // THORChain depositWithExpiry
}
// THOR/Maya share both deposit selectors — accept either router for either.
const THOR_MAYA_DEPOSIT = new Set(['0x1fece7b4', '0x44bc937b'])

/** ERC-20 transfer/approve the firmware renders natively (standard 68-byte). */
const ERC20_NATIVE = new Set(['0xa9059cbb', '0x095ea7b3'])

/**
 * True iff the rc3 device clear-signs this tx natively (no AdvancedMode, no
 * signed blob). Mirrors firmware `ethereum_contractHandled` + the standard
 * ERC-20 transfer/approve path in ethereum.c. Contract-address pinning matters:
 * the same selector to a DIFFERENT address is NOT clear-signed by the device.
 */
export function firmwareClearSigns(to?: string, data?: string, _chainId?: number): boolean {
  if (!to || !data || data.length < 10) return false
  const selector = data.slice(0, 10).toLowerCase()
  const dest = to.toLowerCase()

  // Standard ERC-20 transfer/approve: 4-byte selector + 2 32-byte words = 68B.
  // ponytail: firmware also requires the token be in its built-in registry
  // (unknown tokens hard-block); we can't cheaply mirror that list, so an exotic
  // token defers to the device's own "enable AdvancedMode" prompt — benign UX,
  // never an under-warn. Upgrade path: ship the token list into Vault.
  if (ERC20_NATIVE.has(selector) && (data.length - 2) === 136) return true

  if (THOR_MAYA_DEPOSIT.has(selector)) {
    return dest === ADDR.THOR_ROUTER || dest === ADDR.MAYA_ROUTER
  }
  const pinned = FIRMWARE_PINNED[selector]
  return pinned != null && dest === pinned
  // ponytail: MakerDAO (address+param gated, rare) intentionally omitted → those
  // over-warn as blind. Add if a MakerDAO clear-sign flow actually shows up.
}

// ── Main decode function ─────────────────────────────────────────────────

export async function decodeCalldata(
  contractAddress: string,
  data: string,
  _chainId?: number,
): Promise<CalldataDecodedInfo | null> {
  // Skip if no calldata or just a bare transfer (no data)
  if (!data || data === '0x' || data.length < 10) return null

  const selector = data.slice(0, 10).toLowerCase()

  // Tier 1: Local decoders (offline, instant)
  for (const decoder of LOCAL_DECODERS) {
    if (selector === decoder.selector && data.length >= 10) {
      // Derive dApp name from method — DeFi protocols get their own name
      const method = decoder.method
      let dappName = 'ERC-20'
      if (method.includes('Uniswap')) dappName = 'Uniswap'
      else if (method.includes('1inch')) dappName = '1inch'
      else if (method.includes('THORChain')) dappName = 'THORChain'
      else if (method.includes('Wrap') || method.includes('Unwrap')) dappName = 'WETH'
      else if (method.includes('NFT')) dappName = 'NFT'

      return {
        dappName,
        contractName: contractAddress,
        method: decoder.method,
        selector,
        fields: decoder.decode(data),
        source: 'local',
      }
    }
  }

  // Tier 2: Unknown — return selector only
  return {
    dappName: 'Unknown',
    contractName: contractAddress,
    method: `Unknown (${selector})`,
    selector,
    fields: [],
    source: 'none',
  }
}
