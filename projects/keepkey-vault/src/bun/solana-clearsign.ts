/**
 * End-to-end Solana clear-signing pipeline for the Vault approval dialog.
 *
 * Input: a raw Solana transaction as the caller sent it to
 *        /solana/sign-transaction (base64-encoded).
 *
 * Output: a {@link SolanaTxDecodedInfo} describing each instruction in
 *         human-readable form, with ALT accounts expanded where possible.
 *
 * The steps:
 *   1. Strip signatures — {@link parseSolanaTx} + {@link solanaMessageSlice}
 *   2. Structured message parse — {@link parseSolanaMessage}
 *   3. ALT resolution via the caller-supplied fetcher (real RPC in prod,
 *      injected stub in tests). Best-effort: a failure to resolve marks
 *      `altResolutionIncomplete` but does not block the preview.
 *   4. Account expansion using Solana's canonical resolution order
 *      (static → ALT-writable → ALT-readonly).
 *   5. Per-instruction decoding via the pioneer-discovery program
 *      registry.
 *
 * Nothing here talks to the device or the network directly — the caller
 * injects the ALT fetcher so this module stays pure for unit tests.
 */

import bs58 from 'bs58'
import { parseSolanaTx, solanaMessageSlice, parseSolanaMessage, type ParsedSolanaMessage } from './solana-tx'
import type { AltAccountFetcher } from './solana-alt'
import { resolveAlts } from './solana-alt'
import { buildExpandedAccounts, decodeInstruction } from './solana-instruction-decoder'
import type { SolanaTxDecodedInfo, SolanaTxDecodedInstruction } from '../shared/types'

// ponytail: Stake/Vote programs omitted — add if a dApp flow ever touches them.
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const ASSET_PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM]: 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'SPL Token 2022',
}

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
/** Lamports per signature. A network parameter, so the fee is "up to", not
 *  "exactly" — but it has been this value for the whole life of the chain. */
const LAMPORTS_PER_SIGNATURE = 5_000n
/** Compute units a transaction is scheduled for when it sets no limit. */
const DEFAULT_COMPUTE_UNIT_LIMIT = 1_400_000n

/**
 * The most the network can charge for this message: the base fee for its
 * signatures plus the priority fee its own ComputeBudget instructions ask for
 * (price is micro-lamports per compute unit, rounded up, as the runtime does).
 * Read from the bytes being signed — never from a caller-supplied estimate.
 */
function maxNetworkFeeLamports(message: ParsedSolanaMessage, expanded: string[]): bigint {
  let price = 0n
  let limit: bigint | undefined
  for (const ix of message.instructions) {
    if (expanded[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM) continue
    const data = Buffer.from(ix.data)
    if (data.length === 9 && data[0] === 3) price = data.readBigUInt64LE(1)
    else if (data.length === 5 && data[0] === 2) limit = BigInt(data.readUInt32LE(1))
  }
  const priority = (price * (limit ?? DEFAULT_COMPUTE_UNIT_LIMIT) + 999_999n) / 1_000_000n
  return BigInt(message.header.numRequiredSignatures) * LAMPORTS_PER_SIGNATURE + priority
}

export async function buildSolanaDecodedInfo(
  rawTxBase64: string,
  altFetcher: AltAccountFetcher,
): Promise<SolanaTxDecodedInfo> {
  const fullTx = Buffer.from(rawTxBase64, 'base64')
  const parsedTx = parseSolanaTx(fullTx)
  const messageBytes = solanaMessageSlice(fullTx, parsedTx)
  const parsedMsg = parseSolanaMessage(messageBytes)

  const altPubkeys = parsedMsg.altEntries.map((e) => bs58.encode(e.accountKey))
  let altContents = new Map<string, string[]>()
  let altResolutionIncomplete = false
  if (altPubkeys.length > 0) {
    try {
      altContents = await resolveAlts(altPubkeys, altFetcher)
      if (altContents.size !== altPubkeys.length) altResolutionIncomplete = true
    } catch {
      altResolutionIncomplete = true
    }
  }

  const staticAccountsBase58 = parsedMsg.staticAccounts.map((a) => bs58.encode(a))
  const altEntriesForExpand = parsedMsg.altEntries.map((e) => ({
    accountKey: bs58.encode(e.accountKey),
    writableIndices: e.writableIndices,
    readonlyIndices: e.readonlyIndices,
  }))
  const { expanded } = buildExpandedAccounts(staticAccountsBase58, altEntriesForExpand, altContents)

  const instructions: SolanaTxDecodedInstruction[] = parsedMsg.instructions.map((ix) => {
    const d = decodeInstruction({
      programIdIndex: ix.programIdIndex,
      accountIndices: ix.accountIndices,
      data: ix.data,
      expandedAccounts: expanded,
    })
    return {
      status: d.status,
      programId: d.programId,
      programName: d.programName,
      programCategory: d.programCategory,
      instructionName: d.instructionName,
      args: d.args.map((a) => ({ name: a.name, type: a.type, value: a.value })),
      accounts: d.accounts.map((a) => ({ label: a.label, pubkey: a.pubkey })),
      note: d.note,
    }
  })

  const hasUnknownProgram = instructions.some((i) => i.status === 'unknown-program')
  const unknownData = parsedMsg.instructions
    .filter((_, i) => instructions[i].status === 'unknown-program')
    .map((ix) => Buffer.from(ix.data))
  const fundedKeysGivenToUnknownProgram = instructions
    .filter((i) => i.programId === SYSTEM_PROGRAM && i.instructionName === 'transfer')
    .map((i) => i.accounts.find((a) => a.label === 'destination')?.pubkey)
    .filter((k): k is string => !!k && unknownData.some((d) => d.includes(Buffer.from(bs58.decode(k)))))
  const assetPrograms = Object.entries(ASSET_PROGRAMS)
    .filter(([id]) => expanded.includes(id))
    .map(([, name]) => name)

  return {
    version: parsedMsg.version,
    staticAccountCount: parsedMsg.staticAccounts.length,
    instructions,
    altPubkeys,
    altResolutionIncomplete: altResolutionIncomplete || undefined,
    hasUnknownProgram: hasUnknownProgram || undefined,
    assetPrograms,
    fundedKeysGivenToUnknownProgram,
    // Withheld when a lookup table did not resolve: an instruction whose
    // program id came from that table is unreadable here, so a priority fee
    // could be missed and "up to X" would be an understatement.
    maxNetworkFeeLamports: altResolutionIncomplete
      ? undefined
      : maxNetworkFeeLamports(parsedMsg, expanded).toString(),
  }
}
