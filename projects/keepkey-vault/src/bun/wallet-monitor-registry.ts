export interface WalletMonitorOwner {
  deviceId: string
  walletScope: string
  base: string
  queryKey: string
}
const VERSION = 1
const MAX_OWNERS = 512

function normalized(owner: WalletMonitorOwner): WalletMonitorOwner {
  if (!owner || typeof owner !== 'object') throw new Error('Invalid background monitoring ownership')
  const { deviceId, walletScope, queryKey } = owner
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 256 || /[\x00-\x1f\x7f]/.test(deviceId)
    || typeof walletScope !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(walletScope)
    || typeof queryKey !== 'string' || !queryKey || queryKey.length > 1024 || queryKey !== queryKey.trim() || /[\x00-\x1f\x7f]/.test(queryKey)) {
    throw new Error('Invalid background monitoring ownership')
  }
  let url: URL
  try { url = new URL(owner.base) } catch { throw new Error('Invalid background monitoring provider') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid background monitoring provider')
  }
  // Project only these fields. Wallet objects, public keys and address lists
  // from a caller's larger session object must never enter settings.
  return { deviceId, walletScope, base: url.toString().replace(/\/+$/, ''), queryKey }
}
function key(owner: WalletMonitorOwner): string {
  return JSON.stringify([owner.deviceId, owner.base, owner.queryKey, owner.walletScope])
}

/** Standard-wallet revocation inventory. Remember before the first remote
 * registration POST. Normal disconnect/quit must not remove a descriptor.
 * Explicit Forget/Delete/Offline removes it only after remote disable succeeds. */
export function createWalletMonitorRegistry(settings: { read: () => string | undefined; write: (json: string) => void }) {
  function load(): WalletMonitorOwner[] {
    const raw = settings.read()
    if (!raw) return []
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { throw new Error('Saved background monitoring ownership could not be read') }
    if (parsed?.version !== VERSION || !Array.isArray(parsed.owners) || parsed.owners.length > MAX_OWNERS) {
      throw new Error('Saved background monitoring ownership could not be read')
    }
    try { return [...new Map(parsed.owners.map((item: WalletMonitorOwner) => { const owner = normalized(item); return [key(owner), owner] as const })).values()] as WalletMonitorOwner[] }
    catch { throw new Error('Saved background monitoring ownership could not be read') }
  }
  function save(owners: WalletMonitorOwner[]): void {
    if (owners.length > MAX_OWNERS) throw new Error('Too many saved background monitoring registrations')
    const json = JSON.stringify({ version: VERSION, owners })
    settings.write(json)
    if (settings.read() !== json) throw new Error('Background monitoring ownership could not be saved')
  }
  function remove(descriptor: WalletMonitorOwner): void {
    const wanted = key(normalized(descriptor)), owners = load()
    const remaining = owners.filter(owner => key(owner) !== wanted)
    if (remaining.length !== owners.length) save(remaining)
  }
  return {
    remember(descriptor: WalletMonitorOwner, hidden = false): void {
      if (hidden) return
      const owner = normalized(descriptor), owners = load()
      if (!owners.some(existing => key(existing) === key(owner))) save([...owners, owner])
    },
    list(deviceId?: string): WalletMonitorOwner[] {
      return load().filter(owner => deviceId === undefined || owner.deviceId === deviceId).map(owner => ({ ...owner }))
    },
    /** Call only after an acknowledged remote disable; prefer revoke below. */
    remove,
    async revoke(descriptor: WalletMonitorOwner, disable: (owner: WalletMonitorOwner) => Promise<void>): Promise<void> {
      const owner = normalized(descriptor)
      await disable({ ...owner })
      remove(owner)
    },
  }
}
