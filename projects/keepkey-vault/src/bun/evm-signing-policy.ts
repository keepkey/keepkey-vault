import { firmwareClearSigns } from './calldata-decoder'
import { supportsErc7730Transport } from '../shared/erc7730-support'
import { erc7730CatalogDescribesCall } from './erc7730-resolver'
import { certifiedEnvelopeShown, metadataPayloadBytes } from '../shared/certified-evm-envelope'

/**
 * Host-side mirror of the device's default EVM policy.
 *
 * A native firmware decode, or a 7.16 root-certified envelope the device shows
 * for this exact call, can proceed with AdvancedMode off. So can a KeepKey
 * ClearSign service ERC-7730 definition Desktop fetched and checked for this
 * exact call, on a device that takes one (`capabilities`). Runtime/self-service
 * metadata is never treated as a substitute for AdvancedMode here; the device
 * independently enforces the same distinction before it signs.
 */
export function evmCallRequiresAdvancedMode(
  to: string | undefined,
  data: string | undefined,
  chainId: number | undefined,
  advancedMode: boolean | undefined,
  metadata?: unknown,
  erc7730?: unknown,
  firmwareVersion?: string,
  value?: unknown,
  capabilities?: readonly number[],
): boolean {
  const m = metadata as { signedPayload?: unknown; keyId?: unknown } | null | undefined
  return typeof data === 'string' && data.length > 2 &&
    !firmwareClearSigns(to, data, chainId, firmwareVersion, value) &&
    !certifiedEnvelopeShown(metadataPayloadBytes(m?.signedPayload), m?.keyId, firmwareVersion, { chainId, to, data }) &&
    // One description per transaction: kind-1 metadata wins, so a catalog
    // beside it is never sent. A refused definition falls back to this same
    // gate (erc7730-resolver signWithErc7730Fallback).
    !(!m?.signedPayload && supportsErc7730Transport(firmwareVersion, capabilities)
      && erc7730CatalogDescribesCall(erc7730, chainId, to, data)) &&
    advancedMode === false
}
