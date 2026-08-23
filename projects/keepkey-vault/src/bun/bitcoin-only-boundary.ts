import { SIGNING_ROUTES } from './signing-routes'

const BITCOIN_COIN_NAMES = new Set(['Bitcoin', 'Testnet'])

/** Bitcoin-only firmware contains exactly the Bitcoin mainnet and testnet coin
 * definitions. Missing coin fields use Bitcoin at the REST handlers. */
export function bitcoinOnlyCoinAllowed(coin: unknown): boolean {
  return coin === undefined || BITCOIN_COIN_NAMES.has(coin as string)
}

function validButUnavailableCoin(coin: unknown): boolean {
  return typeof coin === 'string' && !bitcoinOnlyCoinAllowed(coin)
}

/** Decide whether an HTTP request must fail before it reaches approval UI or
 * the device. The caller invokes this only for a detected BTC-only device. */
export function bitcoinOnlyRejection(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): string | null {
  if (method !== 'POST') return null

  if (path.startsWith('/addresses/') && path !== '/addresses/utxo') {
    return 'address route is not available on bitcoin-only firmware'
  }

  if (path.startsWith('/eth/clearsign/')) {
    return 'ClearSign is not available on bitcoin-only firmware'
  }

  if (SIGNING_ROUTES.has(path) && path !== '/utxo/sign-transaction') {
    return 'non-Bitcoin signing is not available on bitcoin-only firmware'
  }

  if (path === '/addresses/utxo' || path === '/utxo/sign-transaction') {
    if (validButUnavailableCoin(body?.coin)) {
      return `coin ${String(body?.coin)} is not available on bitcoin-only firmware`
    }
  }

  if (path === '/system/info/get-public-key' && validButUnavailableCoin(body?.coin_name)) {
    return `coin ${String(body?.coin_name)} is not available on bitcoin-only firmware`
  }

  return null
}

export function bitcoinOnlyCoinList<T extends { coin: string }>(coins: T[]): T[] {
  return coins.filter(coin => bitcoinOnlyCoinAllowed(coin.coin))
}
