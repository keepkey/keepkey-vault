import type { VaultIdentity } from "./vault-identity";

export interface VaultWalletKey {
  family: "evm" | "bitcoin" | "other";
  address: string;
  xpub: string;
}

/** A saved contract or device label does not establish wallet membership. */
export function vaultHasCosigner(vault: VaultIdentity, keys: VaultWalletKey[]): boolean {
  return vault.cosigners.some((c) => vault.type === 'safe'
    ? !!c.address && /^0x[0-9a-f]{40}$/i.test(c.address) && keys.some(k =>
      k.family === 'evm' && /^0x[0-9a-f]{40}$/i.test(k.address) && k.address.toLowerCase() === c.address!.toLowerCase())
    : !!c.xpub && keys.some(k => k.family === 'bitcoin' && k.xpub === c.xpub))
}

export function vaultsForWallet(vaults: VaultIdentity[], keys: VaultWalletKey[]): VaultIdentity[] {
  return vaults.filter(vault => vaultHasCosigner(vault, keys))
}

/** Display-only relationships from cached public keys. A device name, database
 * scope or fingerprint alone is never evidence that a wallet is a cosigner. */
export function linkedVaultIds(
  vaults: VaultIdentity[],
  keys: VaultWalletKey[]
): string[] {
  return vaults
    .filter(
      (v) =>
        !v.sessionOnly && vaultHasCosigner(v, keys)
    )
    .map((v) => v.id);
}

/** Stable across refreshes and tile order. These identify relationships, not networks. */
export function vaultLinkColor(id: string): string {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360}, 65%, 72%)`;
}
