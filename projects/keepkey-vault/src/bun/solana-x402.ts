import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import type { ParsedSolanaMessage } from './solana-tx'

export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

const TOKEN_PROGRAM = bs58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const MEMO_PROGRAM = bs58.decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const ATA_PROGRAM = bs58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'ascii')
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const U64_MAX = (1n << 64n) - 1n

const ED25519_P = (1n << 255n) - 19n

function mod(value: bigint): bigint {
  const result = value % ED25519_P
  return result >= 0n ? result : result + ED25519_P
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let factor = mod(base)
  let power = exponent
  while (power > 0n) {
    if ((power & 1n) !== 0n) result = mod(result * factor)
    factor = mod(factor * factor)
    power >>= 1n
  }
  return result
}

const ED25519_D = mod(-121665n * modPow(121666n, ED25519_P - 2n))
const ED25519_SQRT_M1 = modPow(2n, (ED25519_P - 1n) / 4n)

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  return value
}

/** True when the 32-byte compressed value is a canonical Ed25519 point. */
export function isEd25519Point(compressed: Uint8Array): boolean {
  if (compressed.length !== 32) return false
  const copy = Uint8Array.from(compressed)
  const sign = copy[31] >>> 7
  copy[31] &= 0x7f
  const y = littleEndianToBigInt(copy)
  if (y >= ED25519_P) return false

  const y2 = mod(y * y)
  const denominator = mod(ED25519_D * y2 + 1n)
  if (denominator === 0n) return false
  const x2 = mod((y2 - 1n) * modPow(denominator, ED25519_P - 2n))
  let x = modPow(x2, (ED25519_P + 3n) / 8n)
  if (mod(x * x) !== x2) x = mod(x * ED25519_SQRT_M1)
  if (mod(x * x) !== x2) return false
  return !(x === 0n && sign === 1)
}

export function deriveAssociatedTokenAddress(
  owner: Uint8Array,
  mint: Uint8Array,
  tokenProgram: Uint8Array = TOKEN_PROGRAM,
): Uint8Array {
  if (owner.length !== 32 || mint.length !== 32 || tokenProgram.length !== 32) {
    throw new Error('x402 ATA derivation requires 32-byte owner, mint, and token program')
  }
  for (let bump = 255; bump >= 0; bump--) {
    const digest = createHash('sha256')
      .update(owner)
      .update(tokenProgram)
      .update(mint)
      .update(Uint8Array.of(bump))
      .update(ATA_PROGRAM)
      .update(PDA_MARKER)
      .digest()
    if (!isEd25519Point(digest)) return Uint8Array.from(digest)
  }
  throw new Error('Unable to derive x402 recipient associated token account')
}

export interface SolanaX402Requirements {
  scheme: 'exact'
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: {
    feePayer: string
    memo?: string
    recentBlockhash?: string
    lastValidBlockHeight?: string
  }
}

export interface SolanaX402DeviceMetadata {
  tokenInfo: Array<{ mint: Uint8Array; symbol?: string; decimals: number }>
  tokenRecipientOwners: Uint8Array[]
}

function decodePubkey(value: string, field: string): Uint8Array {
  let decoded: Uint8Array
  try {
    decoded = bs58.decode(value)
  } catch {
    throw new Error(`x402 ${field} is not a valid base58 Solana public key`)
  }
  if (decoded.length !== 32) {
    throw new Error(`x402 ${field} must decode to 32 bytes, got ${decoded.length}`)
  }
  return decoded
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b))
}

/**
 * Validate an x402 PaymentRequirements object against the exact signed Solana
 * v0 message. No chain reads are used: zero-LUT static accounts contain the
 * sponsor, mint, destination ATA, authority, programs, amount, and decimals.
 */
export function prepareSolanaX402DeviceMetadata(
  message: ParsedSolanaMessage,
  requirements: SolanaX402Requirements,
  signerPublicKey: Uint8Array,
): SolanaX402DeviceMetadata {
  if (requirements.scheme !== 'exact') {
    throw new Error(`Unsupported x402 Solana scheme: ${requirements.scheme}`)
  }
  if (requirements.network !== SOLANA_MAINNET_CAIP2) {
    throw new Error(`Unsupported x402 Solana network: ${requirements.network}`)
  }
  if (message.version !== 'v0') throw new Error('x402 SVM exact payments require a v0 transaction')
  if (message.altEntries.length !== 0) {
    throw new Error('x402 hardware verification requires a zero-LUT v0 transaction')
  }

  const mint = decodePubkey(requirements.asset, 'asset')
  const payTo = decodePubkey(requirements.payTo, 'payTo')
  const feePayer = decodePubkey(requirements.extra.feePayer, 'extra.feePayer')
  if (!message.staticAccounts[0] || !equalBytes(message.staticAccounts[0], feePayer)) {
    throw new Error('x402 sponsor does not match the signed transaction fee payer')
  }

  if (!/^\d+$/.test(requirements.amount)) throw new Error('x402 amount must be an unsigned integer string')
  const requiredAmount = BigInt(requirements.amount)
  if (requiredAmount > U64_MAX) throw new Error('x402 amount exceeds the SPL u64 range')
  const expectedAta = deriveAssociatedTokenAddress(payTo, mint)

  const matches: Array<{ amount: bigint; decimals: number }> = []
  const underpayments: bigint[] = []
  for (const instruction of message.instructions) {
    const program = message.staticAccounts[instruction.programIdIndex]
    if (!program || !equalBytes(program, TOKEN_PROGRAM) || instruction.data[0] !== 12) continue
    if (instruction.data.length !== 10 || instruction.accountIndices.length !== 4) {
      throw new Error('x402 TransferChecked must use the canonical 10-byte, 4-account form')
    }
    const sourceMint = message.staticAccounts[instruction.accountIndices[1]]
    const destination = message.staticAccounts[instruction.accountIndices[2]]
    const authority = message.staticAccounts[instruction.accountIndices[3]]
    if (!sourceMint || !destination || !authority) {
      throw new Error('x402 TransferChecked references a non-static account')
    }
    if (!equalBytes(sourceMint, mint) || !equalBytes(destination, expectedAta)) continue
    if (!equalBytes(authority, signerPublicKey)) {
      throw new Error('x402 transfer authority is not the selected KeepKey signer')
    }
    const data = Buffer.from(instruction.data)
    const amount = data.readBigUInt64LE(1)
    if (amount >= requiredAmount) {
      matches.push({ amount, decimals: data[9] })
    } else {
      underpayments.push(amount)
    }
  }

  if (matches.length !== 1) {
    if (matches.length === 0 && underpayments.length > 0) {
      throw new Error(`x402 transfer amount ${underpayments[0]} is below required ${requiredAmount}`)
    }
    throw new Error(`x402 transaction must contain exactly one matching TransferChecked; found ${matches.length}`)
  }

  const knownUsdc = requirements.asset === USDC_MINT
  if (knownUsdc && matches[0].decimals !== 6) {
    throw new Error(`x402 USDC decimals mismatch: signed ${matches[0].decimals}, expected 6`)
  }

  const memoInstructions = message.instructions.filter((instruction) => {
    const program = message.staticAccounts[instruction.programIdIndex]
    return !!program && equalBytes(program, MEMO_PROGRAM)
  })
  if (memoInstructions.length !== 1) {
    throw new Error(`x402 transaction must contain exactly one Memo instruction; found ${memoInstructions.length}`)
  }
  const memoBytes = memoInstructions[0].data
  if (requirements.extra.memo !== undefined) {
    const requiredMemo = Buffer.from(requirements.extra.memo, 'utf8')
    if (requiredMemo.length > 256) throw new Error('x402 extra.memo exceeds 256 UTF-8 bytes')
    if (!equalBytes(memoBytes, requiredMemo)) {
      throw new Error('x402 memo does not match PaymentRequirements extra.memo')
    }
  } else {
    const randomMemo = Buffer.from(memoBytes).toString('utf8')
    if (!/^[0-9a-fA-F]{32,}$/.test(randomMemo) || randomMemo.length % 2 !== 0) {
      throw new Error('x402 transaction requires a hex-encoded random memo of at least 16 bytes')
    }
  }
  return {
    tokenInfo: [{
      mint,
      ...(knownUsdc ? { symbol: 'USDC' } : {}),
      decimals: matches[0].decimals,
    }],
    tokenRecipientOwners: [payTo],
  }
}
