import { getDevice } from '../device'

export async function passphraseCommand(args: string[]) {
  const action = args[0]?.toLowerCase()

  if (!action || !['on', 'off', 'enable', 'disable'].includes(action)) {
    console.error('Usage: keepkey passphrase <on|off>')
    process.exit(1)
  }

  const enable = action === 'on' || action === 'enable'
  const { wallet } = await getDevice()

  console.log(`${enable ? 'Enabling' : 'Disabling'} passphrase... Confirm on your KeepKey.`)
  await wallet.applySettings({ usePassphrase: enable })

  const features = await wallet.getFeatures()
  console.log(`Passphrase: ${features.passphraseProtection ? 'enabled' : 'disabled'}`)
  process.exit(0)
}
