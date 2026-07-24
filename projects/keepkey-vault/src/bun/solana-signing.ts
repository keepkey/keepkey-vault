import bs58 from 'bs58'
import {
  parseSolanaMessage,
  parseSolanaTx,
  solanaMessageSlice,
  SolanaTxParseError,
} from './solana-tx'

export type SolanaDeviceSigner = (params: any) => Promise<any>
export type SolanaAddressDeriver = (addressNList: number[]) => Promise<string>

/**
 * Route a serialized Solana transaction through the transaction-specific
 * firmware message and splice the returned signature into the original wire
 * transaction. The device receives the exact legacy/v0 message bytes, while
 * metadata and one-shot opaque-signing consent are forwarded unchanged.
 */
export async function signSolanaWireTransaction(
  unsignedTx: any,
  signWithDevice: SolanaDeviceSigner,
  deriveSignerAddress: SolanaAddressDeriver,
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
  const message = parseSolanaMessage(messageBytes)
  if (message.header.numRequiredSignatures !== parsed.sigCount) {
    throw new Error(
      `[${logPrefix}] Signature count mismatch: wrapper declares ${parsed.sigCount}, ` +
      `message requires ${message.header.numRequiredSignatures}`,
    )
  }

  const addressNList = unsignedTx.addressNList || unsignedTx.address_n
  if (!Array.isArray(addressNList)) {
    throw new Error(`[${logPrefix}] addressNList is required to select the signer slot`)
  }
  const signerAddress = await deriveSignerAddress(addressNList)
  let signerPublicKey: Uint8Array
  try {
    signerPublicKey = bs58.decode(signerAddress)
  } catch {
    throw new Error(`[${logPrefix}] Invalid derived signer address`)
  }
  if (signerPublicKey.length !== 32) {
    throw new Error(
      `[${logPrefix}] Invalid derived signer address length ${signerPublicKey.length} (expected 32)`,
    )
  }

  // Required signers are the first N static message accounts. Find the slot
  // belonging to this address before asking the device to sign; slot zero may
  // already contain a cosigner signature in a multisig transaction.
  const signerIndex = message.staticAccounts
    .slice(0, message.header.numRequiredSignatures)
    .findIndex((account) => Buffer.from(account).equals(Buffer.from(signerPublicKey)))
  if (signerIndex < 0) {
    throw new Error(
      `[${logPrefix}] Derived wallet account ${signerAddress} is not a required transaction signer`,
    )
  }

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
  const slotOffset = parsed.sigStart + signerIndex * 64
  if (rawBytes.length < slotOffset + 64) {
    throw new Error(`[${logPrefix}] Raw tx too short to hold signer slot ${signerIndex}`)
  }
  for (let i = 0; i < 64; i++) rawBytes[slotOffset + i] = sigBytes[i]

  return {
    signature: sigBytes,
    serializedTx: rawBytes.toString('base64'),
  }
}
