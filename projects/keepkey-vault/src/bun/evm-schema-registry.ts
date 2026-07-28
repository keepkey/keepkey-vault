/**
 * Signed EVM v2 clear-sign schemas, looked up per transaction.
 *
 * A v2 schema describes ONE (chain, contract, selector): the method name and
 * the labelled args, each one 32-byte ABI word. It carries no amounts and no
 * transaction hash, so a single signature covers every future call to that
 * method — the device decodes the values out of the calldata it is about to
 * sign. That is why this can be a static registry at all, unlike the v1
 * per-transaction blobs which must commit to a sighash.
 *
 * Attaching a schema does not weaken anything: firmware still verifies the
 * signature against a trusted ClearSign key, still requires the declared arg
 * widths to account for the calldata exactly, and for a payable call still
 * shows the native amount screen. A wrong or unsigned schema is refused, not
 * silently trusted.
 */
import registry from './evm-schemas-local.json'

export interface SignedEvmSchema {
  method: string
  keyId: number
  /** 0x-prefixed hex — the format hdwallet's ethSignTx expects. */
  signedPayload: string
  /** 4 + 32*num_args; firmware requires the calldata to match exactly. */
  expectedCalldataLength: number
}

const SCHEMAS: Record<string, SignedEvmSchema> = (registry as any).schemas ?? {}

/**
 * Find a schema for this call, or undefined. Returns undefined rather than
 * throwing on any doubt — a missing schema means the existing (blind-sign)
 * behaviour, never a blocked transaction.
 */
export function findEvmSchema(
  chainId: number | undefined,
  to: string | undefined,
  data: string | undefined,
): SignedEvmSchema | undefined {
  if (!chainId || !to || !data) return undefined
  const calldata = data.startsWith('0x') ? data.slice(2) : data
  if (calldata.length < 8) return undefined
  const selector = '0x' + calldata.slice(0, 8).toLowerCase()
  const schema = SCHEMAS[`${chainId}:${to.toLowerCase()}:${selector}`]
  if (!schema) return undefined
  // The device enforces this too, but checking here keeps a stale registry
  // entry from producing a confusing on-device refusal mid-signing.
  if (calldata.length / 2 !== schema.expectedCalldataLength) return undefined
  return schema
}
