import { getDevice } from '../device'
import { readLine, confirm } from '../util/prompt'

export async function loadSeedCommand(args: string[]) {
  let mnemonic = ''

  // Prefer env var (doesn't leak to ps/shell history)
  if (process.env.KEEPKEY_MNEMONIC) {
    mnemonic = process.env.KEEPKEY_MNEMONIC
  } else if (args.includes('--mnemonic')) {
    // Warn about CLI arg exposure, then prompt via stdin instead
    console.warn('WARNING: Passing --mnemonic on the command line exposes your seed in shell history and process listings.')
    console.warn('Enter your mnemonic below instead (it will not be echoed):')
    mnemonic = await readLine('Mnemonic: ')
  } else {
    // Interactive prompt
    console.log('Enter your mnemonic seed phrase:')
    mnemonic = await readLine('Mnemonic: ')
  }

  if (!mnemonic.trim()) {
    console.error('No mnemonic provided.')
    console.error('Usage: keepkey load-seed')
    console.error('  or set KEEPKEY_MNEMONIC environment variable')
    process.exit(1)
  }

  const words = mnemonic.trim().split(/\s+/)
  if (![12, 18, 24].includes(words.length)) {
    console.error(`Invalid mnemonic: expected 12, 18, or 24 words, got ${words.length}`)
    process.exit(1)
  }

  const ok = await confirm(`Load ${words.length}-word seed onto device? This will OVERWRITE any existing seed.`)
  if (!ok) {
    console.log('Aborted.')
    process.exit(0)
  }

  const { wallet } = await getDevice()

  console.log(`Loading ${words.length}-word seed onto device...`)
  await wallet.loadDevice({ mnemonic: mnemonic.trim() })

  const features = await wallet.getFeatures()
  console.log(`Seed loaded. Initialized: ${features.initialized}`)
  process.exit(0)
}
