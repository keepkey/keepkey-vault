import { validateMnemonic } from 'bip39'

type Session = { wallet: object; delegate: object; instance: number; flashName: string }

/** Keep recovery words out of ordinary RPC responses and the main settings view.
 * The live emulator is authoritative, including firmware-generated wallets that
 * have never had a separate mnemonic backup saved by Vault. */
export function createEmulatorSeedBackup(deps: {
  session(): Session | null
  readLive(): Promise<string | null>
  display(mnemonic: string, flashName: string): Promise<void>
  readTimeoutMs?: number
}) {
  let busy = false
  return async (): Promise<{ seedDisplayed: true; flashName: string }> => {
    if (busy) throw new Error('An emulator seed backup is already open')
    const initial = deps.session()
    if (!initial) throw new Error('Unlock and connect the emulator before showing its recovery phrase')
    const matches = () => {
      const current = deps.session()
      return current && current.wallet === initial.wallet && current.delegate === initial.delegate &&
        current.instance === initial.instance && current.flashName === initial.flashName
    }
    busy = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let mnemonic: string | null = null
    try {
      try {
        mnemonic = await Promise.race([deps.readLive(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), deps.readTimeoutMs ?? 6000)
        })])
      } catch { throw new Error('Unable to read the emulator recovery phrase; reconnect the emulator and try again') }
      finally { clearTimeout(timer) }
      if (!matches()) throw new Error('The emulator wallet changed; open its backup again')
      if (typeof mnemonic !== 'string' || !validateMnemonic(mnemonic.trim())) throw new Error('The emulator did not return a valid recovery phrase')
      try { await deps.display(mnemonic.trim(), initial.flashName) }
      catch { throw new Error('The emulator window closed or could not display the recovery phrase') }
      if (!matches()) throw new Error('The emulator wallet changed; open its backup again')
      return { seedDisplayed: true, flashName: initial.flashName }
    } finally {
      mnemonic = null
      busy = false
    }
  }
}
