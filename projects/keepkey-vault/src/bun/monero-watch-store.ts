/** Encrypted, wallet-scoped Monero monitoring data. Never exposed through frontend RPC. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
const asBytes = (value: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
const concat = (...parts: Uint8Array[]) => { const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length}return out }
const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)
import type { Database } from 'bun:sqlite'
import { moneroAddressKind } from '../shared/monero-address'

export type MoneroImageProof = { keyImage: string; signature: string }
export interface MoneroWatchStore {
  loadWatch(scope: string, address: string): Promise<Uint8Array | null>
  saveWatch(scope: string, address: string, viewKey: Uint8Array): Promise<void>
  loadAddress(scope: string, primary: string, minor: number): Promise<string | null>
  saveAddress(scope: string, primary: string, minor: number, address: string): Promise<void>
  loadImages(scope: string, primary: string, outputs: string): Promise<MoneroImageProof[] | null>
  saveImages(scope: string, primary: string, outputs: string, proofs: MoneroImageProof[]): Promise<void>
}

export function createMoneroWatchStore({ database, profile, key = async (create: boolean) => {
  const account = { service: 'com.keepkey.vault.monero', name: createHash('sha256').update(profile).digest('hex') }
  let value = await Bun.secrets.get(account)
  if (value === null && create) {
    value = randomBytes(32).toString('hex')
    await Bun.secrets.set({ ...account, value })
  }
  if (value === null) return null
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Monero secure storage is unavailable')
  return Uint8Array.from(value.match(/../g)!,part=>parseInt(part,16))
} }: { database: () => Database | null; profile: string; key?: (create: boolean) => Promise<Uint8Array | null> }): MoneroWatchStore {
  // Serialize writes so first-use OS key creation cannot race within this store.
  let writing: Promise<unknown> = Promise.resolve()
  function db() {
    const value = database()
    if (!value) throw new Error('Monero monitoring database is unavailable')
    value.exec('CREATE TABLE IF NOT EXISTS monero_watch_cache (scope TEXT NOT NULL, address TEXT NOT NULL, kind TEXT NOT NULL, ciphertext BLOB NOT NULL, PRIMARY KEY(scope,address,kind))')
    return value
  }
  const aad = (scope: string, address: string, kind: string) => encode(JSON.stringify(['monero-watch-v1', profile, scope, address, kind]))
  async function load(scope: string, address: string, kind: string): Promise<Uint8Array | null> {
    const row = db().query('SELECT ciphertext FROM monero_watch_cache WHERE scope=? AND address=? AND kind=?').get(scope,address,kind) as {ciphertext:Uint8Array} | null
    if (!row) return null
    let master: Uint8Array | null = null
    try {
      master = await key(false)
      if (!master || row.ciphertext.length < 29) throw new Error('Unavailable')
      const blob = row.ciphertext
      const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(0,12))
      decipher.setAAD(aad(scope,address,kind)); decipher.setAuthTag(blob.subarray(12,28))
      return concat(asBytes(decipher.update(blob.subarray(28))),asBytes(decipher.final()))
    } catch { throw new Error('Monero saved access could not be opened') }
    finally { master?.fill(0) }
  }
  function save(scope: string, address: string, kind: string, plain: Uint8Array) {
    const owned = plain.slice()
    const result = writing.then(async () => {
      let master: Uint8Array | null = null
      try {
        master = await key(true)
        if (!master) throw new Error('Unavailable')
        const iv = asBytes(randomBytes(12)), cipher = createCipheriv('aes-256-gcm', master, iv)
        cipher.setAAD(aad(scope,address,kind))
        const encrypted = concat(asBytes(cipher.update(owned)),asBytes(cipher.final()))
        db().query('INSERT OR REPLACE INTO monero_watch_cache(scope,address,kind,ciphertext) VALUES(?,?,?,?)').run(scope,address,kind,concat(iv,asBytes(cipher.getAuthTag()),encrypted))
      } catch { throw new Error('Monero access could not be saved securely') }
      finally { owned.fill(0); master?.fill(0) }
    })
    writing = result.catch(() => {})
    return result
  }
  const proofsValid = (value: unknown): value is MoneroImageProof[] => Array.isArray(value) && value.length <= 4096 && value.every(p => p && /^[0-9a-f]{64}$/.test(p.keyImage) && /^[0-9a-f]{128}$/.test(p.signature))
  return {
    async loadWatch(scope,address) {
      const value = await load(scope,address,'view-key')
      if (!value) return null
      if (value.length !== 32 || !value.some(n=>n!==0)) { value.fill(0); throw new Error('Invalid saved Monero access') }
      return value
    },
    async saveWatch(scope,address,viewKey) {
      if (viewKey.length !== 32 || !viewKey.some(n=>n!==0) || moneroAddressKind(address) !== 'standard') throw new Error('Invalid Monero monitoring access')
      await save(scope,address,'view-key',viewKey)
    },
    async loadAddress(scope,primary,minor) {
      const value=await load(scope,primary,`address:${minor}`)
      if (!value) return null
      try { const address=decode(value); return moneroAddressKind(address) === (minor ? 'subaddress' : 'standard') ? address : null }
      finally { value.fill(0) }
    },
    async saveAddress(scope,primary,minor,address) {
      if (!Number.isSafeInteger(minor) || minor<0 || minor>199 || moneroAddressKind(address)!==(minor?'subaddress':'standard')) throw new Error('Invalid Monero receive address')
      await save(scope,primary,`address:${minor}`,encode(address))
    },
    async loadImages(scope,primary,outputs) {
      const value=await load(scope,primary,'key-images')
      if (!value) return null
      try { const record=JSON.parse(decode(value)); return record.outputs===outputs && proofsValid(record.proofs) ? record.proofs : null }
      finally { value.fill(0) }
    },
    async saveImages(scope,primary,outputs,proofs) {
      if (!proofsValid(proofs)) throw new Error('Invalid Monero image proofs')
      await save(scope,primary,'key-images',encode(JSON.stringify({outputs,proofs})))
    },
  }
}
