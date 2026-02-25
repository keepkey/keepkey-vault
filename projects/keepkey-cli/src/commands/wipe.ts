import { getDevice } from '../device'
import { confirm } from '../util/prompt'

export async function wipeCommand() {
  const ok = await confirm('This will FACTORY RESET the device and erase all keys. Continue?')
  if (!ok) {
    console.log('Aborted.')
    process.exit(0)
  }

  const { wallet } = await getDevice()

  console.log('Wiping device... Confirm on your KeepKey.')
  await wallet.wipe()
  console.log('Device wiped.')
  process.exit(0)
}
