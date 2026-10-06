import { createHash } from 'node:crypto'
import { utils } from 'ethers'

export type PioneerSignedSource = { kind: string; declared: number; source: unknown }
export type PioneerSignatureResult = { kind: string; declared: number; discovered: number; valid: number;
  sha256: string; invalid: string[] }

function blobs(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).filter(([key]) => key !== '_meta')
    .flatMap(([key, child]) => blobs(child, path ? `${path}/${key}` : key))
}

export function verifyPioneerSignatures(publicKey: string, sources: PioneerSignedSource[]) {
  if (!/^(02|03)[0-9a-f]{64}$/i.test(publicKey)) throw new Error('Invalid Pioneer manifest public key')
  const results: PioneerSignatureResult[] = sources.map(({ kind, declared, source }) => {
    const found = blobs(source); const invalid: string[] = []; let valid = 0
    for (const [identity, encoded] of found) {
      try {
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.length <= 65) throw new Error('short blob')
        const payload = bytes.subarray(0, -65); const compact = bytes.subarray(-65, -1)
        const recovery = bytes[bytes.length - 1]
        if (recovery !== 27 && recovery !== 28) throw new Error('invalid recovery byte')
        const digest = createHash('sha256').update(payload).digest()
        const recovered = utils.computePublicKey(utils.recoverPublicKey(digest, {
          r: `0x${compact.subarray(0, 32).toString('hex')}`,
          s: `0x${compact.subarray(32).toString('hex')}`, recoveryParam: recovery - 27,
        }), true).slice(2).toLowerCase()
        if (recovered !== publicKey.toLowerCase()) throw new Error('signer mismatch')
        valid++
      } catch (error: any) { invalid.push(`${identity}: ${error?.message || error}`) }
    }
    return { kind, declared, discovered: found.length, valid,
      sha256: createHash('sha256').update(JSON.stringify(source)).digest('hex'), invalid }
  })
  if (results.some(result => result.declared !== result.discovered
    || result.valid !== result.discovered || result.invalid.length)) throw new Error(JSON.stringify(results))
  return { publicKey: publicKey.toLowerCase(), total: results.reduce((sum, result) => sum + result.valid, 0), results }
}
