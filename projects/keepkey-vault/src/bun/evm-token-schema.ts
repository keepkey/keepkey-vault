import type { EvmSchemaSpec } from './evm-certified-schema'

/** Only complete, fixed-word ERC-20 calls have a generic device schema. */
export function tokenCallShape(chainId: number, contract: string, selector: string, length: number): boolean {
  return Number.isInteger(chainId) && chainId > 0 && chainId <= 0xffffffff
    && /^0x[0-9a-f]{40}$/i.test(contract) && !/^0x0{40}$/i.test(contract)
    && ((['0x095ea7b3', '0xa9059cbb'].includes(selector.toLowerCase()) && length === 68)
      || (selector.toLowerCase() === '0x23b872dd' && length === 100))
}

export function buildTokenSchema(chainId: number, contract: string, selector: string, length: number,
  token: { symbol: string; decimals: number }): EvmSchemaSpec {
  if (!tokenCallShape(chainId, contract, selector, length)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,9}$/.test(token.symbol)
    || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
    throw new Error('Unsupported token identity or calldata shape')
  }
  selector = selector.toLowerCase()
  const approval = selector === '0x095ea7b3'
  return {
    chainId, contract: contract.toLowerCase(), selector,
    method: `${token.symbol} ${approval ? 'approval' : 'transfer'}`,
    expectedCalldataLength: length,
    args: [
      ...(selector === '0x23b872dd' ? [{ name: 'From', format: 1 }] : []),
      { name: approval ? 'Spender' : 'Recipient', format: 1 },
      { name: approval ? 'Allowance' : 'Amount', format: 5, symbol: token.symbol, decimals: token.decimals },
    ],
    protocol: 'ERC-20', maintainedBy: 'KeepKey',
    action: approval ? 'Approve token spending' : 'Transfer tokens',
  }
}
