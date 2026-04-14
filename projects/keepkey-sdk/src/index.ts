import { VaultClient, SdkError } from './client'
import type {
  SdkConfig,
  DeviceFeatures,
  DeviceInfo,
  SignedTx,
  AddressRequest,
  EthSignTxParams,
  EthSignTypedDataParams,
  EthSignMessageParams,
  EthVerifyMessageParams,
  BtcSignTxParams,
  CosmosAminoSignParams,
  XrpSignTxParams,
  BnbSignTxParams,
  SolanaSignTxParams,
  TronSignTxParams,
  TonSignTxParams,
  GetPublicKeyRequest,
  BatchPubkeysPath,
  ApplySettingsParams,
  HealthResponse,
  SupportedAsset,
  PortfolioBalancesParams,
  MarketInfoParams,
  SearchAssetsParams,
  ListUnspentParams,
  PubkeyInfoParams,
  TxHistoryParams,
  BroadcastParams,
  NetworkIdParams,
  NetworkAddressParams,
  TokenDecimalsParams,
  StakingParams,
  SwapQuoteParams,
  SweepScanParams,
  SweepScanStatus,
  SweepExecuteParams,
  SweepExecuteResult,
} from './types'

export { SdkError } from './client'
export * from './types'

/**
 * Typed client for the KeepKey REST API.
 *
 * The KeepKey desktop application exposes a local REST API on
 * `http://localhost:1646`. This SDK is a thin, typed wrapper around
 * that API — zero dependencies, native `fetch`, works in browser,
 * Node, Bun, and edge runtimes.
 *
 * @example
 * ```ts
 * import { KeepKeySdk } from 'keepkey-vault-sdk'
 *
 * const sdk = await KeepKeySdk.create({
 *   serviceName: 'My App',
 *   serviceImageUrl: 'https://example.com/icon.png',
 * })
 *
 * const { address } = await sdk.address.ethGetAddress({
 *   address_n: [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
 *   show_display: true,
 * })
 * ```
 */
export class KeepKeySdk {
  private client: VaultClient

  private constructor(client: VaultClient) {
    this.client = client
  }

  /**
   * Create a connected `KeepKeySdk` instance.
   *
   * Verifies the local REST API is reachable, then either validates
   * the supplied `apiKey` or initiates a new pairing (which requires
   * the user to approve on the device).
   *
   * @param config - Optional configuration. If `apiKey` is omitted, the
   *   SDK will auto-pair, which shows an approval prompt in the KeepKey app.
   * @returns A connected `KeepKeySdk` ready to make API calls.
   * @throws {@link SdkError} if the REST API is not reachable or pairing fails.
   */
  static async create(config: SdkConfig = {}): Promise<KeepKeySdk> {
    let baseUrl = config.baseUrl
      || config.pairingInfo?.url
      || config.basePath
      || config.pairingInfo?.basePath
      || 'http://localhost:1646'

    // Strip path from URLs that look like spec/swagger endpoints
    // e.g. 'http://localhost:1646/spec/swagger.json' → 'http://localhost:1646'
    try {
      const parsed = new URL(baseUrl)
      if (parsed.pathname !== '/') {
        baseUrl = parsed.origin
      }
    } catch { /* not a valid URL, use as-is */ }

    const serviceName = config.serviceName
      || config.pairingInfo?.name
      || 'keepkey-sdk'
    const serviceImageUrl = config.serviceImageUrl
      || config.pairingInfo?.imageUrl
      || ''

    const client = new VaultClient(baseUrl, config.apiKey, serviceName, serviceImageUrl)

    const alive = await client.ping()
    if (!alive) throw new SdkError(503, `KeepKey REST API not reachable at ${baseUrl}`)

    if (config.apiKey) {
      const valid = await client.verifyAuth()
      if (!valid) {
        await client.pair()
      }
    } else {
      await client.pair()
    }

    return new KeepKeySdk(client)
  }

  /**
   * Access the underlying HTTP client for advanced use cases
   * (custom endpoints, raw requests).
   */
  getClient(): VaultClient {
    return this.client
  }

  /** The current API key, or `null` if not yet paired. */
  get apiKey(): string | null {
    return this.client.getApiKey()
  }

  // ═══════════════════════════════════════════════════════════════════
  // system — device info, health, management
  // ═══════════════════════════════════════════════════════════════════

  /** Device information, health, and initialization. */
  system = {
    /** Read-only device info and health endpoints. */
    info: {
      /** Get full device features — model, firmware version, PIN/passphrase state, policies. */
      getFeatures: (): Promise<DeviceFeatures> =>
        this.client.post('/system/info/get-features'),

      /** List all connected KeepKey devices. */
      getDevices: (): Promise<{ devices: DeviceInfo[]; total: number }> =>
        this.client.get('/api/v2/devices'),

      /** List assets supported by the connected device. */
      getSupportedAssets: (): Promise<{ assets: SupportedAsset[] }> =>
        this.client.get('/api/v2/devices/supported-assets'),

      /** Check REST API health and device connection state. Does not require auth. */
      getHealth: (): Promise<HealthResponse> =>
        this.client.get('/api/health'),

      /** List all coins the firmware knows about. */
      listCoins: (): Promise<any[]> =>
        this.client.post('/system/info/list-coins'),

      /** Derive an extended public key (xpub) at the given BIP32 path. */
      getPublicKey: (params: GetPublicKeyRequest): Promise<{ xpub: string }> =>
        this.client.post('/system/info/get-public-key', params),
    },

    /** Device management — PIN, recovery, settings, firmware. */
    device: {
      /** Ping the device. Useful for connection checks. */
      ping: (): Promise<{ message: string }> =>
        this.client.post('/system/info/ping'),

      /** Wipe all secrets from the device. Requires user confirmation on device. */
      wipe: (): Promise<{ success: boolean }> =>
        this.client.post('/system/wipe-device'),

      /** Change device label, passphrase protection, or auto-lock delay. */
      applySettings: (params: ApplySettingsParams): Promise<{ success: boolean }> =>
        this.client.post('/system/apply-settings', params),

      /** Apply device policy changes. */
      applyPolicies: (params: any): Promise<{ success: boolean }> =>
        this.client.post('/system/apply-policies', params),

      /** Start a PIN change flow. Pass `remove: true` to remove the PIN. */
      changePin: (remove?: boolean): Promise<{ success: boolean }> =>
        this.client.post('/system/change-pin', remove ? { remove: true } : {}),

      /** Clear the device session (forces PIN re-entry for the next sensitive call). */
      clearSession: (): Promise<{ success: boolean }> =>
        this.client.post('/system/clear-session'),

      /** Initialize a new device with a fresh seed. Requires user confirmation. */
      resetDevice: (params: {
        word_count?: number; label?: string
        pin_protection?: boolean; passphrase_protection?: boolean
      }): Promise<{ success: boolean }> =>
        this.client.post('/system/initialize/reset-device', params),

      /** Recover an existing device from a seed phrase. Requires user input on device. */
      recoverDevice: (params: {
        word_count?: number; label?: string
        pin_protection?: boolean; passphrase_protection?: boolean
      }): Promise<{ success: boolean }> =>
        this.client.post('/system/initialize/recover-device', params),

      /** Load a device with a specific seed (testing only). */
      loadDevice: (params: any): Promise<{ success: boolean }> =>
        this.client.post('/system/initialize/load-device', params),

      /** Send a PIN entered via matrix input during a recovery flow. */
      sendPin: (pin: string): Promise<{ success: boolean }> =>
        this.client.post('/system/recovery/pin', { pin }),
    },
  }

  // ═══════════════════════════════════════════════════════════════════
  // address — derive addresses on the device
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Derive receive addresses on the device. Every method takes a BIP32
   * derivation path (`address_n`) and returns the derived address.
   *
   * Pass `show_display: true` to have the device show the address
   * on-screen so the user can visually verify it before use.
   */
  address = {
    /** Derive a UTXO (BTC/LTC/BCH/DOGE/DASH) address. */
    utxoGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/utxo', params),

    /** Derive an Ethereum (or EVM-compatible) address. */
    ethGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/eth', params),

    /** Derive a Cosmos Hub (ATOM) address. */
    cosmosGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/cosmos', params),

    /** Derive a THORChain (RUNE) address. */
    thorchainGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/thorchain', params),

    /** Derive a MAYAChain (CACAO) address. */
    mayachainGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/mayachain', params),

    /** Derive an Osmosis (OSMO) address. */
    osmosisGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/osmosis', params),

    /** Derive a generic Tendermint-based address. */
    tendermintGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/tendermint', params),

    /** Derive an XRP (Ripple) address. */
    xrpGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/xrp', params),

    /** Derive a BNB Beacon Chain address. */
    bnbGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/bnb', params),

    /** Derive a Solana (SOL) address. */
    solanaGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/solana', params),

    /** Derive a TRON (TRX) address. */
    tronGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/tron', params),

    /** Derive a TON address. */
    tonGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/ton', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // eth — Ethereum / EVM signing
  // ═══════════════════════════════════════════════════════════════════

  /** Ethereum and EVM-compatible signing (sign-tx, sign-message, EIP-712). */
  eth = {
    /** Sign an Ethereum or EVM transaction. Supports legacy and EIP-1559. */
    ethSignTransaction: (params: EthSignTxParams): Promise<SignedTx> =>
      this.client.post('/eth/sign-transaction', params),

    /** Sign a personal message (`eth_sign` / `personal_sign`). */
    ethSignMessage: (params: EthSignMessageParams): Promise<any> =>
      this.client.post('/eth/sign', params),

    /** Sign an EIP-712 typed data structure. */
    ethSignTypedData: (params: EthSignTypedDataParams): Promise<any> =>
      this.client.post('/eth/sign-typed-data', params),

    /** Verify an Ethereum personal message signature. Returns `true` if valid. */
    ethVerifyMessage: (params: EthVerifyMessageParams): Promise<boolean> =>
      this.client.post('/eth/verify', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // btc — Bitcoin / UTXO signing
  // ═══════════════════════════════════════════════════════════════════

  /** Bitcoin and UTXO chain signing. */
  btc = {
    /** Sign a UTXO transaction (BTC, LTC, BCH, DOGE, DASH, etc.). */
    btcSignTransaction: (params: BtcSignTxParams): Promise<SignedTx> =>
      this.client.post('/utxo/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // cosmos — Cosmos Hub signing
  // ═══════════════════════════════════════════════════════════════════

  /** Cosmos Hub amino signing (transfer, staking, IBC). */
  cosmos = {
    /** Sign a generic Cosmos amino message. */
    cosmosSignAmino: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino', params),

    /** Sign a Cosmos `MsgDelegate`. */
    cosmosSignAminoDelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-delegate', params),

    /** Sign a Cosmos `MsgUndelegate`. */
    cosmosSignAminoUndelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-undelegate', params),

    /** Sign a Cosmos `MsgBeginRedelegate`. */
    cosmosSignAminoRedelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-redelegate', params),

    /** Sign a Cosmos `MsgWithdrawDelegatorReward` for all delegations. */
    cosmosSignAminoWithdrawRewards: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-withdraw-delegator-rewards-all', params),

    /** Sign a Cosmos IBC `MsgTransfer`. */
    cosmosSignAminoIbcTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-ibc-transfer', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // osmosis — Osmosis signing
  // ═══════════════════════════════════════════════════════════════════

  /** Osmosis amino signing — transfer, staking, IBC, LP, swap. */
  osmosis = {
    /** Sign a generic Osmosis amino message. */
    osmosisSignAmino: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino', params),

    /** Sign an Osmosis `MsgDelegate`. */
    osmosisSignAminoDelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-delegate', params),

    /** Sign an Osmosis `MsgUndelegate`. */
    osmosisSignAminoUndelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-undelegate', params),

    /** Sign an Osmosis `MsgBeginRedelegate`. */
    osmosisSignAminoRedelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-redelegate', params),

    /** Sign an Osmosis `MsgWithdrawDelegatorReward` for all delegations. */
    osmosisSignAminoWithdrawRewards: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-withdraw-delegator-rewards-all', params),

    /** Sign an Osmosis IBC `MsgTransfer`. */
    osmosisSignAminoIbcTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-ibc-transfer', params),

    /** Sign an Osmosis `MsgExitPool` (remove liquidity). */
    osmosisSignAminoLpRemove: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-lp-remove', params),

    /** Sign an Osmosis `MsgJoinPool` (add liquidity). */
    osmosisSignAminoLpAdd: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-lp-add', params),

    /** Sign an Osmosis `MsgSwapExactAmountIn` (swap). */
    osmosisSignAminoSwap: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-swap', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // thorchain — THORChain signing
  // ═══════════════════════════════════════════════════════════════════

  /** THORChain signing (RUNE transfers and deposits for swaps). */
  thorchain = {
    /** Sign a THORChain `MsgSend` transfer. */
    thorchainSignAminoTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/thorchain/sign-amino-transfer', params),

    /** Sign a THORChain `MsgDeposit` (used for swaps and loans). */
    thorchainSignAminoDeposit: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/thorchain/sign-amino-deposit', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // mayachain — MAYAChain signing
  // ═══════════════════════════════════════════════════════════════════

  /** MAYAChain signing (CACAO transfers and deposits). */
  mayachain = {
    /** Sign a MAYAChain `MsgSend` transfer. */
    mayachainSignAminoTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/mayachain/sign-amino-transfer', params),

    /** Sign a MAYAChain `MsgDeposit` (used for swaps). */
    mayachainSignAminoDeposit: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/mayachain/sign-amino-deposit', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // ripple — XRP signing
  // ═══════════════════════════════════════════════════════════════════

  /** XRP (Ripple) signing. */
  ripple = {
    /** Sign an XRP payment transaction. */
    xrpSignTransaction: (params: XrpSignTxParams): Promise<SignedTx> =>
      this.client.post('/xrp/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // binance — BNB Beacon Chain signing
  // ═══════════════════════════════════════════════════════════════════

  /** BNB Beacon Chain signing. */
  binance = {
    /** Sign a BNB Beacon Chain transaction. */
    binanceSignTransaction: (params: BnbSignTxParams): Promise<SignedTx> =>
      this.client.post('/bnb/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // solana — Solana signing
  // ═══════════════════════════════════════════════════════════════════

  /** Solana signing (supports SPL tokens). */
  solana = {
    /** Sign a Solana transaction. `raw_tx` must be the base64-encoded serialized transaction. */
    solanaSignTransaction: (params: SolanaSignTxParams): Promise<SignedTx> =>
      this.client.post('/solana/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // tron — TRON signing
  // ═══════════════════════════════════════════════════════════════════

  /** TRON (TRX) signing, including TRC-20 tokens. */
  tron = {
    /** Sign a TRON transaction. `amount` is in sun (1 TRX = 1,000,000 sun). */
    tronSignTransaction: (params: TronSignTxParams): Promise<SignedTx> =>
      this.client.post('/tron/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // ton — TON signing
  // ═══════════════════════════════════════════════════════════════════

  /** TON signing (supports Jettons). */
  ton = {
    /** Sign a TON transaction. `raw_tx` must be the base64- or hex-encoded raw transaction. */
    tonSignTransaction: (params: TonSignTxParams): Promise<SignedTx> =>
      this.client.post('/ton/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // xpub — public key operations
  // ═══════════════════════════════════════════════════════════════════

  /** Extended public key (xpub) derivation — single and batch. */
  xpub = {
    /** Derive a single xpub at the given BIP32 path. */
    getPublicKey: (params: GetPublicKeyRequest): Promise<{ xpub: string }> =>
      this.client.post('/system/info/get-public-key', params),

    /**
     * Derive many xpubs in a single request. The server caches results,
     * so subsequent calls for the same path are fast.
     */
    getPublicKeys: (paths: BatchPubkeysPath[]): Promise<{
      pubkeys: any[]; cached_count: number; total_requested: number
    }> =>
      this.client.post('/api/pubkeys/batch', { paths }),
  }

  // ═══════════════════════════════════════════════════════════════════
  // deviceStatus — connection check
  // ═══════════════════════════════════════════════════════════════════

  /** Quick device connection status. */
  deviceStatus = {
    /** Returns `true` if a KeepKey device is currently connected and responsive. */
    isDeviceConnected: async (): Promise<boolean> => {
      try {
        const health = await this.client.get<HealthResponse>('/api/health')
        return health.device_connected ?? health.connected ?? false
      } catch { return false }
    },
  }

  // ═══════════════════════════════════════════════════════════════════
  // chain — chain data queries (balances, market, UTXOs, tx, swap)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Chain data queries: portfolio balances, market prices, UTXOs,
   * transaction history, fee estimation, and swap quotes. Pulls data
   * from upstream indexers — does not require the device to be connected.
   */
  chain = {
    /** Get portfolio balances across the supplied pubkeys. */
    getPortfolioBalances: (params: PortfolioBalancesParams): Promise<any> =>
      this.client.post('/api/v2/portfolio/balances', params),

    /** Get market info (price, market cap) for the supplied CAIPs. */
    getMarketInfo: (params: MarketInfoParams): Promise<any> =>
      this.client.post('/api/v2/market/info', params),

    /** List all assets the chain indexer knows about. */
    getAvailableAssets: (): Promise<any> =>
      this.client.get('/api/v2/assets/available'),

    /** Search assets by symbol or name. */
    searchAssets: (params: SearchAssetsParams): Promise<any> =>
      this.client.post('/api/v2/assets/search', params),

    /** List unspent outputs for a UTXO xpub. */
    listUnspent: (params: ListUnspentParams): Promise<any> =>
      this.client.post('/api/v2/utxo/unspent', params),

    /** Get pubkey info (balance, tx count) for a UTXO xpub. */
    getPubkeyInfo: (params: PubkeyInfoParams): Promise<any> =>
      this.client.post('/api/v2/utxo/pubkey-info', params),

    /** Get transaction history for one or more pubkeys. */
    getTransactionHistory: (params: TxHistoryParams): Promise<any> =>
      this.client.post('/api/v2/tx/history', params),

    /** Broadcast a signed transaction to the network. */
    broadcast: (params: BroadcastParams): Promise<any> =>
      this.client.post('/api/v2/tx/broadcast', params),

    /** Get the current recommended fee rate for a UTXO network. */
    getFeeRate: (params: NetworkIdParams): Promise<any> =>
      this.client.post('/api/v2/network/fee-rate', params),

    /** Get the current gas price for an EVM network. */
    getGasPrice: (params: NetworkIdParams): Promise<any> =>
      this.client.post('/api/v2/network/gas-price', params),

    /** Get the nonce (tx count) for an EVM address. */
    getNonce: (params: NetworkAddressParams): Promise<any> =>
      this.client.post('/api/v2/network/nonce', params),

    /** Get the native asset balance for an address. */
    getBalance: (params: NetworkAddressParams): Promise<any> =>
      this.client.post('/api/v2/network/balance', params),

    /** Get the decimals for an ERC-20 / token contract. */
    getTokenDecimals: (params: TokenDecimalsParams): Promise<any> =>
      this.client.post('/api/v2/network/token-decimals', params),

    /** Get staking positions for an address. */
    getStakingPositions: (params: StakingParams): Promise<any> =>
      this.client.post('/api/v2/staking/positions', params),

    /** Get a swap quote from the integrated aggregator. */
    getSwapQuote: (params: SwapQuoteParams): Promise<any> =>
      this.client.post('/api/v2/swap/quote', params),

    /** Get THORChain/Mayachain inbound addresses (for swap deposits). */
    getInboundAddresses: (): Promise<any> =>
      this.client.get('/api/v2/swap/inbound-addresses'),
  }

  // ═══════════════════════════════════════════════════════════════════
  // sweep — BTC non-standard path recovery
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Async sweep tool for recovering BTC from non-standard derivation paths
   * (e.g. mistakes from other wallets). Workflow: `startScan` → poll
   * `getScanStatus` → `execute` with a destination.
   */
  sweep = {
    /** Start an async scan for funds on non-standard BTC paths. Returns a `scanId` to poll. */
    startScan: (params: SweepScanParams = {}): Promise<{ scanId: string }> =>
      this.client.post('/api/v2/sweep/scan', params),

    /** Poll scan progress and results. */
    getScanStatus: (scanId: string): Promise<SweepScanStatus> =>
      this.client.get(`/api/v2/sweep/scan/${scanId}`),

    /** Execute a sweep: build the tx, sign on device, broadcast. */
    execute: (params: SweepExecuteParams): Promise<SweepExecuteResult> =>
      this.client.post('/api/v2/sweep/execute', params),
  }
}
