import { getDevice } from '../device'

export async function loadSeedCommand(args: string[]) {
  // Accept mnemonic via --mnemonic flag or KEEPKEY_MNEMONIC env var
  let mnemonic = ''
  const mnemonicIdx = args.indexOf('--mnemonic')
  if (mnemonicIdx !== -1 && args[mnemonicIdx + 1]) {
    mnemonic = args[mnemonicIdx + 1]
  } else if (process.env.KEEPKEY_MNEMONIC) {
    mnemonic = process.env.KEEPKEY_MNEMONIC
  }

  if (!mnemonic) {
    console.error('Usage: keepkey load-seed --mnemonic "word1 word2 ... word12"')
    console.error('  or set KEEPKEY_MNEMONIC environment variable')
    process.exit(1)
  }

  const words = mnemonic.trim().split(/\s+/)
  if (![12, 18, 24].includes(words.length)) {
    console.error(`Invalid mnemonic: expected 12, 18, or 24 words, got ${words.length}`)
    process.exit(1)
  }

  const { wallet } = await getDevice()

  console.log(`Loading ${words.length}-word seed onto device...`)
  await wallet.loadDevice({ mnemonic })

  const features = await wallet.getFeatures()
  console.log(`Seed loaded. Initialized: ${features.initialized}`)
  process.exit(0)
}
