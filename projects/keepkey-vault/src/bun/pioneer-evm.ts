/** Adapt Pioneer's EVM endpoints to the quantities consumed by the signer.
 * Node selection and failover belong to Pioneer. This module has no node URLs
 * and never falls back to a public RPC when Pioneer reports an error.
 */
import { utils } from 'ethers'

export function evmSourceForChain(
  chain: { id: string; chainFamily: string; networkId: string },
  customRpcUrl?: string,
): string | undefined {
  if (chain.chainFamily !== 'evm') return undefined
  if (chain.id.startsWith('evm-custom-')) return customRpcUrl
  return chain.networkId
}

function dataOf(response: any, operation: string): any {
  const data = response?.data
  if (data == null || data.success === false) {
    throw new Error(`Pioneer ${operation} failed: ${data?.message || data?.error || 'missing response data'}`)
  }
  return data
}

function quantity(value: any, field: string): string {
  const raw = value?.hex ?? value
  if (
    (typeof raw !== 'string' && typeof raw !== 'number') ||
    (typeof raw === 'number' && !Number.isSafeInteger(raw)) ||
    !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(raw))
  ) throw new Error(`Pioneer returned an invalid ${field}`)
  return `0x${BigInt(raw).toString(16)}`
}

function units(value: any, decimals: number, field: string): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Pioneer returned an invalid ${field}`)
  }
  return quantity(utils.parseUnits(value, decimals).toString(), field)
}

export async function pioneerTokenMetadata(pioneer: any, networkId: string, contractAddress: string) {
  const result = dataOf(await pioneer.LookupTokenMetadata({ networkId, contractAddress }), 'LookupTokenMetadata')
  const meta = result.data
  if (!meta?.symbol || !Number.isInteger(meta.decimals) || meta.decimals < 0 || meta.decimals > 255) {
    throw new Error('Pioneer returned invalid token metadata')
  }
  return { symbol: String(meta.symbol), name: String(meta.name || meta.symbol), decimals: meta.decimals as number }
}

/** Only operations exposed by Pioneer's API are admitted. Unsupported methods
 * fail explicitly; quote/gas-limit fallback policy remains with the caller.
 */
export async function pioneerEvmRpc(pioneer: any, networkId: string, method: string, params: any[]): Promise<any> {
  if (!/^eip155:[1-9]\d*$/.test(networkId)) throw new Error(`Invalid EVM network: ${networkId}`)
  switch (method) {
    case 'eth_chainId':
      return quantity(networkId.slice(7), 'chainId')
    case 'eth_getTransactionCount': {
      // Pioneer uses the pending count, including transactions in the mempool.
      const data = dataOf(await pioneer.GetNonceByNetwork({ networkId, address: params[0] }), 'GetNonceByNetwork')
      return quantity(data.nonce, 'nonce')
    }
    case 'eth_getBalance': {
      const data = dataOf(await pioneer.GetBalanceAddressByNetwork({ networkId, address: params[0] }), 'GetBalanceAddressByNetwork')
      return units(String(data.nativeBalance ?? data.balance ?? ''), 18, 'native balance')
    }
    case 'eth_gasPrice': {
      const data = dataOf(await pioneer.GetGasPriceByNetwork({ networkId }), 'GetGasPriceByNetwork')
      // Pioneer reports gas prices in gwei, including fractional numeric values.
      const gwei = Number(data.average ?? data.fast ?? data)
      if (!Number.isFinite(gwei) || gwei <= 0) throw new Error('Pioneer returned an invalid gas price')
      return quantity(Math.ceil(gwei * 1e9), 'gas price')
    }
    case 'eth_getTransactionReceipt': {
      const data = dataOf(await pioneer.LookupTx({ networkId, txid: params[0] }), 'LookupTx')
      if (!data.data || !Object.prototype.hasOwnProperty.call(data.data, 'receipt')) throw new Error('Pioneer returned no receipt field')
      const receipt = data.data.receipt
      if (receipt === null) return null
      const status = quantity(receipt?.status, 'receipt status')
      if (status !== '0x0' && status !== '0x1') throw new Error('Pioneer returned an invalid receipt status')
      return {
        status,
        gasUsed: quantity(receipt.gasUsed, 'receipt gasUsed'),
        blockNumber: quantity(receipt.blockNumber, 'receipt blockNumber'),
      }
    }
    case 'eth_sendRawTransaction': {
      const serialized = String(params[0]).startsWith('0x') ? params[0] : `0x${params[0]}`
      const data = dataOf(await pioneer.Broadcast({ networkId, serialized }), 'Broadcast')
      const txid = typeof data === 'string' ? data : data.txid ?? data.tx_hash ?? data.hash
      if (typeof txid !== 'string' || !/^0x[0-9a-f]{64}$/i.test(txid)) throw new Error('Pioneer Broadcast returned no valid transaction hash')
      return txid
    }
    case 'eth_call': {
      const { to: contractAddress, data: calldata } = params[0] ?? {}
      if (typeof calldata !== 'string' || !/^0x[0-9a-f]+$/i.test(calldata)) throw new Error('Invalid ERC-20 calldata')
      const selector = calldata.slice(0, 10).toLowerCase()
      const addressAt = (offset: number) => `0x${calldata.slice(offset + 24, offset + 64)}`
      let result: string
      if (selector === '0x313ce567' && calldata.length === 10) {
        const data = dataOf(await pioneer.GetTokenDecimals({ networkId, contractAddress }), 'GetTokenDecimals')
        result = quantity(data.decimals, 'token decimals')
        if (BigInt(result) > 255n) throw new Error('Pioneer returned invalid token decimals')
      } else if (selector === '0x70a08231' && calldata.length === 74) {
        const [balanceResponse, decimalsResponse] = await Promise.all([
          pioneer.GetTokenBalance({ networkId, address: addressAt(10), contractAddress }),
          pioneer.GetTokenDecimals({ networkId, contractAddress }),
        ])
        const balance = dataOf(balanceResponse, 'GetTokenBalance').data
        const decimals = Number(quantity(dataOf(decimalsResponse, 'GetTokenDecimals').decimals, 'token decimals'))
        if (decimals > 255) throw new Error('Pioneer returned invalid token decimals')
        // Token balance is human-readable; allowance below is already base units.
        result = units(balance, decimals, 'token balance')
      } else if (selector === '0xdd62ed3e' && calldata.length === 138) {
        const data = dataOf(await pioneer.GetTokenAllowance({
          networkId, contractAddress, ownerAddress: addressAt(10), spenderAddress: addressAt(74),
        }), 'GetTokenAllowance')
        result = quantity(data.data?.allowance, 'token allowance')
      } else {
        throw new Error(`Pioneer does not expose this eth_call selector: ${selector}`)
      }
      return `0x${result.slice(2).padStart(64, '0')}`
    }
    default:
      throw new Error(`Pioneer does not expose ${method}; no direct-node fallback is allowed`)
  }
}
