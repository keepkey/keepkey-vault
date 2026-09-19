/** Edit a Solana wire transaction's message and re-serialize it (tests only). */
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice, type ParsedSolanaMessage } from '../../src/bun/solana-tx'

export interface EditableSolanaMessage {
  version: 'legacy' | 'v0'
  header: [number, number, number]
  staticAccounts: Buffer[]
  recentBlockhash: Buffer
  instructions: Array<{ programIdIndex: number; accountIndices: number[]; data: Buffer }>
  altEntries: Array<{ accountKey: Buffer; writableIndices: number[]; readonlyIndices: number[] }>
}

function compactU16(value: number): Buffer {
  const out: number[] = []
  do {
    let byte = value & 0x7f
    value >>= 7
    if (value) byte |= 0x80
    out.push(byte)
  } while (value)
  return Buffer.from(out)
}

const withLength = (bytes: Buffer | number[]) => Buffer.concat([compactU16(bytes.length), Buffer.from(bytes)])

export function parseSolanaWireMessage(rawTxBase64: string): ParsedSolanaMessage {
  const full = Buffer.from(rawTxBase64, 'base64')
  return parseSolanaMessage(solanaMessageSlice(full, parseSolanaTx(full)))
}

/** Unsigned (zero signature slots) wire transaction of the edited message. */
export function editSolanaTx(rawTxBase64: string, edit: (message: EditableSolanaMessage) => void = () => {}): string {
  const parsed = parseSolanaWireMessage(rawTxBase64)
  const m: EditableSolanaMessage = {
    version: parsed.version,
    header: [parsed.header.numRequiredSignatures, parsed.header.numReadonlySignedAccounts, parsed.header.numReadonlyUnsignedAccounts],
    staticAccounts: parsed.staticAccounts.map((key) => Buffer.from(key)),
    recentBlockhash: Buffer.from(parsed.recentBlockhash),
    instructions: parsed.instructions.map((ix) => ({
      programIdIndex: ix.programIdIndex, accountIndices: [...ix.accountIndices], data: Buffer.from(ix.data),
    })),
    altEntries: parsed.altEntries.map((entry) => ({
      accountKey: Buffer.from(entry.accountKey), writableIndices: [...entry.writableIndices], readonlyIndices: [...entry.readonlyIndices],
    })),
  }
  edit(m)
  const message = Buffer.concat([
    ...(m.version === 'v0' ? [Buffer.from([0x80])] : []),
    Buffer.from(m.header),
    compactU16(m.staticAccounts.length), ...m.staticAccounts,
    m.recentBlockhash,
    compactU16(m.instructions.length),
    ...m.instructions.map((ix) => Buffer.concat([Buffer.from([ix.programIdIndex]), withLength(ix.accountIndices), withLength(ix.data)])),
    ...(m.version === 'v0'
      ? [compactU16(m.altEntries.length), ...m.altEntries.map((entry) => Buffer.concat([
          entry.accountKey, withLength(entry.writableIndices), withLength(entry.readonlyIndices),
        ]))]
      : []),
  ])
  return Buffer.concat([compactU16(m.header[0]), Buffer.alloc(64 * m.header[0]), message]).toString('base64')
}
