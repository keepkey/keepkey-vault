/** Quote estimates can change with pool/token storage state before inclusion. */
export function bufferedSwapGasLimit(limit: string, data: string): string {
  if (!/^(?:[1-9]\d*|0x[0-9a-f]+)$/i.test(limit) || BigInt(limit) <= 0n) {
    throw new Error('Swap quote returned an invalid gas limit. Refresh the quote.')
  }
  const gas = BigInt(limit)
  // Plain transfers/deposit channels retain their quoted limit. Contract calls
  // receive the same 20% headroom used by the normal EVM estimator.
  return data.length >= 10 ? ((gas * 120n + 99n) / 100n).toString() : gas.toString()
}
