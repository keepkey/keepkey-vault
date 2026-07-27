/**
 * Signed KKSOLSC1 Solana instruction schemas, looked up per transaction.
 *
 * A schema describes how to READ one program instruction — program id,
 * discriminator, and the labelled args/accounts to display. It names no
 * amounts and no transaction hash, so one signature covers every future call
 * to that instruction and the device decodes the values out of the bytes it is
 * about to sign.
 *
 * Attaching one weakens nothing: firmware still verifies the signature against
 * a trusted ClearSign key, still requires the declared arg widths to account
 * for the instruction data exactly, still refuses lookup-table-backed
 * instructions, and still demands every other instruction be one it already
 * decodes. A wrong or unsigned schema is refused, not trusted.
 */
import bs58 from 'bs58'
import registry from './solana-schemas-local.json'
import { parseSolanaTx, solanaMessageSlice, parseSolanaMessage } from './solana-tx'

export interface SignedSolanaSchema {
  program: string
  instruction: string
  /** base64 KKSOLSC1 payload */
  payload: string
  /** base64, 64-byte compact secp256k1 over SHA256(payload) */
  signature: string
  signerKeyId: number
  /** discriminator + declared arg widths; firmware requires an exact match. */
  expectedDataLength: number
}

const SCHEMAS: Record<string, SignedSolanaSchema> = (registry as any).schemas ?? {}

/**
 * Find a schema describing an instruction in `rawTxBase64`, or undefined.
 *
 * Returns undefined on any doubt so a missing schema means today's behaviour,
 * never a blocked transaction. Deliberately declines when the message still
 * carries address-lookup tables: firmware will not apply a schema to an
 * instruction whose accounts are absent from the signed bytes, so attaching
 * one would only produce an on-device rejection. The host must inline those
 * accounts first.
 */
export function findSolanaSchema(rawTxBase64: string | undefined): SignedSolanaSchema | undefined {
  if (!rawTxBase64) return undefined
  try {
    const fullTx = Buffer.from(rawTxBase64, 'base64')
    const parsed = parseSolanaTx(fullTx)
    const message = parseSolanaMessage(solanaMessageSlice(fullTx, parsed))
    if (message.altEntries.length > 0) return undefined

    for (const ix of message.instructions) {
      const programId = message.staticAccounts[ix.programIdIndex]
      if (!programId || !ix.data || ix.data.length < 1) continue
      for (let discLen = 8; discLen >= 1; discLen--) {
        if (ix.data.length < discLen) continue
        const key = `${bs58.encode(programId)}:${Buffer.from(ix.data.subarray(0, discLen)).toString('hex')}`
        const schema = SCHEMAS[key.toLowerCase()]
        if (schema && schema.expectedDataLength === ix.data.length) return schema
      }
    }
  } catch {
    // A tx we cannot parse is one we cannot describe — stay quiet.
  }
  return undefined
}
