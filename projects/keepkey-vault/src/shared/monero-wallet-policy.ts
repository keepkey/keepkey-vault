/** Hidden wallets must not enter Monero's persistent monitor/transaction paths. */
export const MONERO_STANDARD_WALLET_REQUIRED = 'Monero is unavailable in hidden wallets. Switch to your standard wallet to use Monero.'

type WalletIdentity = {
  readonly isPassphraseWallet?: boolean
  getDeviceState(): { isHiddenWallet?: boolean }
}

export class MoneroWalletPolicyError extends Error {
  constructor() { super(MONERO_STANDARD_WALLET_REQUIRED); this.name = 'MoneroWalletPolicyError' }
}

export function moneroHiddenWallet(engine: WalletIdentity): boolean {
  return engine.isPassphraseWallet === true || engine.getDeviceState().isHiddenWallet === true
}

export function assertMoneroStandardWallet(engine: WalletIdentity): void {
  if (moneroHiddenWallet(engine)) throw new MoneroWalletPolicyError()
}
