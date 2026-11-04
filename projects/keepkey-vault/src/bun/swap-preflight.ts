import { evmRpc, evmSimulationCall, type EvmSimulationTx } from './evm-effects'

/** Read-only execution of the exact prepared call, after any approval is mined.
 * Transport errors are failures to check, never permission to spend gas. */
export async function assertPrebuiltSwapExecution(
  endpoint: string | undefined,
  tx: EvmSimulationTx,
  rpc: typeof evmRpc = evmRpc,
): Promise<void> {
  if (!endpoint) throw new Error('Cannot check swap execution: no EVM service is configured. The swap transaction was not signed.')
  try {
    const result = await rpc(endpoint, 'eth_call', [evmSimulationCall(tx), 'pending'])
    if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result)) {
      throw new Error('EVM service returned no valid execution result')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Swap execution check failed: ${reason}. The swap transaction was not signed or broadcast. Refresh the quote and try again.`)
  }
}
