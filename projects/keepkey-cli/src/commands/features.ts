import { getDevice } from '../device'

export async function featuresCommand() {
  const { features, transport } = await getDevice()

  const fw = features.majorVersion
    ? `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
    : features.firmwareVersion || 'unknown'

  console.log('KeepKey Device Features')
  console.log('─'.repeat(40))
  console.log(`  Transport:    ${transport}`)
  console.log(`  Device ID:    ${features.deviceId || 'n/a'}`)
  console.log(`  Label:        ${features.label || '(none)'}`)
  console.log(`  Firmware:     ${fw}`)
  console.log(`  Bootloader:   ${features.bootloaderMode ? 'YES (bootloader mode)' : 'no'}`)
  console.log(`  Initialized:  ${features.initialized ? 'yes' : 'no'}`)
  console.log(`  PIN:          ${features.pinProtection ? 'enabled' : 'disabled'}`)
  console.log(`  Passphrase:   ${features.passphraseProtection ? 'enabled' : 'disabled'}`)
  console.log(`  Model:        ${features.model || 'KeepKey'}`)
  console.log(`  Vendor:       ${features.vendor || 'keepkey.com'}`)

  process.exit(0)
}
