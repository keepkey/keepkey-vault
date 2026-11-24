export interface CipherWallet {
  cipherKeyValue: (params: { addressNList: number[]; key: string; value: Uint8Array; iv: Uint8Array;
    encrypt: boolean; askOnEncrypt: boolean; askOnDecrypt: boolean }) => Promise<string | Uint8Array>
}
export function supportsDeviceCipher(wallet: unknown): wallet is CipherWallet {
  return typeof wallet === 'object' && wallet !== null && 'cipherKeyValue' in wallet && typeof wallet.cipherKeyValue === 'function'
}
type Confirm = (operation: () => Promise<string | Uint8Array>, details: { operation: string; opLabel: string }) => Promise<string | Uint8Array>

export function confirmedDeviceCipher(wallet: CipherWallet, addressNList: number[], key: string) {
  return wallet.cipherKeyValue({ addressNList, key, value: new Uint8Array(32), iv: new Uint8Array(16),
    encrypt: true, askOnEncrypt: true, askOnDecrypt: true })
}

/** Every emulator derivation uses the same explicit button gate as device
 * signing. Physical KeepKeys retain their own firmware confirmation. */
export async function passwordDeviceCipher(wallet: CipherWallet, addressNList: number[], key: string,
  emulator: boolean, confirm: Confirm): Promise<Uint8Array> {
  const derive = () => confirmedDeviceCipher(wallet, addressNList, key)
  const result = emulator ? await confirm(derive, { operation: 'passwordBankCipher',
    opLabel: key.endsWith(' unlock') ? 'Unlock password bank' : 'Derive password entry' }) : await derive()
  return typeof result === 'string' ? new Uint8Array(Buffer.from(result, 'base64')) : new Uint8Array(result)
}
