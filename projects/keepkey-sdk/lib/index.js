"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeepKeySdk = exports.SdkError = void 0;
const client_1 = require("./client");
var client_2 = require("./client");
Object.defineProperty(exports, "SdkError", { enumerable: true, get: function () { return client_2.SdkError; } });
__exportStar(require("./types"), exports);
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
class KeepKeySdk {
    constructor(client) {
        // ═══════════════════════════════════════════════════════════════════
        // system — device info, health, management
        // ═══════════════════════════════════════════════════════════════════
        /** Device information, health, and initialization. */
        this.system = {
            /** Read-only device info and health endpoints. */
            info: {
                /** Get full device features — model, firmware version, PIN/passphrase state, policies. */
                getFeatures: () => this.client.post('/system/info/get-features'),
                /** List all connected KeepKey devices. */
                getDevices: () => this.client.get('/api/v2/devices'),
                /** List assets supported by the connected device. */
                getSupportedAssets: () => this.client.get('/api/v2/devices/supported-assets'),
                /** Check REST API health and device connection state. Does not require auth. */
                getHealth: () => this.client.get('/api/health'),
                /** List all coins the firmware knows about. */
                listCoins: () => this.client.post('/system/info/list-coins'),
                /** Derive an extended public key (xpub) at the given BIP32 path. */
                getPublicKey: (params) => this.client.post('/system/info/get-public-key', params),
            },
            /** Device management — PIN, recovery, settings, firmware. */
            device: {
                /** Ping the device. Useful for connection checks. */
                ping: () => this.client.post('/system/info/ping'),
                /** Wipe all secrets from the device. Requires user confirmation on device. */
                wipe: () => this.client.post('/system/wipe-device', undefined, this.client.signingTimeoutMs),
                /** Change device label, passphrase protection, or auto-lock delay. */
                applySettings: (params) => this.client.post('/system/apply-settings', params),
                /** Apply device policy changes. */
                applyPolicies: (params) => this.client.post('/system/apply-policies', params),
                /** Start a PIN change flow. Pass `remove: true` to remove the PIN. */
                changePin: (remove) => this.client.post('/system/change-pin', remove ? { remove: true } : {}),
                /** Clear the device session (forces PIN re-entry for the next sensitive call). */
                clearSession: () => this.client.post('/system/clear-session'),
                /** Initialize a new device with a fresh seed. Requires user confirmation. */
                resetDevice: (params) => this.client.post('/system/initialize/reset-device', params, this.client.signingTimeoutMs),
                /** Recover an existing device from a seed phrase. Requires user input on device. */
                recoverDevice: (params) => this.client.post('/system/initialize/recover-device', params, this.client.signingTimeoutMs),
                /** Load a device with a specific seed (testing only). */
                loadDevice: (params) => this.client.post('/system/initialize/load-device', params, this.client.signingTimeoutMs),
                /** Send a PIN entered via matrix input during a recovery flow. */
                sendPin: (pin) => this.client.post('/system/recovery/pin', { pin }),
            },
            /** On-device cipher-recovery character entry (drives a RecoveryDevice flow). */
            recovery: {
                /**
                 * Send one ciphered character during on-device cipher recovery.
                 * The device shows a scrambled keyboard on the OLED; the host relays the
                 * character the user "typed". A finalized word that isn't in the BIP-39
                 * wordlist makes the in-flight `recoverDevice()` promise reject with
                 * "Word not found in BIP39 wordlist".
                 */
                sendCharacter: (character) => this.client.post('/system/recovery/character', { character }),
                /** Delete the last character entered during cipher recovery. */
                sendCharacterDelete: () => this.client.post('/system/recovery/character/delete', {}),
                /** Finalize cipher-recovery word/seed entry (equivalent to pressing "next"). */
                sendCharacterDone: () => this.client.post('/system/recovery/character/done', {}),
                /** Current cipher-recovery state. `seq` advances each time the device asks
                 *  for the next character — poll it to sync sends with the device. */
                getRecoveryState: () => this.client.get('/system/recovery/state'),
            },
        };
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
        this.address = {
            /** Derive a UTXO (BTC/LTC/BCH/DOGE/DASH) address. */
            utxoGetAddress: (params) => this.client.post('/addresses/utxo', params),
            /** Derive an Ethereum (or EVM-compatible) address. */
            ethGetAddress: (params) => this.client.post('/addresses/eth', params),
            /** Derive a Cosmos Hub (ATOM) address. */
            cosmosGetAddress: (params) => this.client.post('/addresses/cosmos', params),
            /** Derive a THORChain (RUNE) address. */
            thorchainGetAddress: (params) => this.client.post('/addresses/thorchain', params),
            /** Derive a MAYAChain (CACAO) address. */
            mayachainGetAddress: (params) => this.client.post('/addresses/mayachain', params),
            /** Derive an Osmosis (OSMO) address. */
            osmosisGetAddress: (params) => this.client.post('/addresses/osmosis', params),
            /** Derive a generic Tendermint-based address. */
            tendermintGetAddress: (params) => this.client.post('/addresses/tendermint', params),
            /** Derive an XRP (Ripple) address. */
            xrpGetAddress: (params) => this.client.post('/addresses/xrp', params),
            /** Derive a BNB Beacon Chain address. */
            bnbGetAddress: (params) => this.client.post('/addresses/bnb', params),
            /** Derive a Solana (SOL) address. */
            solanaGetAddress: (params) => this.client.post('/addresses/solana', params),
            /** Derive a TRON (TRX) address. */
            tronGetAddress: (params) => this.client.post('/addresses/tron', params),
            /** Derive a TON address. */
            tonGetAddress: (params) => this.client.post('/addresses/ton', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // eth — Ethereum / EVM signing
        // ═══════════════════════════════════════════════════════════════════
        /** Ethereum and EVM-compatible signing (sign-tx, sign-message, EIP-712). */
        this.eth = {
            /** Sign an Ethereum or EVM transaction. Supports legacy and EIP-1559. */
            ethSignTransaction: (params) => this.client.post('/eth/sign-transaction', params),
            /** Sign a personal message (`eth_sign` / `personal_sign`). */
            ethSignMessage: (params) => this.client.post('/eth/sign', params),
            /** Sign an EIP-712 typed data structure. */
            ethSignTypedData: (params) => this.client.post('/eth/sign-typed-data', params),
            /** Verify an Ethereum personal message signature. Returns `true` if valid. */
            ethVerifyMessage: (params) => this.client.post('/eth/verify', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // btc — Bitcoin / UTXO signing
        // ═══════════════════════════════════════════════════════════════════
        /** Bitcoin and UTXO chain signing. */
        this.btc = {
            /** Sign a UTXO transaction (BTC, LTC, BCH, DOGE, DASH, etc.). */
            btcSignTransaction: (params) => this.client.post('/utxo/sign-transaction', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // cosmos — Cosmos Hub signing
        // ═══════════════════════════════════════════════════════════════════
        /** Cosmos Hub amino signing (transfer, staking, IBC). */
        this.cosmos = {
            /** Sign a generic Cosmos amino message. */
            cosmosSignAmino: (params) => this.client.post('/cosmos/sign-amino', params),
            /** Sign a Cosmos `MsgDelegate`. */
            cosmosSignAminoDelegate: (params) => this.client.post('/cosmos/sign-amino-delegate', params),
            /** Sign a Cosmos `MsgUndelegate`. */
            cosmosSignAminoUndelegate: (params) => this.client.post('/cosmos/sign-amino-undelegate', params),
            /** Sign a Cosmos `MsgBeginRedelegate`. */
            cosmosSignAminoRedelegate: (params) => this.client.post('/cosmos/sign-amino-redelegate', params),
            /** Sign a Cosmos `MsgWithdrawDelegatorReward` for all delegations. */
            cosmosSignAminoWithdrawRewards: (params) => this.client.post('/cosmos/sign-amino-withdraw-delegator-rewards-all', params),
            /** Sign a Cosmos IBC `MsgTransfer`. */
            cosmosSignAminoIbcTransfer: (params) => this.client.post('/cosmos/sign-amino-ibc-transfer', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // osmosis — Osmosis signing
        // ═══════════════════════════════════════════════════════════════════
        /** Osmosis amino signing — transfer, staking, IBC, LP, swap. */
        this.osmosis = {
            /** Sign a generic Osmosis amino message. */
            osmosisSignAmino: (params) => this.client.post('/osmosis/sign-amino', params),
            /** Sign an Osmosis `MsgDelegate`. */
            osmosisSignAminoDelegate: (params) => this.client.post('/osmosis/sign-amino-delegate', params),
            /** Sign an Osmosis `MsgUndelegate`. */
            osmosisSignAminoUndelegate: (params) => this.client.post('/osmosis/sign-amino-undelegate', params),
            /** Sign an Osmosis `MsgBeginRedelegate`. */
            osmosisSignAminoRedelegate: (params) => this.client.post('/osmosis/sign-amino-redelegate', params),
            /** Sign an Osmosis `MsgWithdrawDelegatorReward` for all delegations. */
            osmosisSignAminoWithdrawRewards: (params) => this.client.post('/osmosis/sign-amino-withdraw-delegator-rewards-all', params),
            /** Sign an Osmosis IBC `MsgTransfer`. */
            osmosisSignAminoIbcTransfer: (params) => this.client.post('/osmosis/sign-amino-ibc-transfer', params),
            /** Sign an Osmosis `MsgExitPool` (remove liquidity). */
            osmosisSignAminoLpRemove: (params) => this.client.post('/osmosis/sign-amino-lp-remove', params),
            /** Sign an Osmosis `MsgJoinPool` (add liquidity). */
            osmosisSignAminoLpAdd: (params) => this.client.post('/osmosis/sign-amino-lp-add', params),
            /** Sign an Osmosis `MsgSwapExactAmountIn` (swap). */
            osmosisSignAminoSwap: (params) => this.client.post('/osmosis/sign-amino-swap', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // thorchain — THORChain signing
        // ═══════════════════════════════════════════════════════════════════
        /** THORChain signing (RUNE transfers and deposits for swaps). */
        this.thorchain = {
            /** Sign a THORChain `MsgSend` transfer. */
            thorchainSignAminoTransfer: (params) => this.client.post('/thorchain/sign-amino-transfer', params),
            /** Sign a THORChain `MsgDeposit` (used for swaps and loans). */
            thorchainSignAminoDeposit: (params) => this.client.post('/thorchain/sign-amino-deposit', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // mayachain — MAYAChain signing
        // ═══════════════════════════════════════════════════════════════════
        /** MAYAChain signing (CACAO transfers and deposits). */
        this.mayachain = {
            /** Sign a MAYAChain `MsgSend` transfer. */
            mayachainSignAminoTransfer: (params) => this.client.post('/mayachain/sign-amino-transfer', params),
            /** Sign a MAYAChain `MsgDeposit` (used for swaps). */
            mayachainSignAminoDeposit: (params) => this.client.post('/mayachain/sign-amino-deposit', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // ripple — XRP signing
        // ═══════════════════════════════════════════════════════════════════
        /** XRP (Ripple) signing. */
        this.ripple = {
            /** Sign an XRP payment transaction. */
            xrpSignTransaction: (params) => this.client.post('/xrp/sign-transaction', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // binance — BNB Beacon Chain signing
        // ═══════════════════════════════════════════════════════════════════
        /** BNB Beacon Chain signing. */
        this.binance = {
            /** Sign a BNB Beacon Chain transaction. */
            binanceSignTransaction: (params) => this.client.post('/bnb/sign-transaction', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // solana — Solana signing
        // ═══════════════════════════════════════════════════════════════════
        /** Solana signing (supports SPL tokens). */
        this.solana = {
            /** Sign a Solana transaction. `raw_tx` must be the base64-encoded serialized transaction. */
            solanaSignTransaction: (params) => this.client.post('/solana/sign-transaction', params),
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
            solanaSignOffchainMessage: (params) => this.client.post('/solana/sign-offchain-message', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // tron — TRON signing
        // ═══════════════════════════════════════════════════════════════════
        /** TRON (TRX) signing, including TRC-20 tokens. */
        this.tron = {
            /** Sign a TRON transaction. `amount` is in sun (1 TRX = 1,000,000 sun). */
            tronSignTransaction: (params) => this.client.post('/tron/sign-transaction', params),
            /**
             * Sign a message under TIP-191 (TRON's analog of EIP-191 personal_sign):
             *   hash = keccak256("\x19TRON Signed Message:\n" + decimal(len) + msg)
             *   sig  = secp256k1_sign(hash) → 65 bytes (r || s || 27+v)
             *
             * Pass `is_text=false` to send `message` as hex bytes; default treats
             * it as UTF-8.
             */
            tronSignMessage: (params) => this.client.post('/tron/sign-message', params),
            /**
             * Verify a TIP-191 signature against the claimed Base58Check address.
             * The device recovers the secp256k1 pubkey, derives the canonical
             * TRON address, and compares it against `address`. Returns
             * `{ verified: boolean }`.
             */
            tronVerifyMessage: (params) => this.client.post('/tron/verify-message', params),
            /**
             * TIP-712 typed-data signing in hash mode. Host pre-computes the
             * domainSeparator + message hashes per the TIP-712 spec; the device
             * assembles
             *   keccak256("\x19\x01" || domain_separator_hash || message_hash)
             * and signs with secp256k1. Both hashes must be exactly 32 bytes;
             * omit `message_hash` for primaryType="EIP712Domain".
             */
            tronSignTypedHash: (params) => this.client.post('/tron/sign-typed-hash', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // ton — TON signing
        // ═══════════════════════════════════════════════════════════════════
        /** TON signing (supports Jettons). */
        this.ton = {
            /** Sign a TON transaction. `raw_tx` must be the base64- or hex-encoded raw transaction. */
            tonSignTransaction: (params) => this.client.post('/ton/sign-transaction', params),
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
            tonSignMessage: (params) => this.client.post('/ton/sign-message', params),
            /**
             * Build an unsigned TON v4R2 transfer. Fetches seqno and wallet
             * state from TonCenter, constructs the body cell, and returns the
             * 32-byte body hash the device should sign — the client never
             * touches BOC/Cell internals. Echo the returned `build` object back
             * to `tonFinalizeTransfer` after signing.
             */
            tonBuildTransfer: (params) => this.client.post('/ton/build-transfer', params),
            /**
             * Finalize a signed TON transfer: assembles the external message
             * BOC from the prior `build` + the device's Ed25519 signature, then
             * broadcasts via TonCenter. Pass `broadcast: false` to skip the
             * broadcast and inspect/retry manually.
             */
            tonFinalizeTransfer: (params) => this.client.post('/ton/finalize-transfer', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // xpub — public key operations
        // ═══════════════════════════════════════════════════════════════════
        /** Extended public key (xpub) derivation — single and batch. */
        this.xpub = {
            /** Derive a single xpub at the given BIP32 path. */
            getPublicKey: (params) => this.client.post('/system/info/get-public-key', params),
            /**
             * Derive many xpubs in a single request. The server caches results,
             * so subsequent calls for the same path are fast.
             */
            getPublicKeys: (paths) => this.client.post('/api/pubkeys/batch', { paths }),
        };
        // ═══════════════════════════════════════════════════════════════════
        // deviceStatus — connection check
        // ═══════════════════════════════════════════════════════════════════
        /** Quick device connection status. */
        this.deviceStatus = {
            /** Returns `true` if a KeepKey device is currently connected and responsive. */
            isDeviceConnected: async () => {
                try {
                    const health = await this.client.get('/api/health');
                    return health.device_connected ?? health.connected ?? false;
                }
                catch {
                    return false;
                }
            },
        };
        // ═══════════════════════════════════════════════════════════════════
        // chain — chain data queries (balances, market, UTXOs, tx, swap)
        // ═══════════════════════════════════════════════════════════════════
        /**
         * Chain data queries: portfolio balances, market prices, UTXOs,
         * transaction history, fee estimation, and swap quotes. Pulls data
         * from upstream indexers — does not require the device to be connected.
         */
        this.chain = {
            /** Get portfolio balances across the supplied pubkeys. */
            getPortfolioBalances: (params) => this.client.post('/api/v2/portfolio/balances', params),
            /** Get market info (price, market cap) for the supplied CAIPs. */
            getMarketInfo: (params) => this.client.post('/api/v2/market/info', params),
            /** List all assets the chain indexer knows about. */
            getAvailableAssets: () => this.client.get('/api/v2/assets/available'),
            /** Search assets by symbol or name. */
            searchAssets: (params) => this.client.post('/api/v2/assets/search', params),
            /** List unspent outputs for a UTXO xpub. */
            listUnspent: (params) => this.client.post('/api/v2/utxo/unspent', params),
            /** Get pubkey info (balance, tx count) for a UTXO xpub. */
            getPubkeyInfo: (params) => this.client.post('/api/v2/utxo/pubkey-info', params),
            /** Get transaction history for one or more pubkeys. */
            getTransactionHistory: (params) => this.client.post('/api/v2/tx/history', params),
            /** Broadcast a signed transaction to the network. */
            broadcast: (params) => this.client.post('/api/v2/tx/broadcast', params),
            /** Get the current recommended fee rate for a UTXO network. */
            getFeeRate: (params) => this.client.post('/api/v2/network/fee-rate', params),
            /** Get the current gas price for an EVM network. */
            getGasPrice: (params) => this.client.post('/api/v2/network/gas-price', params),
            /** Get the nonce (tx count) for an EVM address. */
            getNonce: (params) => this.client.post('/api/v2/network/nonce', params),
            /** Get the native asset balance for an address. */
            getBalance: (params) => this.client.post('/api/v2/network/balance', params),
            /** Get the decimals for an ERC-20 / token contract. */
            getTokenDecimals: (params) => this.client.post('/api/v2/network/token-decimals', params),
            /** Get staking positions for an address. */
            getStakingPositions: (params) => this.client.post('/api/v2/staking/positions', params),
            /** Get a swap quote from the integrated aggregator. */
            getSwapQuote: (params) => this.client.post('/api/v2/swap/quote', params),
            /** Get THORChain/Mayachain inbound addresses (for swap deposits). */
            getInboundAddresses: () => this.client.get('/api/v2/swap/inbound-addresses'),
        };
        // ═══════════════════════════════════════════════════════════════════
        // sweep — BTC non-standard path recovery
        // ═══════════════════════════════════════════════════════════════════
        /**
         * Async sweep tool for recovering BTC from non-standard derivation paths
         * (e.g. mistakes from other wallets). Workflow: `startScan` → poll
         * `getScanStatus` → `execute` with a destination.
         */
        this.sweep = {
            /** Start an async scan for funds on non-standard BTC paths. Returns a `scanId` to poll. */
            startScan: (params = {}) => this.client.post('/api/v2/sweep/scan', params),
            /** Poll scan progress and results. */
            getScanStatus: (scanId) => this.client.get(`/api/v2/sweep/scan/${scanId}`),
            /** Execute a sweep: build the tx, sign on device, broadcast. */
            execute: (params) => this.client.post('/api/v2/sweep/execute', params),
        };
        this.client = client;
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
    static async create(config = {}) {
        let baseUrl = config.baseUrl
            || config.pairingInfo?.url
            || config.basePath
            || config.pairingInfo?.basePath
            || 'http://localhost:1646';
        // Strip path from URLs that look like spec/swagger endpoints
        // e.g. 'http://localhost:1646/spec/swagger.json' → 'http://localhost:1646'
        try {
            const parsed = new URL(baseUrl);
            if (parsed.pathname !== '/') {
                baseUrl = parsed.origin;
            }
        }
        catch { /* not a valid URL, use as-is */ }
        const serviceName = config.serviceName
            || config.pairingInfo?.name
            || 'keepkey-sdk';
        const serviceImageUrl = config.serviceImageUrl
            || config.pairingInfo?.imageUrl
            || '';
        const client = new client_1.VaultClient(baseUrl, config.apiKey, serviceName, serviceImageUrl);
        const alive = await client.ping();
        if (!alive)
            throw new client_1.SdkError(503, `KeepKey REST API not reachable at ${baseUrl}`);
        if (config.apiKey) {
            const valid = await client.verifyAuth();
            if (!valid) {
                await client.pair();
            }
        }
        else {
            await client.pair();
        }
        return new KeepKeySdk(client);
    }
    /**
     * Access the underlying HTTP client for advanced use cases
     * (custom endpoints, raw requests).
     */
    getClient() {
        return this.client;
    }
    /** The current API key, or `null` if not yet paired. */
    get apiKey() {
        return this.client.getApiKey();
    }
}
exports.KeepKeySdk = KeepKeySdk;
//# sourceMappingURL=index.js.map