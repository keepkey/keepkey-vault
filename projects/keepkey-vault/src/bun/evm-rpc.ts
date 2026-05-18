/**
 * Minimal EVM JSON-RPC utilities for direct node interaction.
 * Used for custom token metadata lookups and custom chain operations.
 */

export const EVM_RPC_URLS: Record<string, string> = {
  '1': 'https://ethereum-rpc.publicnode.com',
  '137': 'https://polygon-rpc.com',
  '42161': 'https://arb1.arbitrum.io/rpc',
  '10': 'https://mainnet.optimism.io',
  '43114': 'https://api.avax.network/ext/bc/C/rpc',
  '56': 'https://bsc-dataseed.binance.org',
  '8453': 'https://mainnet.base.org',
  '143': 'https://rpc.monad.xyz',
  '2868': 'https://rpc.hyperliquid.xyz',
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  const json = await resp.json() as { result?: string; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result || '0x'
}

async function ethRpc(rpcUrl: string, method: string, params: any[]): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await resp.json() as { result?: any; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}

function decodeString(hex: string): string {
  if (!hex || hex === '0x' || hex.length < 130) return ''
  // ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  const lenHex = stripped.slice(64, 128)
  const len = parseInt(lenHex, 16)
  if (isNaN(len) || len === 0 || len > 256) return ''
  const dataHex = stripped.slice(128, 128 + len * 2)
  // Decode UTF-8 from hex
  const bytes = new Uint8Array(dataHex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(dataHex.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder().decode(bytes)
}

// ERC-20 function selectors
const SYMBOL_SIG = '0x95d89b41'
const NAME_SIG = '0x06fdde03'
const DECIMALS_SIG = '0x313ce567'

export async function getTokenMetadata(rpcUrl: string, contractAddress: string): Promise<{ symbol: string; name: string; decimals: number }> {
  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    ethCall(rpcUrl, contractAddress, SYMBOL_SIG),
    ethCall(rpcUrl, contractAddress, NAME_SIG),
    ethCall(rpcUrl, contractAddress, DECIMALS_SIG),
  ])

  // Reject contracts that don't actually implement ERC-20 metadata. The
  // previous fallbacks (`'UNKNOWN'`, `18`) made every successful eth_call —
  // even ones returning empty data for an EOA or a non-token contract that
  // happens to live at this address on this chain — look like a valid token.
  // The asset picker's multi-chain probe then surfaced an "UNKNOWN/UNKNOWN"
  // row for every chain that didn't error, even when the contract genuinely
  // doesn't exist there. Throw on missing data so the caller's per-chain
  // catch can drop the hit.
  const symbol = decodeString(symbolHex)
  if (!symbol) {
    throw new Error(`No ERC-20 symbol() at ${contractAddress} — not a token here`)
  }
  if (!decimalsHex || decimalsHex === '0x') {
    throw new Error(`No ERC-20 decimals() at ${contractAddress} — not a token here`)
  }
  const decimals = parseInt(decimalsHex, 16)
  if (isNaN(decimals)) {
    throw new Error(`Malformed ERC-20 decimals() at ${contractAddress}`)
  }
  const name = decodeString(nameHex) || symbol

  return { symbol, name, decimals }
}

/** Check ERC-20 allowance(owner, spender) via eth_call */
export async function getErc20Allowance(rpcUrl: string, tokenContract: string, owner: string, spender: string): Promise<bigint> {
  const selector = 'dd62ed3e' // allowance(address,address)
  const ownerPad = owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const spenderPad = spender.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const data = '0x' + selector + ownerPad + spenderPad
  const result = await ethCall(rpcUrl, tokenContract, data)
  return BigInt(result || '0x0')
}

/** Check ERC-20 balanceOf(owner) via eth_call */
export async function getErc20Balance(rpcUrl: string, tokenContract: string, owner: string): Promise<bigint> {
  const selector = '70a08231' // balanceOf(address)
  const ownerPad = owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const data = '0x' + selector + ownerPad
  const result = await ethCall(rpcUrl, tokenContract, data)
  return BigInt(result || '0x0')
}

/** Get ERC-20 decimals via eth_call. Throws if the call fails or returns empty — caller must handle. */
export async function getErc20Decimals(rpcUrl: string, tokenContract: string): Promise<number> {
  const result = await ethCall(rpcUrl, tokenContract, '0x313ce567') // decimals()
  if (!result || result === '0x' || result === '0x0') {
    throw new Error(`ERC-20 decimals() returned empty for ${tokenContract} — contract may not implement decimals()`)
  }
  return Number(BigInt(result))
}

// ── Direct RPC methods for custom chains ─────────────────────────────

export async function getEvmBalance(rpcUrl: string, address: string): Promise<bigint> {
  const result = await ethRpc(rpcUrl, 'eth_getBalance', [address, 'latest'])
  return BigInt(result || '0x0')
}

export async function getEvmGasPrice(rpcUrl: string): Promise<bigint> {
  const result = await ethRpc(rpcUrl, 'eth_gasPrice', [])
  return BigInt(result || '0x0')
}

/** EIP-1559 fee data — uses eth_feeHistory to derive maxFeePerGas + priority fee.
 *  Falls back to null on chains that don't support it; caller uses legacy gasPrice.
 *
 *  Buffer policy: maxFeePerGas = nextBaseFee * 3 + priorityFee, with the priority
 *  fee floored at 1.5 gwei and sampled at the 60th percentile of recent blocks.
 *
 *  The 3x base-fee multiplier covers ~9 blocks of 12.5% growth (1.125^9 ≈ 2.88),
 *  vs ~6 blocks at 2x. Important because of a reflexive failure mode: if every
 *  wallet ships 2x and a wave of txs broadcasts together, the next-block base
 *  fee jumps and the whole wave becomes non-includable simultaneously — every
 *  user gets stuck for hours waiting for base fee to come back down. 3x leaves
 *  enough headroom for the network to absorb its own demand without orphaning
 *  the txs that triggered it. Real-world incident: 2026-05-11, network base
 *  fee climbed from ~1.3 to 4.5 gwei within minutes, all 2x-buffer txs stalled. */
export async function getEvmFeeData(rpcUrl: string): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null> {
  try {
    const hist = await ethRpc(rpcUrl, 'eth_feeHistory', ['0x4', 'latest', [60]])
    const baseFees = (hist?.baseFeePerGas || []).map((h: string) => BigInt(h))
    const priorityFees = (hist?.reward || []).map((blk: string[]) => BigInt(blk?.[0] || '0x0'))
    if (baseFees.length === 0) return null
    // Next-block base fee — last feeHistory entry is the predicted next block.
    const nextBaseFee = baseFees[baseFees.length - 1]
    // 60th-percentile priority fee, floored at 1.5 gwei. 1.5 gwei is the typical
    // ETH-mainnet inclusion tip in normal conditions; 1 gwei was leaving us
    // behind faster txs whenever the mempool warmed up.
    const sortedPriority = [...priorityFees].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const p60 = sortedPriority[Math.floor(sortedPriority.length * 0.6)] ?? 0n
    const minPriority = BigInt(1_500_000_000) // 1.5 gwei
    const maxPriorityFeePerGas = p60 > minPriority ? p60 : minPriority
    // 3x next base fee — see policy note above.
    const maxFeePerGas = nextBaseFee * 3n + maxPriorityFeePerGas
    return { maxFeePerGas, maxPriorityFeePerGas }
  } catch {
    return null
  }
}

export async function getEvmNonce(rpcUrl: string, address: string): Promise<number> {
  const result = await ethRpc(rpcUrl, 'eth_getTransactionCount', [address, 'latest'])
  return Number(BigInt(result || '0x0'))
}

/** Estimate gas for a tx, returning fallback on failure. Adds 20% buffer. */
export async function estimateGas(
  rpcUrl: string,
  tx: { to: string; from: string; data: string; value?: string },
  fallbackGas: bigint,
): Promise<bigint> {
  try {
    const result = await ethRpc(rpcUrl, 'eth_estimateGas', [tx])
    const estimated = BigInt(result || '0x0')
    return estimated > 0n ? estimated * 120n / 100n : fallbackGas // 20% buffer
  } catch {
    return fallbackGas
  }
}

export async function broadcastEvmTx(rpcUrl: string, signedTxHex: string): Promise<string> {
  const hex = signedTxHex.startsWith('0x') ? signedTxHex : `0x${signedTxHex}`
  const result = await ethRpc(rpcUrl, 'eth_sendRawTransaction', [hex])
  return result
}

/** Poll for tx receipt, returning null if not mined within maxWaitMs */
/** One-shot receipt check — does NOT wait. Returns null if tx isn't mined yet,
 *  the receipt {status, gasUsed} once it is. `status: false` means the tx
 *  reverted on-chain (call exception, allowance failure, etc.) — caller should
 *  surface this as a swap failure instead of waiting forever for a confirmation
 *  that already happened. */
export async function getTxReceiptOnce(
  rpcUrl: string,
  txHash: string,
): Promise<{ status: boolean; gasUsed: bigint; blockNumber: number } | null> {
  try {
    const receipt = await ethRpc(rpcUrl, 'eth_getTransactionReceipt', [txHash])
    if (!receipt || receipt.status === undefined) return null
    return {
      status: receipt.status === '0x1',
      gasUsed: BigInt(receipt.gasUsed || '0x0'),
      blockNumber: Number(BigInt(receipt.blockNumber || '0x0')),
    }
  } catch {
    return null
  }
}

export async function waitForTxReceipt(
  rpcUrl: string,
  txHash: string,
  maxWaitMs = 60_000,
  pollMs = 3_000,
): Promise<{ status: boolean; gasUsed: bigint } | null> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const receipt = await ethRpc(rpcUrl, 'eth_getTransactionReceipt', [txHash])
      if (receipt && receipt.status !== undefined) {
        return {
          status: receipt.status === '0x1',
          gasUsed: BigInt(receipt.gasUsed || '0x0'),
        }
      }
    } catch { /* not mined yet */ }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return null // timed out
}

export async function getEvmChainId(rpcUrl: string): Promise<number> {
  const result = await ethRpc(rpcUrl, 'eth_chainId', [])
  return Number(BigInt(result || '0x0'))
}
