import { createHash } from 'node:crypto'

const BANK_SELECTOR_LABEL = 'KeepKey Password Bank locate private bank'

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
    opLabel: key === BANK_SELECTOR_LABEL ? 'Find password bank'
      : key.endsWith(' unlock') ? 'Unlock password bank' : 'Derive password entry' }) : await derive()
  return typeof result === 'string' ? new Uint8Array(Buffer.from(result, 'base64')) : new Uint8Array(result)
}

/** A device-derived selector keeps stored banks separate without keying them by a public address. */
export async function passwordWalletSelector(cipher: (path: number[], label: string) => Promise<Uint8Array>) {
  const bytes = await cipher([0x80002720, 0x8000000b, 0x80000002], BANK_SELECTOR_LABEL)
  try {
    if (bytes.length !== 32) throw new Error('Unexpected device response')
    return createHash('sha256').update('keepkey-password-bank/private-wallet-selector/v1').update(bytes).digest('hex')
  } finally { bytes.fill(0) }
}
