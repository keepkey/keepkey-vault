import { findCertifiedUniswapSwap, resolveEvmSchema } from './evm-schema-registry'
import { findReviewedUniversalRouter } from './evm-certified-schema'
import { urPrecheck } from './uniswap-ur'

/** Use the same verified description for route choice, preview, and signing. */
export async function resolveSwapEvmSchema(
  chainId: number, to: string, data: string, certified: boolean,
  firmwareVersion?: string, value?: unknown,
) {
  if (certified && findReviewedUniversalRouter(chainId, to)) {
    let amount: bigint
    try { amount = BigInt(String(value ?? '0')) } catch { return undefined }
    const plan = urPrecheck(to, data, amount, firmwareVersion)
    if (!plan) return undefined
    const entry = await findCertifiedUniswapSwap(chainId, to, plan.selector, plan.tokens)
    return entry ? { ...entry, source: 'certified-service' as const } : undefined
  }
  return resolveEvmSchema(chainId, to, data, certified, firmwareVersion, value)
}
