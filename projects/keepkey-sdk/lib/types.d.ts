export interface SdkConfig {
    /** Existing API key (from previous pairing). If omitted, SDK will auto-pair. */
    apiKey?: string;
    /** Vault REST API base URL. Default: http://localhost:1646 */
    baseUrl?: string;
    /** Alias for baseUrl (v1 SDK compat) */
    basePath?: string;
    /** Service key (unused, kept for Pioneer SDK compat) */
    serviceKey?: string;
    /** Name shown in pairing approval dialog */
    serviceName?: string;
    /** Image URL shown in pairing approval dialog */
    serviceImageUrl?: string;
    /** v1 SDK compat — pairing info object */
    pairingInfo?: {
        name?: string;
        imageUrl?: string;
        basePath?: string;
        url?: string;
    };
}
export interface DeviceFeatures {
    vendor: string;
    major_version: number;
    minor_version: number;
    patch_version: number;
    bootloader_mode: boolean;
    device_id: string;
    pin_protection: boolean;
    passphrase_protection: boolean;
    language: string;
    label: string;
    initialized: boolean;
    revision: string;
    bootloader_hash: string;
    imported: boolean;
    pin_cached: boolean;
    passphrase_cached: boolean;
    policies: Array<{
        policy_name: string;
        enabled: boolean;
    }>;
    model: string;
    firmware_variant: string;
    firmware_hash: string;
    no_backup: boolean;
    wipe_code_protection: boolean;
    auto_lock_delay_ms: number;
}
export interface DeviceInfo {
    device_id?: string;
    is_active?: boolean;
    state: string;
    name?: string;
    features?: Partial<DeviceFeatures>;
}
export interface SignedTx {
    serializedTx?: string;
    r?: string;
    s?: string;
    v?: number;
    signature?: string;
    serialized?: string;
}
export interface AddressResult {
    address: string;
}
export interface AddressRequest {
    address_n: number[];
    coin?: string;
    script_type?: string;
    show_display?: boolean;
}
export interface EthSignTxParams {
    addressNList?: number[];
    address_n_list?: number[];
    from?: string;
    to: string;
    value: string;
    data?: string;
    nonce?: string;
    gas?: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    chainId?: number;
}
export interface EthSignTypedDataParams {
    address: string;
    typedData: any;
}
export interface EthSignMessageParams {
    address: string;
    message: string;
}
export interface EthVerifyMessageParams {
    address: string;
    message: string;
    signature: string;
}
export interface BtcSignTxParams {
    coin?: string;
    inputs: any[];
    outputs: any[];
    version?: number;
    locktime?: number;
}
export interface CosmosAminoSignParams {
    signDoc: any;
    signerAddress: string;
}
export interface XrpSignTxParams {
    [key: string]: any;
}
export interface BnbSignTxParams {
    [key: string]: any;
}
export interface SolanaSignTxParams {
    address_n?: number[];
    addressNList?: number[];
    raw_tx: string;
}
export interface GetPublicKeyRequest {
    address_n: number[];
    ecdsa_curve_name?: string;
    show_display?: boolean;
    coin_name?: string;
    script_type?: string;
}
export interface BatchPubkeysPath {
    address_n: number[];
    script_type?: string;
    coin?: string;
    type?: 'xpub' | 'address';
    networks?: string[];
    note?: string;
}
export interface ApplySettingsParams {
    label?: string;
    use_passphrase?: boolean;
    autolock_delay_ms?: number;
}
export interface HealthResponse {
    ready: boolean;
    status: string;
    connected: boolean;
    device_connected: boolean;
    version: string;
    uptime: number;
    apiVersion: number;
    cached_pubkeys: number;
}
export interface PairResponse {
    apiKey: string;
}
export interface SupportedAsset {
    chain: string;
    symbol: string;
    coin: string;
    networkId: string;
    caip: string;
    chainFamily: string;
}
//# sourceMappingURL=types.d.ts.map