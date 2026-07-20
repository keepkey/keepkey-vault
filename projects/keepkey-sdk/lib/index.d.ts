import { VaultClient } from './client';
import type { SdkConfig, DeviceFeatures, DeviceInfo, SignedTx, AddressRequest, EthSignTxParams, LoadClearsignSignerParams, LoadClearsignSignerResult, EthSignTypedDataParams, EthSignMessageParams, EthVerifyMessageParams, BtcSignTxParams, CosmosAminoSignParams, HiveSignOperationsParams, XrpSignTxParams, BnbSignTxParams, SolanaSignTxParams, SolanaSignOffchainMessageParams, SolanaOffchainMessageSignatureResult, TronSignTxParams, TronSignMessageParams, TronMessageSignatureResult, TronVerifyMessageParams, TronSignTypedHashParams, TronTypedDataSignatureResult, TonSignTxParams, TonSignMessageParams, TonMessageSignatureResult, TonBuildTransferParams, TonBuildTransferResult, TonFinalizeTransferParams, TonFinalizeTransferResult, GetPublicKeyRequest, BatchPubkeysPath, ApplySettingsParams, HealthResponse, SupportedAsset, PortfolioBalancesParams, MarketInfoParams, SearchAssetsParams, ListUnspentParams, PubkeyInfoParams, TxHistoryParams, BroadcastParams, NetworkIdParams, NetworkAddressParams, TokenDecimalsParams, StakingParams, SwapQuoteParams, SweepScanParams, SweepScanStatus, SweepExecuteParams, SweepExecuteResult } from './types';
export { SdkError } from './client';
export * from './types';
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
export declare class KeepKeySdk {
    private client;
    private constructor();
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
    static create(config?: SdkConfig): Promise<KeepKeySdk>;
    /**
     * Access the underlying HTTP client for advanced use cases
     * (custom endpoints, raw requests).
     */
    getClient(): VaultClient;
    /** The current API key, or `null` if not yet paired. */
    get apiKey(): string | null;
    /** Device information, health, and initialization. */
    system: {
        /** Read-only device info and health endpoints. */
        info: {
            /** Get full device features — model, firmware version, PIN/passphrase state, policies. */
            getFeatures: () => Promise<DeviceFeatures>;
            /** List all connected KeepKey devices. */
            getDevices: () => Promise<{
                devices: DeviceInfo[];
                total: number;
            }>;
            /** List assets supported by the connected device. */
            getSupportedAssets: () => Promise<{
                assets: SupportedAsset[];
            }>;
            /** Check REST API health and device connection state. Does not require auth. */
            getHealth: () => Promise<HealthResponse>;
            /** List all coins the firmware knows about. */
            listCoins: () => Promise<any[]>;
            /** Derive an extended public key (xpub) at the given BIP32 path. */
            getPublicKey: (params: GetPublicKeyRequest) => Promise<{
                xpub: string;
            }>;
        };
        /** Device management — PIN, recovery, settings, firmware. */
        device: {
            /** Ping the device. Useful for connection checks. */
            ping: () => Promise<{
                message: string;
            }>;
            /** Wipe all secrets from the device. Requires user confirmation on device. */
            wipe: () => Promise<{
                success: boolean;
            }>;
            /** Change device label, passphrase protection, or auto-lock delay. */
            applySettings: (params: ApplySettingsParams) => Promise<{
                success: boolean;
            }>;
            /** Apply device policy changes. */
            applyPolicies: (params: any) => Promise<{
                success: boolean;
            }>;
            /** Start a PIN change flow. Pass `remove: true` to remove the PIN. */
            changePin: (remove?: boolean) => Promise<{
                success: boolean;
            }>;
            /** Clear the device session (forces PIN re-entry for the next sensitive call). */
            clearSession: () => Promise<{
                success: boolean;
            }>;
            /** Initialize a new device with a fresh seed. Requires user confirmation. */
            resetDevice: (params: {
                word_count?: number;
                label?: string;
                pin_protection?: boolean;
                passphrase_protection?: boolean;
            }) => Promise<{
                success: boolean;
            }>;
            /** Recover an existing device from a seed phrase. Requires user input on device. */
            recoverDevice: (params: {
                word_count?: number;
                label?: string;
                pin_protection?: boolean;
                passphrase_protection?: boolean;
            }) => Promise<{
                success: boolean;
            }>;
            /** Load a device with a specific seed (testing only). */
            loadDevice: (params: any) => Promise<{
                success: boolean;
            }>;
            /** Send a PIN entered via matrix input during a recovery flow. */
            sendPin: (pin: string) => Promise<{
                success: boolean;
            }>;
        };
        /** On-device cipher-recovery character entry (drives a RecoveryDevice flow). */
        recovery: {
            /**
             * Send one ciphered character during on-device cipher recovery.
             * The device shows a scrambled keyboard on the OLED; the host relays the
             * character the user "typed". A finalized word that isn't in the BIP-39
             * wordlist makes the in-flight `recoverDevice()` promise reject with
             * "Word not found in BIP39 wordlist".
             *
             * `seq` is the value last read from `getRecoveryState()`. The vault pins
             * the send to that exact CharacterRequest and to the client that started
             * recovery — a stale, reordered, or foreign send is rejected with 409
             * rather than silently corrupting the decoded word.
             */
            sendCharacter: (character: string, seq: number) => Promise<{
                success: boolean;
            }>;
            /** Delete the last character entered during cipher recovery. Pass the
             *  current `seq` (from `getRecoveryState()`) to pin the delete; the
             *  initiating-client check applies either way. */
            sendCharacterDelete: (seq?: number) => Promise<{
                success: boolean;
            }>;
            /** Finalize cipher-recovery word/seed entry (equivalent to pressing "next"). */
            sendCharacterDone: () => Promise<{
                success: boolean;
            }>;
            /** Current cipher-recovery state. `seq` advances each time the device asks
             *  for the next character — poll it to sync sends with the device. */
            getRecoveryState: () => Promise<{
                active: boolean;
                word_pos: number | null;
                character_pos: number | null;
                seq: number;
            }>;
        };
    };
    /**
     * Derive receive addresses on the device. Every method takes a BIP32
     * derivation path (`address_n`) and returns the derived address.
     *
     * Pass `show_display: true` to have the device show the address
     * on-screen so the user can visually verify it before use.
     */
    address: {
        /** Derive a UTXO (BTC/LTC/BCH/DOGE/DASH) address. */
        utxoGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive an Ethereum (or EVM-compatible) address. */
        ethGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a Cosmos Hub (ATOM) address. */
        cosmosGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a THORChain (RUNE) address. */
        thorchainGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a MAYAChain (CACAO) address. */
        mayachainGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive an Osmosis (OSMO) address. */
        osmosisGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a generic Tendermint-based address. */
        tendermintGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive an XRP (Ripple) address. */
        xrpGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a BNB Beacon Chain address. */
        bnbGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a Solana (SOL) address. */
        solanaGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a TRON (TRX) address. */
        tronGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a TON address. */
        tonGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
        /** Derive a Hive (SLIP-0048) address. */
        hiveGetAddress: (params: AddressRequest) => Promise<{
            address: string;
        }>;
    };
    /** Ethereum and EVM-compatible signing (sign-tx, sign-message, EIP-712). */
    eth: {
        /** Sign an Ethereum or EVM transaction. Supports legacy and EIP-1559. */
        ethSignTransaction: (params: EthSignTxParams) => Promise<SignedTx>;
        /**
         * Load an EVM clear-sign signer into a device key slot (user-confirmed on
         * device). The device shows a trust screen naming the alias + pubkey
         * fingerprint. Default is RAM-only (dropped on reboot — reload per session);
         * pass `persist: true` to keep it in device flash across reboots (until
         * WipeDevice). An optional `icon` (+ `iconWidth`/`iconHeight`) renders the
         * identity's logo on the trust screen and every clear-sign it vouches for.
         * Firmware 7.15.0+. Used to trust a metadata-signing key (e.g. a CI test
         * key in slot 3) so `ethSignTransaction`'s `txMetadata` blobs verify.
         */
        loadClearsignSigner: (params: LoadClearsignSignerParams) => Promise<LoadClearsignSignerResult>;
        /** Sign a personal message (`eth_sign` / `personal_sign`). */
        ethSignMessage: (params: EthSignMessageParams) => Promise<any>;
        /** Sign an EIP-712 typed data structure. */
        ethSignTypedData: (params: EthSignTypedDataParams) => Promise<any>;
        /** Verify an Ethereum personal message signature. Returns `true` if valid. */
        ethVerifyMessage: (params: EthVerifyMessageParams) => Promise<boolean>;
    };
    /** Bitcoin and UTXO chain signing. */
    btc: {
        /** Sign a UTXO transaction (BTC, LTC, BCH, DOGE, DASH, etc.). */
        btcSignTransaction: (params: BtcSignTxParams) => Promise<SignedTx>;
    };
    /** Cosmos Hub amino signing (transfer, staking, IBC). */
    cosmos: {
        /** Sign a generic Cosmos amino message. */
        cosmosSignAmino: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a Cosmos `MsgDelegate`. */
        cosmosSignAminoDelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a Cosmos `MsgUndelegate`. */
        cosmosSignAminoUndelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a Cosmos `MsgBeginRedelegate`. */
        cosmosSignAminoRedelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a Cosmos `MsgWithdrawDelegatorReward` for all delegations. */
        cosmosSignAminoWithdrawRewards: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a Cosmos IBC `MsgTransfer`. */
        cosmosSignAminoIbcTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    /** Osmosis amino signing — transfer, staking, IBC, LP, swap. */
    osmosis: {
        /** Sign a generic Osmosis amino message. */
        osmosisSignAmino: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgDelegate`. */
        osmosisSignAminoDelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgUndelegate`. */
        osmosisSignAminoUndelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgBeginRedelegate`. */
        osmosisSignAminoRedelegate: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgWithdrawDelegatorReward` for all delegations. */
        osmosisSignAminoWithdrawRewards: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis IBC `MsgTransfer`. */
        osmosisSignAminoIbcTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgExitPool` (remove liquidity). */
        osmosisSignAminoLpRemove: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgJoinPool` (add liquidity). */
        osmosisSignAminoLpAdd: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign an Osmosis `MsgSwapExactAmountIn` (swap). */
        osmosisSignAminoSwap: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    /** Hive generic clear-sign op-table signing (fw 7.15.0+). */
    hive: {
        /**
         * Sign 1–4 Hive operations against the device clear-sign op table.
         * Requires the vault's `hive_enabled` setting and firmware >= 7.15.0.
         */
        hiveSignOperations: (params: HiveSignOperationsParams) => Promise<SignedTx>;
    };
    /** THORChain signing (RUNE transfers and deposits for swaps). */
    thorchain: {
        /** Sign a THORChain `MsgSend` transfer. */
        thorchainSignAminoTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a THORChain `MsgDeposit` (used for swaps and loans). */
        thorchainSignAminoDeposit: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    /** MAYAChain signing (CACAO transfers and deposits). */
    mayachain: {
        /** Sign a MAYAChain `MsgSend` transfer. */
        mayachainSignAminoTransfer: (params: CosmosAminoSignParams) => Promise<SignedTx>;
        /** Sign a MAYAChain `MsgDeposit` (used for swaps). */
        mayachainSignAminoDeposit: (params: CosmosAminoSignParams) => Promise<SignedTx>;
    };
    /** XRP (Ripple) signing. */
    ripple: {
        /** Sign an XRP payment transaction. */
        xrpSignTransaction: (params: XrpSignTxParams) => Promise<SignedTx>;
    };
    /** BNB Beacon Chain signing. */
    binance: {
        /** Sign a BNB Beacon Chain transaction. */
        binanceSignTransaction: (params: BnbSignTxParams) => Promise<SignedTx>;
    };
    /** Solana signing (supports SPL tokens). */
    solana: {
        /** Sign a Solana transaction. `raw_tx` must be the base64-encoded serialized transaction. */
        solanaSignTransaction: (params: SolanaSignTxParams) => Promise<SignedTx>;
        /**
         * Sign a Solana off-chain message with domain separation. Firmware
         * builds the spec envelope (`\xff` || "solana offchain" || version ||
         * format || length || message) and Ed25519-signs it. NO AdvancedMode
         * gate is needed — the envelope's leading `\xff` byte is invalid as a
         * Solana transaction prefix, providing the domain separation that
         * `solanaSignMessage` lacks. Format 2 (extended UTF-8) is rejected
         * device-side; only formats 0 (ASCII) and 1 (UTF-8 limited, max 1212
         * bytes) are supported. Verifier MUST reconstruct the envelope locally
         * and verify against it, NOT against the bare message.
         */
        solanaSignOffchainMessage: (params: SolanaSignOffchainMessageParams) => Promise<SolanaOffchainMessageSignatureResult>;
    };
    /** TRON (TRX) signing, including TRC-20 tokens. */
    tron: {
        /** Sign a TRON transaction. `amount` is in sun (1 TRX = 1,000,000 sun). */
        tronSignTransaction: (params: TronSignTxParams) => Promise<SignedTx>;
        /**
         * Sign a message under TIP-191 (TRON's analog of EIP-191 personal_sign):
         *   hash = keccak256("\x19TRON Signed Message:\n" + decimal(len) + msg)
         *   sig  = secp256k1_sign(hash) → 65 bytes (r || s || 27+v)
         *
         * Pass `is_text=false` to send `message` as hex bytes; default treats
         * it as UTF-8.
         */
        tronSignMessage: (params: TronSignMessageParams) => Promise<TronMessageSignatureResult>;
        /**
         * Verify a TIP-191 signature against the claimed Base58Check address.
         * The device recovers the secp256k1 pubkey, derives the canonical
         * TRON address, and compares it against `address`. Returns
         * `{ verified: boolean }`.
         */
        tronVerifyMessage: (params: TronVerifyMessageParams) => Promise<{
            verified: boolean;
        }>;
        /**
         * TIP-712 typed-data signing in hash mode. Host pre-computes the
         * domainSeparator + message hashes per the TIP-712 spec; the device
         * assembles
         *   keccak256("\x19\x01" || domain_separator_hash || message_hash)
         * and signs with secp256k1. Both hashes must be exactly 32 bytes;
         * omit `message_hash` for primaryType="EIP712Domain".
         */
        tronSignTypedHash: (params: TronSignTypedHashParams) => Promise<TronTypedDataSignatureResult>;
    };
    /** TON signing (supports Jettons). */
    ton: {
        /** Sign a TON transaction. `raw_tx` must be the base64- or hex-encoded raw transaction. */
        tonSignTransaction: (params: TonSignTxParams) => Promise<SignedTx>;
        /**
         * Bare Ed25519 over message bytes. NO domain separation — firmware
         * fences this behind the `AdvancedMode` policy. With the policy
         * disabled (default) this call returns a Failure response. Returns
         * the 32-byte Ed25519 public key + 64-byte signature, both hex.
         *
         * For TON Connect-style auth flows, prefer the upcoming `ton_proof`
         * envelope (separate endpoint, not yet implemented) which carries
         * proper domain separation and doesn't need the policy gate.
         */
        tonSignMessage: (params: TonSignMessageParams) => Promise<TonMessageSignatureResult>;
        /**
         * Build an unsigned TON v4R2 transfer. Fetches seqno and wallet
         * state from TonCenter, constructs the body cell, and returns the
         * 32-byte body hash the device should sign — the client never
         * touches BOC/Cell internals. Echo the returned `build` object back
         * to `tonFinalizeTransfer` after signing.
         */
        tonBuildTransfer: (params: TonBuildTransferParams) => Promise<TonBuildTransferResult>;
        /**
         * Finalize a signed TON transfer: assembles the external message
         * BOC from the prior `build` + the device's Ed25519 signature, then
         * broadcasts via TonCenter. Pass `broadcast: false` to skip the
         * broadcast and inspect/retry manually.
         */
        tonFinalizeTransfer: (params: TonFinalizeTransferParams) => Promise<TonFinalizeTransferResult>;
    };
    /** Extended public key (xpub) derivation — single and batch. */
    xpub: {
        /** Derive a single xpub at the given BIP32 path. */
        getPublicKey: (params: GetPublicKeyRequest) => Promise<{
            xpub: string;
        }>;
        /**
         * Derive many xpubs in a single request. The server caches results,
         * so subsequent calls for the same path are fast.
         */
        getPublicKeys: (paths: BatchPubkeysPath[]) => Promise<{
            pubkeys: any[];
            cached_count: number;
            total_requested: number;
        }>;
    };
    /** Quick device connection status. */
    deviceStatus: {
        /** Returns `true` if a KeepKey device is currently connected and responsive. */
        isDeviceConnected: () => Promise<boolean>;
    };
    /**
     * Chain data queries: portfolio balances, market prices, UTXOs,
     * transaction history, fee estimation, and swap quotes. Pulls data
     * from upstream indexers — does not require the device to be connected.
     */
    chain: {
        /** Get portfolio balances across the supplied pubkeys. */
        getPortfolioBalances: (params: PortfolioBalancesParams) => Promise<any>;
        /** Get market info (price, market cap) for the supplied CAIPs. */
        getMarketInfo: (params: MarketInfoParams) => Promise<any>;
        /** List all assets the chain indexer knows about. */
        getAvailableAssets: () => Promise<any>;
        /** Search assets by symbol or name. */
        searchAssets: (params: SearchAssetsParams) => Promise<any>;
        /** List unspent outputs for a UTXO xpub. */
        listUnspent: (params: ListUnspentParams) => Promise<any>;
        /** Get pubkey info (balance, tx count) for a UTXO xpub. */
        getPubkeyInfo: (params: PubkeyInfoParams) => Promise<any>;
        /** Get transaction history for one or more pubkeys. */
        getTransactionHistory: (params: TxHistoryParams) => Promise<any>;
        /** Broadcast a signed transaction to the network. */
        broadcast: (params: BroadcastParams) => Promise<any>;
        /** Get the current recommended fee rate for a UTXO network. */
        getFeeRate: (params: NetworkIdParams) => Promise<any>;
        /** Get the current gas price for an EVM network. */
        getGasPrice: (params: NetworkIdParams) => Promise<any>;
        /** Get the nonce (tx count) for an EVM address. */
        getNonce: (params: NetworkAddressParams) => Promise<any>;
        /** Get the native asset balance for an address. */
        getBalance: (params: NetworkAddressParams) => Promise<any>;
        /** Get the decimals for an ERC-20 / token contract. */
        getTokenDecimals: (params: TokenDecimalsParams) => Promise<any>;
        /** Get staking positions for an address. */
        getStakingPositions: (params: StakingParams) => Promise<any>;
        /** Get a swap quote from the integrated aggregator. */
        getSwapQuote: (params: SwapQuoteParams) => Promise<any>;
        /** Get THORChain/Mayachain inbound addresses (for swap deposits). */
        getInboundAddresses: () => Promise<any>;
    };
    /**
     * Async sweep tool for recovering BTC from non-standard derivation paths
     * (e.g. mistakes from other wallets). Workflow: `startScan` → poll
     * `getScanStatus` → `execute` with a destination.
     */
    sweep: {
        /** Start an async scan for funds on non-standard BTC paths. Returns a `scanId` to poll. */
        startScan: (params?: SweepScanParams) => Promise<{
            scanId: string;
        }>;
        /** Poll scan progress and results. */
        getScanStatus: (scanId: string) => Promise<SweepScanStatus>;
        /** Execute a sweep: build the tx, sign on device, broadcast. */
        execute: (params: SweepExecuteParams) => Promise<SweepExecuteResult>;
    };
}
//# sourceMappingURL=index.d.ts.map