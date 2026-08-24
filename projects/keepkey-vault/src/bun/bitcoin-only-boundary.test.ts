import { describe, expect, test } from 'bun:test'
import {
  bitcoinOnlyAddressBookHistoryList,
  bitcoinOnlyActivityList,
  bitcoinOnlyBalanceList,
  bitcoinOnlyChainList,
  bitcoinOnlyCoinAllowed,
  bitcoinOnlyCoinList,
  bitcoinOnlyLedgerJournalList,
  bitcoinOnlyLedgerSummaryList,
  bitcoinOnlyRejection,
  bitcoinOnlyReportAllowed,
  bitcoinOnlyRpcRejection,
  bitcoinOnlySnapshot,
  bitcoinOnlyWatchOnlyScope,
  enforceBitcoinOnlyRpcBoundary,
} from './bitcoin-only-boundary'
import { SIGNING_ROUTES } from './signing-routes'

describe('Bitcoin-only REST boundary', () => {
  test('allows only the firmware coin table', () => {
    for (const coin of [undefined, 'Bitcoin', 'Testnet']) {
      expect(bitcoinOnlyCoinAllowed(coin)).toBe(true)
    }
    for (const coin of ['Litecoin', 'BitcoinCash', 'Dogecoin', 'Zcash', '', 'bitcoin']) {
      expect(bitcoinOnlyCoinAllowed(coin)).toBe(false)
    }
  })

  test('fences every non-Bitcoin signing route', () => {
    for (const path of SIGNING_ROUTES) {
      const body = path === '/utxo/sign-transaction' ? { coin: 'Bitcoin' } : {}
      const rejected = bitcoinOnlyRejection('POST', path, body)
      if (path === '/utxo/sign-transaction') expect(rejected).toBeNull()
      else expect(rejected).not.toBeNull()
    }
  })

  test('fences every dedicated non-Bitcoin address route', () => {
    for (const path of [
      '/addresses/cosmos', '/addresses/osmosis', '/addresses/eth', '/addresses/tendermint',
      '/addresses/thorchain', '/addresses/mayachain', '/addresses/xrp', '/addresses/solana',
      '/addresses/tron', '/addresses/ton', '/addresses/hive',
    ]) {
      expect(bitcoinOnlyRejection('POST', path, {})).not.toBeNull()
    }
    expect(bitcoinOnlyRejection('POST', '/addresses/future-altcoin', {})).not.toBeNull()
  })

  test('fences every dedicated altcoin REST family, including non-signing helpers', () => {
    for (const path of [
      '/eth/clearsign/load-signer', '/eth/verify',
      '/cosmos/sign-amino', '/osmosis/sign-amino-swap',
      '/thorchain/sign-amino-transfer', '/mayachain/sign-amino-deposit',
      '/xrp/sign-transaction', '/solana/sign-message', '/tron/verify-message',
      '/ton/build-transfer', '/hive/sign-message',
      '/api/zcash/shielded/status', '/api/zcash/shielded/build',
    ]) {
      expect(bitcoinOnlyRejection(path.endsWith('/status') ? 'GET' : 'POST', path, {})).not.toBeNull()
    }
  })

  test('fences swap control, stale history, and discovery routes', () => {
    for (const path of ['/api/v2/swap/open', '/api/v2/swap/set', '/api/v2/swap/quote', '/api/v2/swap/execute', '/api/v2/swap/close']) {
      expect(bitcoinOnlyRejection('POST', path, {})).not.toBeNull()
    }
    for (const path of [
      '/api/v1/swaps', '/api/v1/swaps/stats', '/api/v1/swaps/old-txid',
      '/api/v1/swap/availability/eip155%3A1', '/api/v1/swap/discovery',
    ]) {
      expect(bitcoinOnlyRejection('GET', path)).not.toBeNull()
    }
  })

  test('generic UTXO routes allow Bitcoin/Testnet and reject altcoins', () => {
    for (const path of ['/addresses/utxo', '/utxo/sign-transaction']) {
      expect(bitcoinOnlyRejection('POST', path, {})).toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { coin: 'Bitcoin' })).toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { coin: 'Testnet' })).toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { coin: 'Litecoin' })).not.toBeNull()
    }
  })

  test('leaves malformed generic-route bodies to schema validation', () => {
    expect(bitcoinOnlyRejection('POST', '/addresses/utxo', { coin: null })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/utxo/sign-transaction', { coin: 42 })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/system/info/get-public-key', { coin_name: [] })).toBeNull()
  })

  test('generic public-key route rejects altcoin xpubs', () => {
    expect(bitcoinOnlyRejection('POST', '/system/info/get-public-key', { coin_name: 'Bitcoin' })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/system/info/get-public-key', { coin_name: 'Dogecoin' })).not.toBeNull()
  })

  test('fences multichain read surfaces but leaves Bitcoin and neutral reads alone', () => {
    for (const path of [
      '/api/debug/portfolio', '/api/debug/portfolio/tokens',
      '/api/debug/pioneer-audit', '/api/debug/token-visibility',
      '/wc', '/wc/connect',
    ]) {
      expect(bitcoinOnlyRejection('GET', path)).not.toBeNull()
    }
    expect(bitcoinOnlyRejection('GET', '/api/portfolio')).toBeNull()
    expect(bitcoinOnlyRejection('GET', '/api/v1/activity')).toBeNull()
  })

  test('constrains generic Pioneer data routes to Bitcoin inputs', () => {
    const btcNetwork = 'bip122:000000000019d6689c085ae165831e93'
    const btcAsset = `${btcNetwork}/slip44:0`
    const ethNetwork = 'eip155:1'
    const ethAsset = `${ethNetwork}/slip44:60`

    expect(bitcoinOnlyRejection('POST', '/api/v2/portfolio/balances', {
      pubkeys: [{ caip: btcAsset }, { caip: ethAsset }],
    })).not.toBeNull()
    expect(bitcoinOnlyRejection('POST', '/api/v2/portfolio/balances', {
      pubkeys: [{ caip: btcAsset }],
    })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/api/v2/market/info', {
      caips: [btcAsset, ethAsset],
    })).not.toBeNull()
    expect(bitcoinOnlyRejection('POST', '/api/v2/tx/history', {
      queries: [{ caip: ethAsset }],
    })).not.toBeNull()

    for (const path of [
      '/api/v2/utxo/unspent', '/api/v2/utxo/pubkey-info',
    ]) {
      expect(bitcoinOnlyRejection('POST', path, { network: ethNetwork })).not.toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { network: btcNetwork })).toBeNull()
    }
    for (const path of ['/api/v2/tx/broadcast', '/api/v2/network/fee-rate']) {
      expect(bitcoinOnlyRejection('POST', path, { networkId: ethNetwork })).not.toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { networkId: btcNetwork })).toBeNull()
    }
  })

  test('disables Pioneer multichain catalogs and account-state routes', () => {
    for (const [method, path] of [
      ['GET', '/api/v2/assets/available'],
      ['POST', '/api/v2/assets/search'],
      ['POST', '/api/v2/network/gas-price'],
      ['POST', '/api/v2/network/nonce'],
      ['POST', '/api/v2/network/balance'],
      ['POST', '/api/v2/network/token-decimals'],
      ['POST', '/api/v2/staking/positions'],
    ]) {
      expect(bitcoinOnlyRejection(method, path, {})).not.toBeNull()
    }
  })

  test('leaves malformed Pioneer bodies to schema validation', () => {
    expect(bitcoinOnlyRejection('POST', '/api/v2/portfolio/balances', { pubkeys: 'bad' })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/api/v2/market/info', { caips: null })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/api/v2/utxo/unspent', { network: 42 })).toBeNull()
  })

  test('filters coin listings to Bitcoin networks', () => {
    const visible = bitcoinOnlyCoinList([
      { coin: 'Bitcoin', id: 1 },
      { coin: 'Litecoin', id: 2 },
      { coin: 'Testnet', id: 3 },
    ])
    expect(visible.map(coin => coin.coin)).toEqual(['Bitcoin', 'Testnet'])
  })

  test('fences chain-specific renderer RPC before dispatch', () => {
    for (const method of [
      'ethGetAddress', 'solanaSignTx', 'cosmosSignTx', 'zcashShieldedSend',
      'clearsignAttestorSign', 'getEvmAddresses', 'executeSwap', 'getSwapQuote', 'wcPair',
    ]) {
      expect(bitcoinOnlyRpcRejection(method, {})).not.toBeNull()
    }
    for (const method of ['getBalance', 'buildTx', 'broadcastTx', 'scanChainHistory', 'auditScanPaths']) {
      expect(bitcoinOnlyRpcRejection(method, { chainId: 'ethereum' })).not.toBeNull()
      expect(bitcoinOnlyRpcRejection(method, { chainId: 'bitcoin' })).toBeNull()
    }
  })

  test('fences generic UTXO and xpub renderer RPC by coin', () => {
    expect(bitcoinOnlyRpcRejection('btcGetAddress', { coin: 'Litecoin' })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('btcSignTx', { coin: 'Dogecoin' })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('btcSignTx', { coin: 'Bitcoin' })).toBeNull()
    expect(bitcoinOnlyRpcRejection('getPublicKeys', {
      paths: [{ coin: 'Bitcoin' }, { coin: 'Zcash' }],
    })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('getPublicKeys', {
      paths: [{ coin: 'Bitcoin' }, { coin: 'Testnet' }],
    })).toBeNull()
  })

  test('fences dynamic altcoin market and token-state RPC', () => {
    const btc = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
    const eth = 'eip155:1/slip44:60'
    expect(bitcoinOnlyRpcRejection('getMarketData', { caips: [btc] })).toBeNull()
    expect(bitcoinOnlyRpcRejection('getMarketData', { caips: [btc, eth] })).not.toBeNull()
    for (const method of ['setTokenVisibility', 'removeTokenVisibility', 'getTokenVisibilityMap']) {
      expect(bitcoinOnlyRpcRejection(method, { caip: eth })).not.toBeNull()
    }
  })

  test('blocks enabling WalletConnect but permits teardown', () => {
    expect(bitcoinOnlyRpcRejection('setWalletConnectEnabled', { enabled: true })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('setWalletConnectEnabled', { enabled: false })).toBeNull()
    expect(bitcoinOnlyRpcRejection('wcDisconnectSession', { topic: 'old' })).toBeNull()
  })

  test('wrapper rejects before invoking the privileged handler', async () => {
    let calls = 0
    const handlers = enforceBitcoinOnlyRpcBoundary(() => true, {
      ethSignTx: async () => { calls++; return 'signed' },
      btcSignTx: async () => { calls++; return 'signed' },
    })
    await expect(handlers.ethSignTx({})).rejects.toThrow('not available')
    expect(calls).toBe(0)
    expect(await handlers.btcSignTx({ coin: 'Bitcoin' })).toBe('signed')
    expect(calls).toBe(1)
  })

  test('filters automatic chain and cached-balance inputs at source', () => {
    const chains = [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'solana' }]
    const balances = [{ chainId: 'bitcoin' }, { chainId: 'ethereum' }]
    expect(bitcoinOnlyChainList(chains, true)).toEqual([{ id: 'bitcoin' }])
    expect(bitcoinOnlyChainList(chains, false)).toEqual(chains)
    expect(bitcoinOnlyBalanceList(balances, true)).toEqual([{ chainId: 'bitcoin' }])
    expect(bitcoinOnlyBalanceList(balances, false)).toEqual(balances)
  })

  test('filters both activity-store row shapes to Bitcoin', () => {
    const rows = [
      { id: 1, chainId: 'bitcoin' },
      { id: 2, chainId: 'ethereum' },
      { id: 3, chain: 'BTC' },
      { id: 4, chain: 'ETH' },
      { id: 5, chain: 'Bitcoin' },
      { id: 6 },
    ]
    expect(bitcoinOnlyActivityList(rows, true).map(row => row.id)).toEqual([1, 3, 5])
    expect(bitcoinOnlyActivityList(rows, false)).toEqual(rows)
  })

  test('filters stale full-firmware ledger and report state', () => {
    const summary = [
      { id: 1, chainId: 'bitcoin' },
      { id: 2, chainId: 'ethereum' },
    ]
    expect(bitcoinOnlyLedgerSummaryList(summary, true)).toEqual([{ id: 1, chainId: 'bitcoin' }])

    const journals = [
      { id: 1, postings: [{ asset: 'BTC' }, { asset: 'ETH' }] },
      { id: 2, postings: [{ asset: 'ETH' }] },
    ]
    expect(bitcoinOnlyLedgerJournalList(journals, true)).toEqual([
      { id: 1, postings: [{ asset: 'BTC' }] },
    ])
    expect(bitcoinOnlyReportAllowed('all', true)).toBe(false)
    expect(bitcoinOnlyReportAllowed('bitcoin', true)).toBe(true)
    expect(bitcoinOnlyReportAllowed('all', false)).toBe(true)
  })

  test('recognizes bitcoin-only watch-only snapshots', () => {
    expect(bitcoinOnlySnapshot(JSON.stringify({ firmwareVariant: 'KeepKeyBTC' }))).toBe(true)
    expect(bitcoinOnlySnapshot(JSON.stringify({ firmware_variant: 'EmulatorBTC' }))).toBe(true)
    expect(bitcoinOnlySnapshot(JSON.stringify({ firmwareVariant: 'KeepKey' }))).toBe(false)
    expect(bitcoinOnlySnapshot('{broken')).toBe(false)
  })

  test('keeps the current Bitcoin-only device authoritative over stale watch-only snapshots', () => {
    const fullSnapshot = JSON.stringify({ firmwareVariant: 'KeepKey' })
    const bitcoinSnapshot = JSON.stringify({ firmwareVariant: 'KeepKeyBTC' })
    expect(bitcoinOnlyWatchOnlyScope(true, fullSnapshot)).toBe(true)
    expect(bitcoinOnlyWatchOnlyScope(false, bitcoinSnapshot)).toBe(true)
    expect(bitcoinOnlyWatchOnlyScope(false, fullSnapshot)).toBe(false)
  })

  test('filters stale address-book history by Bitcoin asset', () => {
    const rows = [
      { id: 1, caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0' },
      { id: 2, caip: 'eip155:1/slip44:60' },
      { id: 3, caip: 'bip122:000000000933ea01ad0ee984209779ba/slip44:1' },
    ]
    expect(bitcoinOnlyAddressBookHistoryList(rows, true).map(row => row.id)).toEqual([1, 3])
    expect(bitcoinOnlyAddressBookHistoryList(rows, false)).toEqual(rows)
  })

  test('fences non-Bitcoin address-book networks', () => {
    expect(bitcoinOnlyRpcRejection('matchAddress', { networkId: 'eip155:1' })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('addAddressBook', { networkId: 'cosmos:cosmoshub-4' })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('addAddressBook', {
      networkId: 'bip122:000000000019d6689c085ae165831e93',
    })).toBeNull()
  })
})
