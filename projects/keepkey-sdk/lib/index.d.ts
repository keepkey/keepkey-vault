import { VaultClient } from './client';
import type { SdkConfig, DeviceFeatures, DeviceInfo, SignedTx, AddressRequest, EthSignTxParams, EthSignTypedDataParams, EthSignMessageParams, EthVerifyMessageParams, BtcSignTxParams, CosmosAminoSignParams, XrpSignTxParams, BnbSignTxParams, GetPublicKeyRequest, BatchPubkeysPath, ApplySettingsParams, HealthResponse, SupportedAsset } from './types';
export { SdkError } from './client';
export * from './types';
export declare class KeepKeySdk {
    private client;
    /** Use KeepKeySdk.create() instead of constructing directly */
    private constructor();
    /**
     * Create a connected KeepKeySdk instance.
     *
     * Accepts both v2 config shape and v1 compat shape:
     *   v2: { apiKey, baseUrl, serviceName, serviceImageUrl }
     *   v1: { apiKey, basePath, pairingInfo: { name, imageUrl, basePath, url } }
     */
    static create(config?: SdkConfig): Promise<KeepKeySdk>;
    /** Access the underlying HTTP client (for advanced usage) */
    getClient(): VaultClient;
    /** Current API key */
    get apiKey(): string | null;
    system: {
        info: {
            getFeatures: () => Promise<DeviceFeatures>;
            getDevices: () => Promise<{
                devices: DeviceInfo[];
                total: number;
            }>;
            getSupportedAssets: () => Promise<{
                assets: SupportedAsset[];
            }>;
            getHealth: () => Promise<HealthResponse>;
            listCoins: () => Promise<any[]>;
            getPublicKey: (params: GetPublicKeyRequest) => Promise<{
                xpub: string;
            }>;
            ping: () => Promise<{
                message: string;
            }>;
        };
        device: {
            ping: () => Promise<{
                message: string;
            }>;
            wipe: () => Promise<{
                success: boolean;
            }>;
            applySettings: (params: ApplySettingsParams) => Promise<{
                success: boolean;
            }>;
            applyPolicies: (params: any) => Promise<{
                success: boolean;
            }>;
            changePin: (remove?: boolean) => Promise<{
                success: boolean;
            }>;
            clearSession: () => Promise<{
                success: boolean;
            }>;
            resetDevice: (params: {
                word_count?: number;
                label?: string;
                pin_protection?: boolean;
                passphrase_protection?: boolean;
            }) => Promise<{
                success: boolean;
            }>;
            recoverDevice: (params: {
                word_count?: number;
                label?: string;
                pin_protection?: boolean;
                passphrase_protection?: boolean;
            }) => Promise<{
                success: boolean;
            }>;
            loadDevice: (params: any) => Promise<{
                success: boolean;
            }>;
            sendPin: (pin: string) => Promise<{
                success: boolean;
            }>;
        };
    };
    info: any;
    utxo: {
        utxoSignTransaction: (params: any) => Promise<any>;
    };
    xrp: any;
    initialize: any;
    auth: any;
    address: {
        utxoGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        ethGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        ethereumGetAddress: (params: any) => Promise<{
            address: string;
        }>;
        cosmosGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        thorchainGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        mayachainGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        osmosisGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        tendermintGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        xrpGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        bnbGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        binanceGetAddress: (params: any) => Promise<{
            address: string;
        }>;
    };
    eth: {
        ethSignTransaction: (params: EthSignTxParams) => Promise<SignedTx>;
        ethSignMessage: (params: EthSignMessageParams) => Promise<any>;
        ethSignTypedData: (params: EthSignTypedDataParams) => Promise<any>;
        ethVerifyMessage: (params: EthVerifyMessageParams) => Promise<boolean>;
    };
    btc: {
        btcSignTransaction: (params: BtcSignTxParams) => Promise<SignedTx>;
    };
    cosmos: {
        cosmosSignAmino: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        cosmosSignAminoDelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        cosmosSignAminoUndelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        cosmosSignAminoRedelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        cosmosSignAminoWithdrawRewards: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        cosmosSignAminoWithdrawDelegatorRewardsAll: (params: any) => Promise<SignedTx>;
        cosmosSignAminoIbcTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    osmosis: {
        osmosisSignAmino: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoDelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoUndelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoRedelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoWithdrawRewards: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoIbcTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoLpRemove: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoLpAdd: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmosisSignAminoSwap: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        osmoSignAminoDelegate: (params: any) => Promise<SignedTx>;
        osmoSignAminoUndelegate: (params: any) => Promise<SignedTx>;
        osmoSignAminoRedelegate: (params: any) => Promise<SignedTx>;
        osmoSignAminoWithdrawDelegatorRewardsAll: (params: any) => Promise<SignedTx>;
        osmoSignAminoIbcTransfer: (params: any) => Promise<SignedTx>;
        osmoSignAminoLpAdd: (params: any) => Promise<SignedTx>;
        osmoSignAminoLpRemove: (params: any) => Promise<SignedTx>;
        osmoSignAminoSwap: (params: any) => Promise<SignedTx>;
    };
    thorchain: {
        thorchainSignAminoTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        thorchainSignAminoDeposit: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    mayachain: {
        mayachainSignAminoTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        mayachainSignAminoDeposit: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    ripple: {
        xrpSignTransaction: (params: XrpSignTxParams) => Promise<SignedTx>;
    };
    binance: {
        binanceSignTransaction: (params: BnbSignTxParams) => Promise<SignedTx>;
    };
    xpub: {
        getPublicKey: (params: GetPublicKeyRequest) => Promise<{
            xpub: string;
        }>;
        getPublicKeys: (paths: BatchPubkeysPath[]) => Promise<{
            pubkeys: any[];
            cached_count: number;
            total_requested: number;
        }>;
    };
    deviceStatus: {
        isDeviceConnected: () => Promise<boolean>;
    };
}
//# sourceMappingURL=index.d.ts.map