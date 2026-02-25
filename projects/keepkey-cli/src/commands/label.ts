import { getDevice } from '../device'

export async function labelCommand(args: string[]) {
  const label = args.join(' ')
  if (!label) {
    console.error('Usage: keepkey label <name>')
    process.exit(1)
  }

  const { wallet } = await getDevice()

  console.log(`Setting label to "${label}"... Confirm on your KeepKey.`)
  await wallet.applySettings({ label })

  const features = await wallet.getFeatures()
  console.log(`Label set: ${features.label}`)
  process.exit(0)
}
