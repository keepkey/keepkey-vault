import bs58 from 'bs58'
import { versionCompare } from '../shared/firmware-versions'
import type { SigningRequestInfo, SolanaTxDecodedInfo, SolanaTxDecodedInstruction } from '../shared/types'
import { supportsCertifiedClearSign } from './solana-certified-policy'
import {
  parseSolanaMessage,
  parseSolanaTx,
  solanaMessageSlice,
  type ParsedSolanaMessage,
  type SolanaInstruction,
} from './solana-tx'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const MEMO_V2_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111'
const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111'

/**
 * This is deliberately an allowlist, not "anything the host registry knows".
 * Firmware has stricter semantics than the preview registry: for example,
 * unchecked SPL transfers and System createAccount are decoded for display but
 * intentionally remain opaque on-device.
 */
function firmwareClearSigns(instruction: SolanaTxDecodedInstruction): boolean {
  // Memo v2 intentionally has no instruction discriminator in the discovery
  // registry, so it is classified as a known program with an unknown ix even
  // though firmware safely renders the entire payload as text.
  if (
    instruction.programId === MEMO_V2_PROGRAM
    && instruction.status === 'known-program-unknown-ix'
  ) {
    return true
  }
  if (instruction.status !== 'known' || instruction.note) return false

  switch (instruction.programId) {
    case SYSTEM_PROGRAM:
      return instruction.instructionName === 'transfer'
        || instruction.instructionName === 'allocate'
    case TOKEN_PROGRAM:
      if (instruction.instructionName === 'transferChecked') {
        return instruction.accounts.length >= 4
      }
      return instruction.instructionName === 'mintTo'
        || instruction.instructionName === 'burn'
        || instruction.instructionName === 'closeAccount'
    case TOKEN_2022_PROGRAM:
      // Firmware forces all Token-2022 transfer variants opaque because
      // extensions can add undisclosed hooks or fees.
      return instruction.instructionName === 'mintTo'
        || instruction.instructionName === 'burn'
        || instruction.instructionName === 'closeAccount'
    case ATA_PROGRAM:
      return instruction.instructionName === 'create'
    case COMPUTE_BUDGET_PROGRAM:
      return instruction.instructionName === 'setComputeUnitLimit'
        || instruction.instructionName === 'setComputeUnitPrice'
        || instruction.instructionName === 'setLoadedAccountsDataSizeLimit'
    default:
      return false
  }
}

/**
 * Decide whether an external REST Solana transaction needs explicit one-shot
 * opaque-signing consent. Provider-signed transaction metadata is verified (or
 * rejected without fallback) by firmware. Without it, mirror firmware's
 * clear-sign boundary conservatively so a richer host decoder cannot turn an
 * on-device opaque transaction into an implicitly approved request.
 */
export function requiresSolanaBlindSigningConsent(
  decoded: SolanaTxDecodedInfo | undefined,
  hasTransactionBoundMetadata: boolean,
): boolean {
  if (hasTransactionBoundMetadata) return false
  if (
    !decoded
    || decoded.staticAccountCount > 32
    || decoded.instructions.length === 0
    || decoded.instructions.length > 8
    || decoded.altPubkeys.length > 0
    || decoded.altResolutionIncomplete
  ) {
    return true
  }
  return decoded.instructions.some((instruction) => !firmwareClearSigns(instruction))
}

/** Proof material a REST caller attached to a Solana transaction. */
export interface SolanaDeviceMetadata {
  lutProof?: { signerKeyId?: number }
  schema?: { signerKeyId?: number }
  certificate?: string
}

/**
 * Will the device refuse this transaction unless AdvancedMode is on?
 *
 * The device is the enforcement: fsm_msgSolanaSignTx refuses an OPAQUE review
 * with "Enable AdvancedMode to blind-sign" whatever Vault shows. This gate is
 * UX, so the user enables AdvancedMode before approving rather than approving
 * and then being refused. It must never demand AdvancedMode for a transaction
 * the device clear-signs, because that pushes users to blind-sign ordinary
 * sends. So it answers true only when EVERY firmware build of the connected
 * version refuses (the builds in
 * __tests__/fixtures/solana/advanced-mode-firmware-verdicts.json), and false
 * wherever it cannot tell: an unknown version, a message Vault cannot parse,
 * or an encoding detail it does not mirror. A wrong false costs one refused
 * signature, which is what happened before this gate existed.
 */
export function solanaFirmwareRequiresAdvancedMode(
  rawTxBase64: string | undefined,
  firmwareVersion: string | undefined,
  metadata: SolanaDeviceMetadata = {},
): boolean {
  if (!rawTxBase64 || !firmwareVersion) return false
  const at = (version: string) => versionCompare(firmwareVersion, version) >= 0
  const certified = metadata.certificate !== undefined
    && (metadata.lutProof?.signerKeyId === 0x80 || metadata.schema?.signerKeyId === 0x80)
  // Firmware that verifies a certified proof either clear-signs with it or
  // refuses it outright; AdvancedMode changes neither. Older firmware does not
  // honor it, so its review stands.
  if (certified && supportsCertifiedClearSign(firmwareVersion)) return false

  let review: 'opaque' | 'malformed' | undefined
  try {
    const full = new Uint8Array(Buffer.from(rawTxBase64, 'base64'))
    review = predictFirmwareReview(parseSolanaMessage(solanaMessageSlice(full, parseSolanaTx(full))), at)
  } catch {
    return false
  }
  if (review === 'malformed') return false
  // From 7.16 a runtime-signer (slot 0-3) schema verifies only while
  // AdvancedMode is on (signed_metadata_verify_attestation: runtime signers are
  // all loaded ones), even on a transaction the device would clear-sign.
  // 7.14 has no schema field and the 7.15 release line only annotates an opaque
  // review with one, so before 7.16 the review decides. A runtime lutProof
  // never changes the review, which ignores it.
  if (metadata.schema !== undefined && !certified && at('7.16.0')) return true
  return review === 'opaque'
}

/**
 * The opcodes each program's firmware classifier decodes (lib/firmware/solana.c
 * parse_instruction_section, the same in every build since 7.14.1). Any other
 * opcode, or any program not listed, makes the whole review OPAQUE.
 * System, Stake and Vote opcodes are a u32 LE; the others one byte.
 */
const TOKEN_OPCODES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17]
const FIRMWARE_OPCODES: Record<string, number[]> = {
  [SYSTEM_PROGRAM]: [0, 1, 2, 4, 5, 6, 7, 8],
  [TOKEN_PROGRAM]: TOKEN_OPCODES,
  [TOKEN_2022_PROGRAM]: TOKEN_OPCODES,
  [STAKE_PROGRAM]: [1, 2, 3, 4, 5, 7],
  [VOTE_PROGRAM]: [1, 3, 4, 5],
  [COMPUTE_BUDGET_PROGRAM]: [1, 2, 3, 4],
}

/** The non-certified review every firmware build at a version agrees on, if any. */
function predictFirmwareReview(
  message: ParsedSolanaMessage,
  at: (version: string) => boolean,
): 'opaque' | 'malformed' | undefined {
  const count = message.staticAccounts.length
  const keys = message.staticAccounts.map((key) => bs58.encode(key))
  const external = message.instructions.some(
    (ix) => ix.programIdIndex >= count || ix.accountIndices.some((i) => i >= count),
  )
  // More than SOL_MAX_ACCOUNTS static keys: OPAQUE before 7.16, MALFORMED since.
  if (count > 32) return at('7.16.0') ? 'malformed' : 'opaque'
  if (message.version === 'legacy') {
    if (external) return 'malformed'
  } else if (!at('7.15.0')) {
    // 7.14 reviews no v0 message, and cannot parse one that reaches a lookup
    // table or has more than eight instructions.
    return external || message.instructions.length > 8 ? 'malformed' : 'opaque'
  } else if (external || message.altEntries.length > 0) {
    // Lookup-table accounts are chain state the device cannot resolve.
    return 'opaque'
  }
  if (message.instructions.length === 0 || message.instructions.length > 8) return 'opaque'
  return message.instructions.some((ix) => firmwareForcesOpaque(keys, ix, at)) ? 'opaque' : undefined
}

function firmwareForcesOpaque(
  keys: string[],
  ix: SolanaInstruction,
  at: (version: string) => boolean,
): boolean {
  const program = keys[ix.programIdIndex]
  const data = Buffer.from(ix.data)
  const only7142 = at('7.14.2') && !at('7.15.0')
  if (program === MEMO_V2_PROGRAM) return false
  if (program === ATA_PROGRAM) {
    // Create is empty data or [0]; CreateIdempotent ([1]) is reviewed from 7.15.
    const op = data.length === 0 ? 0 : data.length === 1 ? data[0] : -1
    if (op !== 0 && !(op === 1 && at('7.15.0'))) return true
    // 7.14.2 reviews only a Create naming the System and SPL Token programs.
    return only7142 && (
      ix.accountIndices.length < 6
      || keys[ix.accountIndices[4]] !== SYSTEM_PROGRAM
      || keys[ix.accountIndices[5]] !== TOKEN_PROGRAM
    )
  }
  const opcodes = FIRMWARE_OPCODES[program]
  if (!opcodes) return true
  const wide = program === SYSTEM_PROGRAM || program === STAKE_PROGRAM || program === VOTE_PROGRAM
  if (data.length < (wide ? 4 : 1)) return true
  const op = wide ? data.readUInt32LE(0) : data[0]
  if (!opcodes.includes(op)) return true
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return false
  // From 7.14.2 every build refuses to clear-sign unchecked Transfer and
  // Approve (no mint), SetAuthority, and Token-2022 TransferChecked (hooks).
  if (at('7.14.2') && ([3, 4, 6].includes(op) || (program === TOKEN_2022_PROGRAM && op === 12))) {
    return true
  }
  // 7.14.2 alone also refuses every Token-2022 instruction and MintTo/Burn.
  return only7142 && (program === TOKEN_2022_PROGRAM || [7, 8, 14, 15].includes(op))
}

/**
 * Set the approval gates for a Solana transaction, for REST and WalletConnect
 * alike: the conservative one-shot consent, and AdvancedMode exactly where the
 * connected firmware requires it.
 */
export function applySolanaSigningGates(
  info: SigningRequestInfo,
  rawTxBase64: string | undefined,
  firmwareVersion: string | undefined,
  metadata: SolanaDeviceMetadata = {},
): void {
  info.requiresBlindSigningConsent = requiresSolanaBlindSigningConsent(
    info.solanaDecoded,
    metadata.lutProof !== undefined || metadata.schema !== undefined,
  )
  info.requiresAdvancedMode = solanaFirmwareRequiresAdvancedMode(rawTxBase64, firmwareVersion, metadata)
  if (info.requiresBlindSigningConsent || info.requiresAdvancedMode) info.needsBlindSigning = true
}
