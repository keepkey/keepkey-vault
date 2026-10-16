/**
 * ClearSign providers the user added: third-party services that describe a
 * transaction with their own key. The device trusts that key only for the
 * current session, after the user approves "NOT verified by KeepKey", and
 * only with AdvancedMode on. Nothing here is KeepKey-certified.
 *
 * Typed data (EIP-712) has no provider protocol yet; on 7.16 its only
 * firmware route is a runtime-delegate-signed ERC-7730 catalog, which belongs
 * to the ERC-7730 transport work. Only transactions are routed here.
 */
import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import type { ClearSignProvider, ClearSignProviderContract, ClearSignProviderInput } from '../shared/types'
import { resolveRuntimeEvmMetadata, supportsRuntimeEvmMetadata, type RuntimeEvmSigner } from './evm-runtime-metadata'

const ENV_SEED_KEY = 'clearsign_provider_env_seed'

/** First 8 bytes of sha256(pubkey) as 16 uppercase hex: what the device shows. */
export function providerFingerprint(publicKeyHex: string): string {
  return createHash('sha256').update(Uint8Array.from(Buffer.from(publicKeyHex, 'hex'))).digest('hex').slice(0, 16).toUpperCase()
}

function normalizeUrl(raw: string): string {
  let url: URL
  try { url = new URL(String(raw || '').trim()) } catch { throw new Error('Provider URL is not a valid URL') }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Provider URL must use https (http only for localhost)')
  }
  return url.toString().replace(/\/+$/, '')
}

function normalizeContracts(contracts: ClearSignProviderContract[] | undefined): ClearSignProviderContract[] {
  const out = new Map<string, ClearSignProviderContract>()
  for (const c of contracts || []) {
    const chainId = Number(c?.chainId)
    const address = String(c?.address || '').trim().toLowerCase()
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Contract chain ID must be a positive integer')
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Contract address ${address || '(empty)'} is not a 20-byte hex address`)
    out.set(`${chainId}:${address}`, { chainId, address })
  }
  return [...out.values()]
}

export function validateProviderInput(input: ClearSignProviderInput): Omit<ClearSignProvider, 'id' | 'createdAt'> {
  const name = String(input?.name || '').trim()
  if (!name || name.length > 31 || !/^[A-Za-z0-9 _-]+$/.test(name)) {
    throw new Error('Name must be 1-31 letters, digits, spaces, hyphens, or underscores')
  }
  const publicKeyHex = String(input?.publicKeyHex || '').trim().replace(/^0x/i, '').toLowerCase()
  if (!/^0[23][0-9a-f]{64}$/.test(publicKeyHex)) throw new Error('Public key must be a 33-byte compressed secp256k1 key')
  return {
    name, url: normalizeUrl(input?.url), publicKeyHex,
    fingerprint: providerFingerprint(publicKeyHex),
    contracts: normalizeContracts(input?.contracts),
  }
}

// ── Storage ────────────────────────────────────────────────────────────

export function ensureClearSignProviderTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clearsign_providers (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      url            TEXT UNIQUE,
      public_key_hex TEXT NOT NULL,
      fingerprint    TEXT NOT NULL,
      contracts_json TEXT NOT NULL DEFAULT '[]',
      created_at     INTEGER NOT NULL
    )
  `)
}

export function listClearSignProviders(db: Database): ClearSignProvider[] {
  const rows = db.query(
    'SELECT id, name, url, public_key_hex, fingerprint, contracts_json, created_at FROM clearsign_providers ORDER BY created_at ASC, id ASC',
  ).all() as Array<{ id: string; name: string; url: string | null; public_key_hex: string; fingerprint: string; contracts_json: string; created_at: number }>
  return rows.map(r => ({
    id: r.id, name: r.name, url: r.url ?? '', publicKeyHex: r.public_key_hex, fingerprint: r.fingerprint,
    contracts: JSON.parse(r.contracts_json || '[]'), createdAt: r.created_at,
  }))
}

export function addClearSignProvider(db: Database, input: ClearSignProviderInput): ClearSignProvider {
  const valid = validateProviderInput(input)
  if (listClearSignProviders(db).some(p => p.url === valid.url)) throw new Error('A provider with this URL is already added')
  const provider: ClearSignProvider = { id: randomUUID(), ...valid, createdAt: Date.now() }
  db.run(
    'INSERT INTO clearsign_providers (id, name, url, public_key_hex, fingerprint, contracts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [provider.id, provider.name, provider.url, provider.publicKeyHex, provider.fingerprint, JSON.stringify(provider.contracts), provider.createdAt],
  )
  return provider
}

export function removeClearSignProvider(db: Database, id: string): void {
  db.run('DELETE FROM clearsign_providers WHERE id = ?', [String(id || '')])
}

/** Migration seed: CLEARSIGN_RUNTIME_URL used to name the one provider. If it
 * is set, add it to the list once (keyed by URL, so removing it sticks). */
export async function seedClearSignProviderFromEnv(db: Database, rawUrl = process.env.CLEARSIGN_RUNTIME_URL): Promise<ClearSignProvider | undefined> {
  const configured = String(rawUrl || '').trim()
  if (!configured) return undefined
  const url = normalizeUrl(configured)
  const seeded = db.query('SELECT value FROM meta WHERE key = ?').get(ENV_SEED_KEY) as { value: string } | null
  if (seeded?.value === url) return undefined
  const existing = listClearSignProviders(db).find(p => p.url === url)
  let provider = existing
  if (!existing) {
    const response = await fetch(`${url}/signer`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`provider /signer answered ${response.status}`)
    const signer: any = await response.json()
    const name = String(signer?.alias || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 31) || 'ClearSign Provider'
    provider = addClearSignProvider(db, { name, url, publicKeyHex: String(signer?.publicKeyHex || '') })
  }
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [ENV_SEED_KEY, url])
  return existing ? undefined : provider
}

// ── Routing ────────────────────────────────────────────────────────────

let providerSource: () => ClearSignProvider[] = () => []

/** The DB layer registers this once, so routing never boots ElectroBun. */
export function configureClearSignProviders(source: () => ClearSignProvider[]): void {
  providerSource = source
}

/** The one provider to ask about (chainId, to): the first whose contract
 * scope names it, else the first unscoped one. Only that provider is
 * contacted, so a transaction is never sent to every provider. */
export function providerFor(providers: ClearSignProvider[], chainId: number, to: string | undefined): ClearSignProvider | undefined {
  const target = String(to || '').toLowerCase()
  const usable = providers.filter(p => !!p.url)
  return usable.find(p => p.contracts.some(c => c.chainId === chainId && c.address === target))
    ?? usable.find(p => p.contracts.length === 0)
}

export interface ProviderTxMetadata {
  txMetadata: { signedPayload: string; keyId: number }
  signer: RuntimeEvmSigner
  provider: ClearSignProvider
}

/** The single runtime-provider step shared by REST, RPC, swaps and
 * WalletConnect. Call it with the FINAL transaction (nonce, gas and fees
 * set), since the provider's description is bound to it. It runs only when
 * nothing else described the call (no txMetadata or erc7730 yet) and only
 * with AdvancedMode on 7.15+. A decline or outage must mean no description,
 * never a failed signature (resolveRuntimeEvmMetadata's contract: undefined
 * on decline/outage, a throw only for a bad identity). The caller loads `signer` onto
 * the device, which asks the user to trust it for this session. */
export async function resolveProviderTxMetadata(
  tx: any,
  gate: { firmwareVersion?: string; advancedMode: boolean },
  providers: ClearSignProvider[] = providerSource(),
): Promise<ProviderTxMetadata | undefined> {
  if (!tx || tx.txMetadata || tx.erc7730) return undefined
  if (!supportsRuntimeEvmMetadata(gate.firmwareVersion, gate.advancedMode)) return undefined
  const provider = providerFor(providers, Number(tx.chainId), tx.to)
  if (!provider) return undefined
  const runtime = await resolveRuntimeEvmMetadata(tx, provider.url)
  if (!runtime) return undefined
  if (runtime.signer.publicKeyHex !== provider.publicKeyHex) {
    throw new Error(`ClearSign provider "${provider.name}" answered with a key (${providerFingerprint(runtime.signer.publicKeyHex)}) that is not the one you added (${provider.fingerprint})`)
  }
  return {
    txMetadata: { signedPayload: runtime.signedPayload, keyId: runtime.keyId },
    // The device trust screen shows the name the user gave this provider.
    signer: { ...runtime.signer, alias: provider.name },
    provider,
  }
}
