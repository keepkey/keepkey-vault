import { getDevice } from '../device'

const WORD_COUNT_TO_ENTROPY: Record<number, 128 | 192 | 256> = {
  12: 128, 18: 192, 24: 256,
}

export async function initializeCommand(args: string[]) {
  const wordCount = parseInt(args[0] || '12', 10)
  if (!(wordCount in WORD_COUNT_TO_ENTROPY)) {
    console.error('Usage: keepkey initialize [12|18|24]')
    process.exit(1)
  }

  const { wallet } = await getDevice()

  console.log(`Initializing device with ${wordCount}-word seed...`)
  console.log('Follow the prompts on your KeepKey device.')

  await wallet.reset({
    entropy: WORD_COUNT_TO_ENTROPY[wordCount],
    label: 'KeepKey',
    pin: true,
    passphrase: false,
    autoLockDelayMs: 600000,
  })

  const features = await wallet.getFeatures()
  console.log(`Device initialized. Label: ${features.label || 'KeepKey'}`)
  process.exit(0)
}
