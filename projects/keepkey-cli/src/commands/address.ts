import { getDevice } from '../device'

// BIP-44 coin types
const COINS: Record<string, { coin: string; method: string; path: number[]; curve?: string; scriptType?: string }> = {
  bitcoin: {
    coin: 'Bitcoin',
    method: 'btcGetAddress',
    path: [0x8000002C, 0x80000000, 0x80000000, 0, 0],
    scriptType: 'p2wpkh',
  },
  ethereum: {
    coin: 'Ethereum',
    method: 'ethGetAddress',
    path: [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
  },
  litecoin: {
    coin: 'Litecoin',
    method: 'btcGetAddress',
    path: [0x8000002C, 0x80000002, 0x80000000, 0, 0],
    scriptType: 'p2wpkh',
  },
  dogecoin: {
    coin: 'Dogecoin',
    method: 'btcGetAddress',
    path: [0x8000002C, 0x80000003, 0x80000000, 0, 0],
  },
  cosmos: {
    coin: 'Cosmos',
    method: 'cosmosGetAddress',
    path: [0x8000002C, 0x80000076, 0x80000000, 0, 0],
  },
  thorchain: {
    coin: 'Thorchain',
    method: 'thorchainGetAddress',
    path: [0x8000002C, 0x800001F5, 0x80000000, 0, 0],
  },
  osmosis: {
    coin: 'Osmosis',
    method: 'osmosisGetAddress',
    path: [0x8000002C, 0x80000076, 0x80000000, 0, 0],
  },
  ripple: {
    coin: 'Ripple',
    method: 'rippleGetAddress',
    path: [0x8000002C, 0x80000090, 0x80000000, 0, 0],
  },
  dash: {
    coin: 'Dash',
    method: 'btcGetAddress',
    path: [0x8000002C, 0x80000005, 0x80000000, 0, 0],
  },
  bitcoincash: {
    coin: 'BitcoinCash',
    method: 'btcGetAddress',
    path: [0x8000002C, 0x80000091, 0x80000000, 0, 0],
  },
}

export async function addressCommand(args: string[]) {
  const coinName = args[0]?.toLowerCase()

  if (!coinName || !(coinName in COINS)) {
    console.error('Usage: keepkey address <coin>')
    console.error(`Supported: ${Object.keys(COINS).join(', ')}`)
    process.exit(1)
  }

  const def = COINS[coinName]
  const show = args.includes('--show')
  const { wallet } = await getDevice()

  const params: any = {
    addressNList: def.path,
    showDisplay: show,
    coin: def.coin,
  }
  if (def.scriptType) params.scriptType = def.scriptType

  const result = await (wallet as any)[def.method](params)
  const address = typeof result === 'string' ? result : result?.address
  console.log(address)
  process.exit(0)
}
