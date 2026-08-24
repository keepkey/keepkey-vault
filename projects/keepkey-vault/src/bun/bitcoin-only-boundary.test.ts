import { describe, expect, test } from 'bun:test'
import {
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

  test('fences ClearSign management and ceremony routes', () => {
    for (const path of ['/eth/clearsign/load-signer', '/eth/clearsign/sign-alpha-delegate-certificate']) {
      expect(bitcoinOnlyRejection('POST', path, {})).not.toBeNull()
    }
  })

  test('fences the complete REST swap-control family', () => {
    for (const path of ['/api/v2/swap/open', '/api/v2/swap/set', '/api/v2/swap/quote', '/api/v2/swap/execute', '/api/v2/swap/close']) {
      expect(bitcoinOnlyRejection('POST', path, {})).not.toBeNull()
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

  test('does not affect non-POST requests', () => {
    expect(bitcoinOnlyRejection('GET', '/addresses/eth')).toBeNull()
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

  test('fences non-Bitcoin address-book networks', () => {
    expect(bitcoinOnlyRpcRejection('matchAddress', { networkId: 'eip155:1' })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('addAddressBook', { networkId: 'cosmos:cosmoshub-4' })).not.toBeNull()
    expect(bitcoinOnlyRpcRejection('addAddressBook', {
      networkId: 'bip122:000000000019d6689c085ae165831e93',
    })).toBeNull()
  })
})
