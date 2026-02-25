import { readFileSync } from 'fs'
import { getDevice } from '../device'

export async function firmwareCommand(args: string[]) {
  const filePath = args[0]
  if (!filePath) {
    console.error('Usage: keepkey firmware <path-to-firmware.bin>')
    process.exit(1)
  }

  let firmwareBin: Buffer
  try {
    firmwareBin = readFileSync(filePath) as Buffer
  } catch (err: any) {
    console.error(`Cannot read firmware file: ${err.message}`)
    process.exit(1)
  }

  console.log(`Firmware binary: ${filePath} (${firmwareBin.length} bytes)`)

  const { wallet, features } = await getDevice()

  if (!features.bootloaderMode) {
    console.log('Device is not in bootloader mode.')
    console.log('To enter bootloader: hold the button while plugging in the device.')
    process.exit(1)
  }

  console.log('Erasing current firmware...')
  await wallet.firmwareErase()

  console.log('Uploading firmware...')
  await wallet.firmwareUpload(firmwareBin)

  console.log('Firmware uploaded. Device will reboot.')
  process.exit(0)
}
