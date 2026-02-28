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
  GetPublicKeyRequest,
  BatchPubkeysPath,
  ApplySettingsParams,
  HealthResponse,
  SupportedAsset,
} from './types'

export { SdkError } from './client'
export * from './types'

export class KeepKeySdk {
  private client: VaultClient

  /** Use KeepKeySdk.create() instead of constructing directly */
  private constructor(client: VaultClient) {
    this.client = client

    // ── v1 SDK compat aliases (top-level namespaces) ───────────────
    // Old SDK exposes `sdk.info` directly (same as `sdk.system.info`)
    this.info = this.system.info
    // Old SDK exposes `sdk.utxo` with utxoSignTransaction
    this.utxo = {
      utxoSignTransaction: (params: any): Promise<any> =>
        this.client.post('/utxo/sign-transaction', params),
    }
    // Old SDK exposes `sdk.xrp` (we have `sdk.ripple`)
    this.xrp = this.ripple
    // Old SDK exposes `sdk.initialize`
    this.initialize = {
      resetDevice: this.system.device.resetDevice,
      recoverDevice: this.system.device.recoverDevice,
      loadDevice: this.system.device.loadDevice,
    }
    // Old SDK exposes `sdk.auth`
    this.auth = {
      pair: (): Promise<any> => this.client.post('/auth/pair', {
        name: 'keepkey-vault-sdk', url: '', imageUrl: '',
      }),
    }
  }

  /**
   * Create a connected KeepKeySdk instance.
   *
   * Accepts both v2 config shape and v1 compat shape:
   *   v2: { apiKey, baseUrl, serviceName, serviceImageUrl }
   *   v1: { apiKey, basePath, pairingInfo: { name, imageUrl, basePath, url } }
   */
  static async create(config: SdkConfig = {}): Promise<KeepKeySdk> {
    // Resolve base URL: v2 baseUrl > v1 pairingInfo.url > v1 basePath/pairingInfo.basePath > default
    // NOTE: pairingInfo.basePath is often a swagger URL (e.g. .../spec/swagger.json)
    //       so we prefer pairingInfo.url (actual API base) over pairingInfo.basePath
    let baseUrl = config.baseUrl
      || config.pairingInfo?.url
      || config.basePath
      || config.pairingInfo?.basePath
      || 'http://localhost:1646'

    // Guard: strip path from URLs that look like spec/swagger endpoints
    // e.g. 'http://localhost:1646/spec/swagger.json' → 'http://localhost:1646'
    try {
      const parsed = new URL(baseUrl)
      if (parsed.pathname !== '/') {
        baseUrl = parsed.origin
      }
    } catch { /* not a valid URL, use as-is */ }

    // Resolve service name and image from v1 pairingInfo or v2 flat fields
    const serviceName = config.serviceName
      || config.pairingInfo?.name
      || 'keepkey-vault-sdk'
    const serviceImageUrl = config.serviceImageUrl
      || config.pairingInfo?.imageUrl
      || ''

    const client = new VaultClient(baseUrl, config.apiKey, serviceName, serviceImageUrl)

    // 1. Verify vault is reachable
    const alive = await client.ping()
    if (!alive) throw new SdkError(503, `Vault not reachable at ${baseUrl}`)

    // 2. Validate existing key or auto-pair
    if (config.apiKey) {
      const valid = await client.verifyAuth()
      if (!valid) {
        // Key expired or revoked — re-pair
        await client.pair()
      }
    } else {
      // No key provided — pair now
      await client.pair()
    }

    return new KeepKeySdk(client)
  }

  /** Access the underlying HTTP client (for advanced usage) */
  getClient(): VaultClient {
    return this.client
  }

  /** Current API key */
  get apiKey(): string | null {
    return this.client.getApiKey()
  }

  // ═══════════════════════════════════════════════════════════════════
  // system — device info, health, management
  // ═══════════════════════════════════════════════════════════════════
  system = {
    info: {
      getFeatures: (): Promise<DeviceFeatures> =>
        this.client.post('/system/info/get-features'),

      getDevices: (): Promise<{ devices: DeviceInfo[]; total: number }> =>
        this.client.get('/api/v2/devices'),

      getSupportedAssets: (): Promise<{ assets: SupportedAsset[] }> =>
        this.client.get('/api/v2/devices/supported-assets'),

      getHealth: (): Promise<HealthResponse> =>
        this.client.get('/api/health'),

      listCoins: (): Promise<any[]> =>
        this.client.post('/system/info/list-coins'),

      getPublicKey: (params: GetPublicKeyRequest): Promise<{ xpub: string }> =>
        this.client.post('/system/info/get-public-key', params),

      // v1 SDK compat alias
      ping: (): Promise<{ message: string }> =>
        this.client.post('/system/info/ping'),
    },

    device: {
      ping: (): Promise<{ message: string }> =>
        this.client.post('/system/info/ping'),

      wipe: (): Promise<{ success: boolean }> =>
        this.client.post('/system/wipe-device'),

      applySettings: (params: ApplySettingsParams): Promise<{ success: boolean }> =>
        this.client.post('/system/apply-settings', params),

      applyPolicies: (params: any): Promise<{ success: boolean }> =>
        this.client.post('/system/apply-policies', params),

      changePin: (remove?: boolean): Promise<{ success: boolean }> =>
        this.client.post('/system/change-pin', remove ? { remove: true } : {}),

      clearSession: (): Promise<{ success: boolean }> =>
        this.client.post('/system/clear-session'),

      resetDevice: (params: {
        word_count?: number; label?: string
        pin_protection?: boolean; passphrase_protection?: boolean
      }): Promise<{ success: boolean }> =>
        this.client.post('/system/initialize/reset-device', params),

      recoverDevice: (params: {
        word_count?: number; label?: string
        pin_protection?: boolean; passphrase_protection?: boolean
      }): Promise<{ success: boolean }> =>
        this.client.post('/system/initialize/recover-device', params),

      loadDevice: (params: any): Promise<{ success: boolean }> =>
        this.client.post('/system/initialize/load-device', params),

      sendPin: (pin: string): Promise<{ success: boolean }> =>
        this.client.post('/system/recovery/pin', { pin }),
    },
  }

  // ── v1 compat: top-level info/utxo/xrp/initialize/auth ──────────
  info: any
  utxo: { utxoSignTransaction: (params: any) => Promise<any> }
  xrp: any
  initialize: any
  auth: any

  // ═══════════════════════════════════════════════════════════════════
  // address — derive addresses on the device
  // ═══════════════════════════════════════════════════════════════════
  address = {
    utxoGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/utxo', params),

    ethGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/eth', params),

    // v1 SDK compat alias
    ethereumGetAddress: (params: any): Promise<{ address: string }> =>
      this.client.post('/addresses/eth', params),

    cosmosGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/cosmos', params),

    thorchainGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/thorchain', params),

    mayachainGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/mayachain', params),

    osmosisGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/osmosis', params),

    tendermintGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/tendermint', params),

    xrpGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/xrp', params),

    bnbGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/bnb', params),

    // v1 SDK compat alias
    binanceGetAddress: (params: any): Promise<{ address: string }> =>
      this.client.post('/addresses/bnb', params),

    solanaGetAddress: (params: AddressRequest): Promise<{ address: string }> =>
      this.client.post('/addresses/solana', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // eth — Ethereum signing
  // ═══════════════════════════════════════════════════════════════════
  eth = {
    ethSignTransaction: (params: EthSignTxParams): Promise<SignedTx> =>
      this.client.post('/eth/sign-transaction', params),

    ethSignMessage: (params: EthSignMessageParams): Promise<any> =>
      this.client.post('/eth/sign', params),

    // v1 SDK compat alias (old clients call ethSign instead of ethSignMessage)
    ethSign: (params: EthSignMessageParams): Promise<any> =>
      this.client.post('/eth/sign', params),

    ethSignTypedData: (params: EthSignTypedDataParams): Promise<any> =>
      this.client.post('/eth/sign-typed-data', params),

    ethVerifyMessage: (params: EthVerifyMessageParams): Promise<boolean> =>
      this.client.post('/eth/verify', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // btc — Bitcoin signing
  // ═══════════════════════════════════════════════════════════════════
  btc = {
    btcSignTransaction: (params: BtcSignTxParams): Promise<SignedTx> =>
      this.client.post('/utxo/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // cosmos — Cosmos signing (6 amino endpoints + v1 alias)
  // ═══════════════════════════════════════════════════════════════════
  cosmos = {
    cosmosSignAmino: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino', params),

    cosmosSignAminoDelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-delegate', params),

    cosmosSignAminoUndelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-undelegate', params),

    cosmosSignAminoRedelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-redelegate', params),

    cosmosSignAminoWithdrawRewards: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-withdraw-delegator-rewards-all', params),

    // v1 SDK compat alias (generated API name)
    cosmosSignAminoWithdrawDelegatorRewardsAll: (params: any): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-withdraw-delegator-rewards-all', params),

    cosmosSignAminoIbcTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/cosmos/sign-amino-ibc-transfer', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // osmosis — Osmosis signing (v2 names + v1 osmo* aliases)
  // ═══════════════════════════════════════════════════════════════════
  osmosis = {
    osmosisSignAmino: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino', params),

    osmosisSignAminoDelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-delegate', params),

    osmosisSignAminoUndelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-undelegate', params),

    osmosisSignAminoRedelegate: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-redelegate', params),

    osmosisSignAminoWithdrawRewards: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-withdraw-delegator-rewards-all', params),

    osmosisSignAminoIbcTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-ibc-transfer', params),

    osmosisSignAminoLpRemove: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-lp-remove', params),

    osmosisSignAminoLpAdd: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-lp-add', params),

    osmosisSignAminoSwap: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-swap', params),

    // ── v1 SDK compat aliases (generated API used osmo* prefix) ──
    osmoSignAminoDelegate: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-delegate', params),

    osmoSignAminoUndelegate: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-undelegate', params),

    osmoSignAminoRedelegate: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-redelegate', params),

    osmoSignAminoWithdrawDelegatorRewardsAll: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-withdraw-delegator-rewards-all', params),

    osmoSignAminoIbcTransfer: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-ibc-transfer', params),

    osmoSignAminoLpAdd: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-lp-add', params),

    osmoSignAminoLpRemove: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-lp-remove', params),

    osmoSignAminoSwap: (params: any): Promise<SignedTx> =>
      this.client.post('/osmosis/sign-amino-swap', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // thorchain — THORChain signing
  // ═══════════════════════════════════════════════════════════════════
  thorchain = {
    thorchainSignAminoTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/thorchain/sign-amino-transfer', params),

    thorchainSignAminoDeposit: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/thorchain/sign-amino-deposit', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // mayachain — MAYAChain signing
  // ═══════════════════════════════════════════════════════════════════
  mayachain = {
    mayachainSignAminoTransfer: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/mayachain/sign-amino-transfer', params),

    mayachainSignAminoDeposit: (params: CosmosAminoSignParams): Promise<SignedTx> =>
      this.client.post('/mayachain/sign-amino-deposit', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // ripple — XRP signing
  // ═══════════════════════════════════════════════════════════════════
  ripple = {
    xrpSignTransaction: (params: XrpSignTxParams): Promise<SignedTx> =>
      this.client.post('/xrp/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // binance — BNB signing
  // ═══════════════════════════════════════════════════════════════════
  binance = {
    binanceSignTransaction: (params: BnbSignTxParams): Promise<SignedTx> =>
      this.client.post('/bnb/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // solana — Solana signing
  // ═══════════════════════════════════════════════════════════════════
  solana = {
    solanaSignTransaction: (params: SolanaSignTxParams): Promise<SignedTx> =>
      this.client.post('/solana/sign-transaction', params),
  }

  // ═══════════════════════════════════════════════════════════════════
  // xpub — public key operations (batch + single)
  // ═══════════════════════════════════════════════════════════════════
  xpub = {
    getPublicKey: (params: GetPublicKeyRequest): Promise<{ xpub: string }> =>
      this.client.post('/system/info/get-public-key', params),

    getPublicKeys: (paths: BatchPubkeysPath[]): Promise<{
      pubkeys: any[]; cached_count: number; total_requested: number
    }> =>
      this.client.post('/api/pubkeys/batch', { paths }),
  }

  // ═══════════════════════════════════════════════════════════════════
  // deviceStatus — v1 compat (non-functional, just satisfies type checks)
  // ═══════════════════════════════════════════════════════════════════
  deviceStatus = {
    isDeviceConnected: async (): Promise<boolean> => {
      try {
        const health = await this.client.get<HealthResponse>('/api/health')
        return health.device_connected ?? health.connected ?? false
      } catch { return false }
    },
  }
}
