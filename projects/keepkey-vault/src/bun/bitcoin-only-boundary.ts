import { SIGNING_ROUTES } from './signing-routes'

const BITCOIN_COIN_NAMES = new Set(['Bitcoin', 'Testnet'])
const BITCOIN_NETWORK_IDS = new Set([
  'bip122:000000000019d6689c085ae165831e93',
  'bip122:000000000933ea01ad0ee984209779ba',
])
const BITCOIN_ASSET_CAIPS = new Set([
  'bip122:000000000019d6689c085ae165831e93/slip44:0',
  'bip122:000000000933ea01ad0ee984209779ba/slip44:1',
])
const NON_BITCOIN_RPC_PREFIXES = [
  'clearsign', 'eth', 'cosmos', 'thorchain', 'mayachain', 'osmosis',
  'xrp', 'solana', 'tron', 'ton', 'hive', 'zcash',
]

const NON_BITCOIN_RPC_METHODS = new Set([
  'getDefiPositions', 'getStakingPositions', 'buildDelegateTx',
  'buildUndelegateTx', 'lookupName', 'getNameQuote',
  'buildNameRegistrationTx', 'addUtxoAccount', 'getUtxoAccounts',
  'getEvmAddresses', 'addEvmAddressIndex', 'removeEvmAddressIndex',
  'setEvmSelectedIndex', 'browseChains', 'addCustomToken',
  'removeCustomToken', 'getCustomTokens', 'setCustomTokenIcon',
  'addCustomChain', 'removeCustomChain', 'getCustomChains',
  'executeSwap', 'previewSwapBuild', 'wcPair', 'wcApprovePair',
  'setTokenVisibility', 'removeTokenVisibility', 'getTokenVisibilityMap',
])

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

  if (path.startsWith('/api/v2/swap')) {
    return 'swaps are not available on bitcoin-only firmware'
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

/** Central policy for the privileged renderer -> Bun bridge. The renderer is
 * not a security boundary: stale UI state, a future component, or injected
 * script must not be able to dispatch an altcoin operation after the firmware
 * has identified itself as Bitcoin-only. */
export function bitcoinOnlyRpcRejection(method: string, params?: any): string | null {
  if (method.toLowerCase().includes('swap')) {
    return `${method} is not available on bitcoin-only firmware`
  }
  if (NON_BITCOIN_RPC_PREFIXES.some(prefix => method.startsWith(prefix))) {
    return `${method} is not available on bitcoin-only firmware`
  }
  if (NON_BITCOIN_RPC_METHODS.has(method)) {
    return `${method} is not available on bitcoin-only firmware`
  }

  if (typeof params?.chainId === 'string' && params.chainId !== 'bitcoin') {
    return `chain ${params.chainId} is not available on bitcoin-only firmware`
  }

  if ((method === 'btcGetAddress' || method === 'btcSignTx')
    && !bitcoinOnlyCoinAllowed(params?.coin)) {
    return `coin ${String(params?.coin)} is not available on bitcoin-only firmware`
  }

  if (method === 'getPublicKeys' && Array.isArray(params?.paths)) {
    const unavailable = params.paths.find((path: any) => !bitcoinOnlyCoinAllowed(path?.coin))
    if (unavailable) {
      return `coin ${String(unavailable.coin)} is not available on bitcoin-only firmware`
    }
  }

  if (method === 'getMarketData' && Array.isArray(params?.caips)) {
    const unavailable = params.caips.find((caip: unknown) =>
      typeof caip === 'string' && !BITCOIN_ASSET_CAIPS.has(caip))
    if (unavailable) {
      return `asset ${String(unavailable)} is not available on bitcoin-only firmware`
    }
  }

  if (method === 'setWalletConnectEnabled' && params?.enabled === true) {
    return 'WalletConnect is not available on bitcoin-only firmware'
  }

  if ((method === 'matchAddress' || method === 'addAddressBook')
    && typeof params?.networkId === 'string'
    && !BITCOIN_NETWORK_IDS.has(params.networkId)) {
    return `network ${params.networkId} is not available on bitcoin-only firmware`
  }

  return null
}

type RpcHandler = (...args: any[]) => any

/** Wrap every renderer RPC handler once. This keeps the check ahead of handler
 * side effects and ensures newly-added handlers with a chainId, UTXO coin, or
 * chain-specific prefix inherit the Bitcoin-only boundary automatically. */
export function enforceBitcoinOnlyRpcBoundary<T extends Record<string, RpcHandler>>(
  isBitcoinOnly: () => boolean,
  handlers: T,
): T {
  const wrapped: Record<string, RpcHandler> = {}
  for (const [method, handler] of Object.entries(handlers)) {
    wrapped[method] = async (...args: any[]) => {
      if (isBitcoinOnly()) {
        const rejection = bitcoinOnlyRpcRejection(method, args[0])
        if (rejection) throw new Error(rejection)
      }
      return handler(...args)
    }
  }
  return wrapped as T
}

export function bitcoinOnlyChainList<T extends { id: string }>(chains: T[], enabled: boolean): T[] {
  return enabled ? chains.filter(chain => chain.id === 'bitcoin') : chains
}

export function bitcoinOnlyBalanceList<T extends { chainId: string }>(balances: T[], enabled: boolean): T[] {
  return enabled ? balances.filter(balance => balance.chainId === 'bitcoin') : balances
}

/** Activity rows come from two stores: rebuilt history uses `chainId`, while
 * REST/signing audit rows use the display symbol in `chain`. Fail closed when
 * the current firmware is Bitcoin-only so stale multichain rows from the same
 * device cannot leak back through a secondary host API. */
export function bitcoinOnlyActivityList<T extends { chainId?: string | null; chain?: string | null }>(
  rows: T[],
  enabled: boolean,
): T[] {
  if (!enabled) return rows
  return rows.filter(row => row.chainId === 'bitcoin' || row.chain === 'BTC' || row.chain === 'Bitcoin')
}

export function bitcoinOnlyLedgerSummaryList<T extends { chainId: string }>(rows: T[], enabled: boolean): T[] {
  return enabled ? rows.filter(row => row.chainId === 'bitcoin') : rows
}

export function bitcoinOnlyLedgerJournalList<
  T extends { postings: Array<{ asset: string }> },
>(rows: T[], enabled: boolean): T[] {
  if (!enabled) return rows
  return rows
    .map(row => ({ ...row, postings: row.postings.filter(posting => posting.asset === 'BTC') }))
    .filter(row => row.postings.length > 0) as T[]
}

export function bitcoinOnlyReportAllowed(chain: string | undefined, enabled: boolean): boolean {
  return !enabled || chain === 'bitcoin'
}

export function bitcoinOnlySnapshot(featuresJson: string | undefined): boolean {
  if (!featuresJson) return false
  try {
    const features = JSON.parse(featuresJson)
    return features?.firmwareVariant === 'KeepKeyBTC'
      || features?.firmwareVariant === 'EmulatorBTC'
      || features?.firmware_variant === 'KeepKeyBTC'
      || features?.firmware_variant === 'EmulatorBTC'
  } catch {
    return false
  }
}

/** A connected Bitcoin-only device remains the authority even when the caller
 * selects an older full-firmware snapshot for watch-only display. Without this
 * union, stale snapshot metadata can re-enable altcoin portfolio requests. */
export function bitcoinOnlyWatchOnlyScope(
  currentDeviceBitcoinOnly: boolean,
  snapshotFeaturesJson: string | undefined,
): boolean {
  return currentDeviceBitcoinOnly || bitcoinOnlySnapshot(snapshotFeaturesJson)
}

export function bitcoinOnlyAddressBookHistoryList<T extends { caip: string }>(
  rows: T[],
  enabled: boolean,
): T[] {
  return enabled ? rows.filter(row => BITCOIN_ASSET_CAIPS.has(row.caip)) : rows
}
