import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { EMULATOR_RECEIPT_FILENAME, reviewedEmulatorReceiptSource } from '../shared/emulator-receipt'

/** Accept only the library and receipt sealed at the fixed app bundle location.
 * User-imported firmware and sibling metadata never acquire release trust. */
export function reviewedBundledEmulatorSourceSha256(loadedPath: string | null, loadedSha256: string | null): string | null {
  if (!loadedPath || !loadedSha256) return null
  const filename = process.platform === 'darwin' ? 'libkkemu.dylib'
    : process.platform === 'win32' ? 'libkkemu.dll' : null
  if (!filename) return null
  try {
    const codeDirectory = realpathSync(import.meta.dir)
    const bundleDirectory = resolve(codeDirectory, '../emulator')
    if (realpathSync(bundleDirectory) !== bundleDirectory) return null
    const bundledPath = join(bundleDirectory, filename)
    if (!lstatSync(bundledPath).isFile() || realpathSync(loadedPath) !== realpathSync(bundledPath)
      || dirname(realpathSync(bundledPath)) !== bundleDirectory) return null
    const receiptPath = join(bundleDirectory, EMULATOR_RECEIPT_FILENAME)
    const receiptStat = lstatSync(receiptPath)
    if (!receiptStat.isFile() || receiptStat.size > 8192) return null
    const actualSha256 = createHash('sha256').update(new Uint8Array(readFileSync(bundledPath))).digest('hex')
    if (actualSha256 !== loadedSha256) return null
    return reviewedEmulatorReceiptSource(JSON.parse(readFileSync(receiptPath, 'utf8')), filename, actualSha256)
  } catch { return null }
}
