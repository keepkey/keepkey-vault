/**
 * Calldata decoder — decodes EVM transaction calldata into human-readable fields
 * for the signing approval UI.
 *
 * Three tiers:
 * 1. Pioneer client SDK — DecodeCalldata + SignDescriptor (remote, comprehensive)
 * 2. Local fallback for common ERC-20 functions (transfer, approve, transferFrom)
 * 3. Unknown — selector only
 *
 * All Pioneer calls go through @pioneer-platform/pioneer-client via getPioneer().
 * The only exception is /descriptors/sign which is not yet in the public swagger
 * spec — that uses a direct fetch until the spec is regenerated.
 */
import type { CalldataDecodedInfo, CalldataDecodedField } from '../shared/types'
import { getPioneer, getPioneerApiBase } from './pioneer'

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

// ── Chain ID → CAIP-2 mapping ────────────────────────────────────────────

function chainIdToNetworkId(chainId: number): string {
  return `eip155:${chainId}`
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

// ── Pioneer SDK calls ───────────────────────────────────────────────────

interface PioneerDecodeResponse {
  success: boolean
  dappName: string
  contractName: string
  method: string
  selector: string
  functionType?: string
  args: Array<{ name: string; type: string; value: string; format?: string }>
}

interface PioneerSignResponse {
  success: boolean
  signedPayload: string      // base64 signed insight blob
  keyId: number
  classification: 'VERIFIED' | 'UNKNOWN'
  dappName?: string
  contractName?: string
  method?: string
  txHash?: string            // the sighash the blob is bound to (== device's sighash)
}

/**
 * The full unsigned-tx fields /descriptors/sign needs to bind the blob to the
 * exact sighash the device will sign. MUST be byte-identical to the values
 * later passed to ethSignTx — any drift and rc3 firmware refuses the blob.
 */
export interface EvmUnsignedTxFields {
  nonce: string | number
  gasLimit: string | number
  value: string | number
  gasPrice?: string | number
  maxFeePerGas?: string | number
  maxPriorityFeePerGas?: string | number
}

/**
 * Decode calldata via pioneer-client SDK (DecodeCalldata operationId).
 * 3s timeout — non-blocking for signing flow.
 */
async function fetchPioneerDecode(
  networkId: string,
  contractAddress: string,
  data: string
): Promise<PioneerDecodeResponse | null> {
  try {
    const pioneer = await Promise.race([
      getPioneer(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])
    if (!pioneer?.DecodeCalldata) return null

    const resp = await Promise.race([
      pioneer.DecodeCalldata({ networkId, contractAddress, data }),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])
    const result = resp?.data as PioneerDecodeResponse | undefined
    return result?.success ? result : null
  } catch {
    // Pioneer not ready, timeout, or method missing — fall through to local
    return null
  }
}

/**
 * Fetch signed insight blob from Pioneer.
 *
 * NOTE: SignDescriptor is not yet in the public swagger spec so pioneer-client
 * doesn't auto-generate the method. Using direct fetch until the Pioneer server
 * regenerates its spec (tsoa spec-and-routes). Once the spec includes
 * operationId "SignDescriptor", switch to: pioneer.SignDescriptor({...})
 */
async function fetchPioneerSignedBlob(
  chainId: number,
  contractAddress: string,
  data: string,
  tx?: EvmUnsignedTxFields
): Promise<PioneerSignResponse | null> {
  // The blob's tx_hash covers nonce/gas/value/fees — without the full tx the
  // server 400s (and any blob it could make would fail the rc3 hash binding).
  if (!tx) return null
  const request = { chainId, contractAddress, data, ...tx }
  try {
    // Try SDK first (available once spec is regenerated)
    const pioneer = await Promise.race([
      getPioneer(),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])
    if (pioneer?.SignDescriptor) {
      const resp = await Promise.race([
        pioneer.SignDescriptor(request),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ])
      const result = resp?.data as PioneerSignResponse | undefined
      return (result?.success && result.signedPayload) ? result : null
    }

    // Fallback: direct fetch until spec is regenerated
    const base = getPioneerApiBase()
    const resp = await fetch(`${base}/api/v1/descriptors/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) return null
    const result = await resp.json() as PioneerSignResponse
    return (result.success && result.signedPayload) ? result : null
  } catch {
    return null
  }
}

// ── Main decode function ─────────────────────────────────────────────────

export async function decodeCalldata(
  contractAddress: string,
  data: string,
  chainId?: number,
  tx?: EvmUnsignedTxFields,
): Promise<CalldataDecodedInfo | null> {
  // Skip if no calldata or just a bare transfer (no data)
  if (!data || data === '0x' || data.length < 10) return null

  const selector = data.slice(0, 10).toLowerCase()

  // Tier 1: Try Pioneer SDK — fetch decode + signed blob in parallel
  // Default to Ethereum mainnet (1) when chainId is missing — most contract
  // calls target mainnet, and omitting chainId shouldn't skip Pioneer entirely.
  const resolvedChainId = chainId || 1
  if (resolvedChainId) {
    const networkId = chainIdToNetworkId(resolvedChainId)
    const [pioneer, signedBlobRaw] = await Promise.all([
      fetchPioneerDecode(networkId, contractAddress, data),
      fetchPioneerSignedBlob(resolvedChainId, contractAddress, data, tx),
    ])

    // Only attach VERIFIED blobs. An OPAQUE/UNKNOWN blob doesn't enable
    // clear-sign — rc3 fail-closes on it — and attaching it would just mask
    // the honest "unverified contract call" state from the UI/device paths.
    const signedBlob = signedBlobRaw?.classification === 'VERIFIED' ? signedBlobRaw : null
    if (signedBlobRaw) {
      console.log(`[calldata] Pioneer /sign: classification=${signedBlobRaw.classification} keyId=${signedBlobRaw.keyId} txHash=${signedBlobRaw.txHash ?? '(n/a)'} attach=${!!signedBlob}`)
    }

    if (pioneer) {
      const fields: CalldataDecodedField[] = pioneer.args.map((arg) => ({
        name: arg.name,
        type: arg.type,
        value: arg.value,
        format: mapFormat(arg.type, arg.format),
      }))

      return {
        dappName: pioneer.dappName,
        contractName: pioneer.contractName,
        method: pioneer.method,
        selector,
        functionType: pioneer.functionType,
        fields,
        source: 'pioneer',
        signedInsightBlob: signedBlob?.signedPayload,
        insightKeyId: signedBlob?.keyId,
        insightClassification: signedBlobRaw?.classification,
      }
    }

    // Pioneer decode failed but we got a VERIFIED blob — still useful
    if (signedBlob) {
      return {
        dappName: signedBlob.dappName || 'Unknown',
        contractName: signedBlob.contractName || contractAddress,
        method: signedBlob.method || `Unknown (${selector})`,
        selector,
        fields: [],
        source: 'pioneer',
        signedInsightBlob: signedBlob.signedPayload,
        insightKeyId: signedBlob.keyId,
        insightClassification: signedBlob.classification,
      }
    }
  }

  // Tier 2: Local decoders (offline, instant)
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

  // Tier 3: Unknown — return selector only
  return {
    dappName: 'Unknown',
    contractName: contractAddress,
    method: `Unknown (${selector})`,
    selector,
    fields: [],
    source: 'none',
  }
}

function mapFormat(solidityType: string, apiFormat?: string): CalldataDecodedField['format'] {
  if (apiFormat) {
    if (apiFormat.includes('AMOUNT')) return 'amount'
    if (apiFormat.includes('EIP55') || apiFormat.includes('ADDRESS')) return 'address'
  }
  if (solidityType === 'address') return 'address'
  if (solidityType.startsWith('uint') || solidityType.startsWith('int')) return 'amount'
  if (solidityType.startsWith('bytes')) return 'hex'
  return 'raw'
}
