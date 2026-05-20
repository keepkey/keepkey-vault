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
import { parseSolanaTx, solanaMessageSlice, parseSolanaMessage } from './solana-tx'
import type { AltAccountFetcher } from './solana-alt'
import { resolveAlts } from './solana-alt'
import { buildExpandedAccounts, decodeInstruction } from './solana-instruction-decoder'
import type { SolanaTxDecodedInfo, SolanaTxDecodedInstruction } from '../shared/types'

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

  return {
    version: parsedMsg.version,
    instructions,
    altPubkeys,
    altResolutionIncomplete: altResolutionIncomplete || undefined,
    hasUnknownProgram: hasUnknownProgram || undefined,
  }
}
