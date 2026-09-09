import { firmwareClearSigns } from './calldata-decoder'
import { isCertifiedEvmMetadata } from './evm-schema-registry'

/**
 * Host-side mirror of the device's default EVM policy.
 *
 * A native firmware decode or a 7.16 root-certified envelope can proceed with
 * AdvancedMode off. Runtime/self-service metadata is never treated as a
 * substitute for AdvancedMode here; the device independently enforces the
 * same distinction before it signs.
 */
export function evmCallRequiresAdvancedMode(
  to: string | undefined,
  data: string | undefined,
  chainId: number | undefined,
  advancedMode: boolean | undefined,
  metadata?: unknown,
): boolean {
  return typeof data === 'string' && data.length > 2 &&
    !firmwareClearSigns(to, data, chainId) &&
    !isCertifiedEvmMetadata(metadata) &&
    advancedMode === false
}
