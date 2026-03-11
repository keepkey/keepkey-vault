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

  const symbol = decodeString(symbolHex) || 'UNKNOWN'
  const name = decodeString(nameHex) || symbol
  const decimals = parseInt(decimalsHex, 16)

  return { symbol, name, decimals: isNaN(decimals) ? 18 : decimals }
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

/** Get ERC-20 decimals via eth_call */
export async function getErc20Decimals(rpcUrl: string, tokenContract: string): Promise<number> {
  const result = await ethCall(rpcUrl, tokenContract, '0x313ce567') // decimals()
  // If RPC returns empty/zero, fall back to 18 (0x12 hex = 18 decimal, the ERC-20 standard default)
  return Number(BigInt(result || '0x12'))
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
