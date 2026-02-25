import { readFileSync } from 'fs'
import { getDevice } from '../device'
import { confirm } from '../util/prompt'

// KeepKey firmware binaries start with these magic bytes (KPKY)
const KEEPKEY_MAGIC = Buffer.from([0x4b, 0x50, 0x4b, 0x59])
const MIN_FIRMWARE_SIZE = 32 * 1024      // 32 KB — smallest plausible firmware
const MAX_FIRMWARE_SIZE = 1024 * 1024     // 1 MB — largest plausible firmware

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

  // Basic integrity checks
  if (firmwareBin.length < MIN_FIRMWARE_SIZE || firmwareBin.length > MAX_FIRMWARE_SIZE) {
    console.error(`Firmware size ${firmwareBin.length} bytes is outside expected range (${MIN_FIRMWARE_SIZE}-${MAX_FIRMWARE_SIZE}).`)
    console.error('This does not look like a valid KeepKey firmware binary.')
    process.exit(1)
  }

  console.log(`Firmware binary: ${filePath} (${firmwareBin.length} bytes)`)

  const { wallet, features } = await getDevice()

  if (!features.bootloaderMode) {
    console.log('Device is not in bootloader mode.')
    console.log('To enter bootloader: hold the button while plugging in the device.')
    process.exit(1)
  }

  const ok = await confirm('This will ERASE the current firmware and flash the new binary. Continue?')
  if (!ok) {
    console.log('Aborted.')
    process.exit(0)
  }

  console.log('Erasing current firmware...')
  await wallet.firmwareErase()

  console.log('Uploading firmware...')
  await wallet.firmwareUpload(firmwareBin)

  console.log('Firmware uploaded. Device will reboot.')
  process.exit(0)
}
