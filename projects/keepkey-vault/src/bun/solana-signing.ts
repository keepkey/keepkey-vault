import { parseSolanaTx, solanaMessageSlice, SolanaTxParseError } from './solana-tx'

export type SolanaDeviceSigner = (params: any) => Promise<any>

/**
 * Route a serialized Solana transaction through the transaction-specific
 * firmware message and splice the returned signature into the original wire
 * transaction. The device receives the exact legacy/v0 message bytes, while
 * metadata and one-shot opaque-signing consent are forwarded unchanged.
 */
export async function signSolanaWireTransaction(
  unsignedTx: any,
  signWithDevice: SolanaDeviceSigner,
  logPrefix = 'signTx:solana',
): Promise<any> {
  const fullTx = Buffer.from(
    typeof unsignedTx.rawTx === 'string'
      ? unsignedTx.rawTx
      : Buffer.from(unsignedTx.rawTx).toString('base64'),
    'base64',
  )

  let parsed
  try {
    parsed = parseSolanaTx(fullTx)
  } catch (err) {
    if (err instanceof SolanaTxParseError) throw new Error(`[${logPrefix}] ${err.message}`)
    throw err
  }

  const messageBytes = solanaMessageSlice(fullTx, parsed)
  const deviceParams = {
    ...unsignedTx,
    rawTx: Buffer.from(messageBytes).toString('base64'),
  }
  console.debug(
    `[${logPrefix}] routing ${parsed.isVersioned ? 'v0' : 'legacy'} transaction ` +
    `through SolanaSignTx (${messageBytes.length}B message)`,
  )

  const result = await signWithDevice(deviceParams)
  if (!result?.signature) return result

  const sigBytes: Uint8Array = result.signature instanceof Uint8Array
    ? result.signature
    : Buffer.from(result.signature, 'base64')
  if (sigBytes.length !== 64) {
    throw new Error(`[${logPrefix}] Unexpected signature length ${sigBytes.length}`)
  }

  const rawBytes = Buffer.from(fullTx)
  if (rawBytes.length < parsed.sigStart + 64) {
    throw new Error(`[${logPrefix}] Raw tx too short to hold signature`)
  }
  for (let i = 0; i < 64; i++) rawBytes[parsed.sigStart + i] = sigBytes[i]

  return {
    signature: sigBytes,
    serializedTx: rawBytes.toString('base64'),
  }
}
