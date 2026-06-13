/**
 * Well-known EVM derivation schemes used across wallets — MyEtherWallet shows
 * these as a grid. Funds get stranded on them when a seed is imported into a
 * different wallet. The vault only TRACKS the BIP44/account scheme
 * (evmAddressPath); the Audit wizard surfaces the others (address + balance +
 * explorer) for manual recovery / support handoff, never auto-tracked.
 *
 * Pure data (shared by the bun RPC caller + the frontend grid + tests).
 */
const H = 0x80000000

export interface EvmKnownScheme {
  key: string
  label: string
  template: string // display form with `i` as the index slot
  path: (index: number) => number[]
}

export const EVM_KNOWN_SCHEMES: EvmKnownScheme[] = [
  { key: 'bip44', label: 'BIP44 · MetaMask / Trezor', template: "m/44'/60'/0'/0/i", path: i => [H + 44, H + 60, H + 0, 0, i] },
  { key: 'ledger-live', label: 'Ledger Live', template: "m/44'/60'/i'/0/0", path: i => [H + 44, H + 60, H + i, 0, 0] },
  { key: 'ledger-legacy', label: 'Ledger Legacy · MEW', template: "m/44'/60'/0'/i", path: i => [H + 44, H + 60, H + 0, i] },
  { key: 'ledger-old', label: 'Ledger (pre-2016)', template: "m/44'/60'/160720'/0/i", path: i => [H + 44, H + 60, H + 160720, 0, i] },
  { key: 'legacy-root', label: 'Legacy · Mist / BIP32 root', template: "m/0'/0'/i'", path: i => [H + 0, H + 0, H + i] },
  { key: 'testnet', label: 'Testnet (coin type 1)', template: "m/44'/1'/0'/0/i", path: i => [H + 44, H + 1, H + 0, 0, i] },
]
