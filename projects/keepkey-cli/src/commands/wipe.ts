import { getDevice } from '../device'

export async function wipeCommand() {
  const { wallet } = await getDevice()

  console.log('Wiping device... Confirm on your KeepKey.')
  await wallet.wipe()
  console.log('Device wiped.')
  process.exit(0)
}
