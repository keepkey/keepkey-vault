import { firmwareClearSigns } from './calldata-decoder'
import { isCertifiedEvmMetadata } from './evm-schema-registry'
import { ERC7730_TRANSPORT_SUPPORTED } from '../shared/erc7730-support'

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
  erc7730?: unknown,
): boolean {
  return typeof data === 'string' && data.length > 2 &&
    !firmwareClearSigns(to, data, chainId) &&
    !isCertifiedEvmMetadata(metadata) &&
    // The device verifies every signed catalog envelope and refuses signing on
    // any authentication/identity failure, so a catalog can enter that strict
    // path without host AdvancedMode. It cannot silently become blind signing.
    // NOT_IMPLEMENTED with the pinned hdwallet: see shared/erc7730-support.
    !(ERC7730_TRANSPORT_SUPPORTED && erc7730 && typeof erc7730 === 'object') &&
    advancedMode === false
}
