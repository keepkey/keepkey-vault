import bs58 from 'bs58'
import {
  parseSolanaMessage,
  type ParsedSolanaMessage,
  parseSolanaTx,
  solanaMessageSlice,
  SolanaTxParseError,
} from './solana-tx'
import { prepareSolanaX402DeviceMetadata } from './solana-x402'
import { findPromotedSolanaArtifact } from './clearsign-artifact-resolver'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import type { AltAccountFetcher } from './solana-alt'
import {
  resolveCanonicalLutAccounts,
  SOL_MAX_HOST_LUT_ACCOUNTS,
  supportsHostLutAccounts,
} from './solana-lut-resolver'

export type SolanaDeviceSigner = (params: any) => Promise<any>
export type SolanaAddressDeriver = (addressNList: number[]) => Promise<string>

/**
 * Route a serialized Solana transaction through the transaction-specific
 * firmware message and splice the returned signature into the original wire
 * transaction. The device receives the exact legacy/v0 message bytes, while
 * metadata and one-shot opaque-signing consent are forwarded unchanged.
 *
 * With `altFetcher` and firmware 7.17.0+, a v0 message's lookup-table
 * accounts are resolved here and sent as `lutAccounts`, so the device can
 * decode the instructions (each resolved key marked as not verified by
 * KeepKey). It stays a blind sign on the device either way.
 */
export async function signSolanaWireTransaction(
  unsignedTx: any,
  signWithDevice: SolanaDeviceSigner,
  deriveSignerAddress: SolanaAddressDeriver,
  logPrefix = 'signTx:solana',
  getFirmwareVersion?: () => string | undefined,
  altFetcher?: AltAccountFetcher,
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
  // A promoted certified artifact is 7.16 authority material: older firmware
  // skips the fields, and the record would still say "certified".
  const promoted = unsignedTx.schema || !supportsCertifiedClearSign(getFirmwareVersion?.()) ? undefined : findPromotedSolanaArtifact(
    typeof unsignedTx.rawTx === 'string' ? unsignedTx.rawTx : Buffer.from(unsignedTx.rawTx).toString('base64'),
  )
  const effectiveUnsignedTx = promoted ? {
    ...unsignedTx, schema: promoted.schema, certificate: promoted.certificate,
  } : unsignedTx
  if (message.header.numRequiredSignatures !== parsed.sigCount) {
    throw new Error(
      `[${logPrefix}] Signature count mismatch: wrapper declares ${parsed.sigCount}, ` +
      `message requires ${message.header.numRequiredSignatures}`,
    )
  }

  const addressNList = effectiveUnsignedTx.addressNList || effectiveUnsignedTx.address_n
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

  const x402Metadata = effectiveUnsignedTx.x402
    ? prepareSolanaX402DeviceMetadata(message, effectiveUnsignedTx.x402, signerPublicKey)
    : undefined
  const deviceParams: any = {
    ...effectiveUnsignedTx,
    ...(x402Metadata || {}),
    rawTx: Buffer.from(messageBytes).toString('base64'),
  }
  // Only Desktop's own resolution reaches the device, never a caller's list.
  delete deviceParams.lutAccounts
  const lutAccounts = await hostLutAccounts(message, deviceParams, altFetcher, getFirmwareVersion?.(), logPrefix)
  if (lutAccounts) deviceParams.lutAccounts = lutAccounts
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
    ...(promoted ? { clearSignPromotionBundleHash: promoted.bundleHash } : {}),
  }
}

/**
 * The host-resolved lookup accounts for firmware 7.17.0+, or undefined to
 * send the message as before. Never next to a LUT proof, schema or
 * certificate (the device refuses that mix). A resolution that fails, or
 * that the device would refuse, is dropped: the device then shows the
 * message as it did before 7.17.
 */
async function hostLutAccounts(
  message: ParsedSolanaMessage,
  deviceParams: any,
  altFetcher: AltAccountFetcher | undefined,
  firmwareVersion: string | undefined,
  logPrefix: string,
): Promise<Buffer[] | undefined> {
  if (!altFetcher || message.altEntries.length === 0) return undefined
  if (!supportsHostLutAccounts(firmwareVersion)) return undefined
  if (deviceParams.lutProof || deviceParams.schema || deviceParams.certificate) return undefined
  try {
    const { accounts } = await resolveCanonicalLutAccounts(message, altFetcher, SOL_MAX_HOST_LUT_ACCOUNTS)
    if (message.staticAccounts.length + accounts.length > SOL_MAX_HOST_LUT_ACCOUNTS) return undefined
    const statics = new Set(message.staticAccounts.map((k) => Buffer.from(k).toString('hex')))
    if (accounts.some((k) => statics.has(k.toString('hex')))) return undefined
    return accounts
  } catch (err: any) {
    console.warn(`[${logPrefix}] lookup accounts not sent to the device: ${err?.message || err}`)
    return undefined
  }
}
