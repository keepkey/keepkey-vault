import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { requireZcashNu7Builder, ZCASH_NU7_BUILDER_CAPABILITY } from '../src/bun/zcash-nu7-binary'

export function writeZcashNu7Manifest(argument: string): void {
  const path = resolve(argument)
  const bytes = readFileSync(path)
  if (!bytes.includes(Buffer.from(ZCASH_NU7_BUILDER_CAPABILITY))) {
    throw new Error('The built sidecar does not contain the Nu7 transparent protocol capability')
  }
  writeFileSync(`${path}.nu7.json`, JSON.stringify({
    schemaVersion: 1,
    capability: ZCASH_NU7_BUILDER_CAPABILITY,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }, null, 2) + '\n')
}

if (import.meta.main) {
  const verify = process.argv[2] === '--verify'
  const argument = process.argv[verify ? 3 : 2]
  if (!argument) throw new Error('Usage: bun scripts/write-zcash-nu7-manifest.ts <built-zcash-cli>')
  if (verify) requireZcashNu7Builder(resolve(argument))
  else writeZcashNu7Manifest(argument)
  console.log(`Zcash Nu7 builder manifest ${verify ? 'verified' : 'written'}`)
}
