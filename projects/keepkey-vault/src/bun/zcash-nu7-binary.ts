import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export const ZCASH_NU7_BUILDER_CAPABILITY = 'keepkey-zcash-cli:nu7-transparent:v1'
const UPDATE_BUILDER = 'This Vault build needs the updated Zcash Nu7 transaction builder. Update Vault before sending ZEC.'

/** Verify without executing: older sidecars ignore new flags and open a profile. */
export function requireZcashNu7Builder(path: string): string {
  try {
    const manifestPath = `${path}.nu7.json`
    const manifestStat = statSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.size > 8192 || !statSync(path).isFile()) throw new Error()
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.schemaVersion !== 1 || manifest.capability !== ZCASH_NU7_BUILDER_CAPABILITY
      || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error()
    const bytes = readFileSync(path)
    if (!bytes.includes(Buffer.from(ZCASH_NU7_BUILDER_CAPABILITY))
      || createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== manifest.sha256) throw new Error()
    return manifest.sha256
  } catch {
    throw new Error(UPDATE_BUILDER)
  }
}
