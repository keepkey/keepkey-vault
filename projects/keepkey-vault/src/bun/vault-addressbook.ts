import type { Database } from 'bun:sqlite'
import type { AddressBookEntry } from '../shared/types'
import type { VaultIdentity } from '../shared/vault-identity'

/** Vault identity takes precedence over an older plain-contact alias, including
 * drafts: an undeployed vault cannot slip into certification under that alias. */
export function certifiableAddressBookEntries(
  vaults: AddressBookEntry[],
  contacts: AddressBookEntry[]
): AddressBookEntry[] {
  const allVaultIds = new Set(vaults.map((e) => `${e.networkId}:${e.address.toLowerCase()}`))
  const eligible = vaults
    .filter((e) => e.vault?.type === 'safe' && e.vault.receiveEnabled)
    .map((e) => ({ ...e, label: e.vault!.certificationLabel }))
  return [
    ...eligible,
    ...contacts.filter((e) => !allVaultIds.has(`${e.networkId}:${e.address.toLowerCase()}`)),
  ]
}

/** Separate projection preserves the existing addressbook's own/external CHECK
 * constraint and does not rewrite contact/history rows during migration. */
export class VaultAddressBook {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS vault_addressbook (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, device_id TEXT NOT NULL,
      vault_type TEXT NOT NULL, network_id TEXT NOT NULL, address TEXT NOT NULL,
      metadata TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(wallet_id, network_id, address)
    )`)
  }
  sync(
    scope: { walletId: string; deviceId: string },
    type: VaultIdentity['type'],
    vaults: VaultIdentity[]
  ): boolean {
    if (vaults.some((v) => v.sessionOnly || v.type !== type))
      throw new Error('Hidden vaults cannot be persisted')
    let changed = false
    this.db.transaction(() => {
      const before = this.db
        .query('SELECT * FROM vault_addressbook WHERE wallet_id = ? AND vault_type = ?')
        .all(scope.walletId, type) as any[]
      const ids = new Set(vaults.map((v) => v.id))
      for (const row of before)
        if (!ids.has(JSON.parse(row.metadata).id)) {
          this.db.run('DELETE FROM vault_addressbook WHERE id = ?', [row.id])
          changed = true
        }
      for (const v of vaults) {
        const metadata = JSON.stringify(v)
        const address = v.type === 'safe' ? v.address.toLowerCase() : v.address
        const old = before.find((r) => r.network_id === v.networkId && r.address === address)
        if (old?.metadata === metadata) continue
        const latest = this.db
          .query(
            'SELECT MAX(updated_at) AS stamp FROM vault_addressbook WHERE network_id = ? AND address = ?'
          )
          .get(v.networkId, address) as { stamp: number | null }
        const now = Math.max(Date.now(), (latest?.stamp || 0) + 1)
        this.db.run(
          `INSERT INTO vault_addressbook (id,wallet_id,device_id,vault_type,network_id,address,metadata,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet_id,network_id,address) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at`,
          [
            old?.id || `vault:${crypto.randomUUID()}`,
            scope.walletId,
            scope.deviceId,
            type,
            v.networkId,
            address,
            metadata,
            old?.created_at || now,
            now,
          ]
        )
        changed = true
      }
    })()
    return changed
  }
  list(networkId?: string, walletId?: string): AddressBookEntry[] {
    const where: string[] = [],
      params: string[] = []
    if (networkId) {
      where.push('network_id = ?')
      params.push(networkId)
    }
    if (walletId) {
      where.push('wallet_id = ?')
      params.push(walletId)
    }
    const rows = this.db
      .query(
        `SELECT * FROM vault_addressbook${
          where.length ? ' WHERE ' + where.join(' AND ') : ''
        } ORDER BY updated_at DESC`
      )
      .all(...params) as any[]
    const seen = new Set<string>()
    return rows
      .filter((r) => {
        const key = `${r.network_id}:${r.address}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((r) => {
        const vault: VaultIdentity = JSON.parse(r.metadata)
        return {
          id: r.id,
          walletId: r.wallet_id,
          deviceId: r.device_id,
          kind: 'external',
          networkId: r.network_id,
          chainId: vault.chainId,
          address: vault.address,
          label: vault.name,
          vault,
          savedAt: r.created_at,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }
      })
  }
}
