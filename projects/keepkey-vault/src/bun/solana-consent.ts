import type { SolanaTxDecodedInfo, SolanaTxDecodedInstruction } from '../shared/types'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const MEMO_V2_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

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
