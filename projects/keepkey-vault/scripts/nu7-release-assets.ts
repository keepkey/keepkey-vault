import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMULATOR_RECEIPT_FILENAME, certifiedEmulatorSourceSha256, reviewedEmulatorReceiptSource } from '../src/shared/emulator-receipt'
import { requireZcashNu7Builder } from '../src/bun/zcash-nu7-binary'

/** Read-only checks. A receipt can describe signed emulator bytes only after the
 * caller has verified the outer macOS app seal that authenticates the JSON. */
export function nu7ReleaseAssetProblems(appDirectory: string, arch: string, outerSealVerified = false): string[] {
  const problems: string[] = []
  const emulator = join(appDirectory, 'emulator', 'libkkemu.dylib')
  try {
    const actual = createHash('sha256').update(readFileSync(emulator)).digest('hex')
    const source = certifiedEmulatorSourceSha256('libkkemu.dylib')
    if (actual !== source) {
      const receipt = JSON.parse(readFileSync(join(appDirectory, 'emulator', EMULATOR_RECEIPT_FILENAME), 'utf8'))
      if (!outerSealVerified || reviewedEmulatorReceiptSource(receipt, 'libkkemu.dylib', actual) !== source) {
        problems.push('emulator bytes are neither the certified source nor authenticated by the verified outer app seal')
      }
    }
  } catch { problems.push('certified emulator or its signed receipt is missing or unreadable') }
  const builder = join(appDirectory, 'zcash-cli')
  if (arch === 'arm64') {
    try { requireZcashNu7Builder(builder) } catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
  } else if (existsSync(builder) || existsSync(`${builder}.nu7.json`)) {
    problems.push('Intel release must not ship zcash-cli or its Nu7 manifest')
  }
  return problems
}
