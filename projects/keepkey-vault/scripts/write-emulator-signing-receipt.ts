import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { certifiedEmulatorSourceSha256, EMULATOR_RECEIPT_FILENAME, reviewedEmulatorReceiptSource } from '../src/shared/emulator-receipt'

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Must run before signing mutates the pristine certified source. Re-signing
 * may accept a receipt only after the caller authenticates its old outer seal. */
export function verifyEmulatorBeforeSigning(path: string, allowSealedReceipt = false): string {
  const filename = basename(path)
  const source = certifiedEmulatorSourceSha256(filename)
  if (!source) throw new Error('Unsupported certified emulator version or filename')
  const actual = digest(path)
  if (actual === source) return source
  if (!allowSealedReceipt) throw new Error('Emulator source does not match the certified artifact')
  let receipt: unknown
  try { receipt = JSON.parse(readFileSync(join(dirname(path), EMULATOR_RECEIPT_FILENAME), 'utf8')) } catch { /* fail closed below */ }
  if (reviewedEmulatorReceiptSource(receipt, filename, actual) !== source) {
    throw new Error('Emulator source does not match the certified artifact or its previously signed receipt')
  }
  return source
}

/** Call only after successful inner signing, with the pre-sign source identity.
 * The outer app signature then seals this fixed receipt and the signed library. */
export function writeEmulatorSigningReceipt(path: string, reviewedSourceSha256: string): string {
  const filename = basename(path)
  if (certifiedEmulatorSourceSha256(filename) !== reviewedSourceSha256) throw new Error('Unreviewed emulator source identity')
  const receipt = { schemaVersion: 1, version: '7.17.0', filename,
    certifiedSourceSha256: reviewedSourceSha256, signedSha256: digest(path) }
  const receiptPath = join(dirname(path), EMULATOR_RECEIPT_FILENAME)
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  return receiptPath
}

if (import.meta.main) {
  const [mode, path, source] = process.argv.slice(2)
  if (!path) throw new Error('Usage: write-emulator-signing-receipt.ts --verify <library> | --verify-sealed <library> | --record <library> <verified-source-sha256>')
  if (mode === '--verify' || mode === '--verify-sealed') console.log(verifyEmulatorBeforeSigning(path, mode === '--verify-sealed'))
  else if (mode === '--record' && source) writeEmulatorSigningReceipt(path, source)
  else throw new Error('Unsupported emulator signing receipt command')
}
