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
class KeepKeySdk {
    /** Use KeepKeySdk.create() instead of constructing directly */
    constructor(client) {
        // ═══════════════════════════════════════════════════════════════════
        // system — device info, health, management
        // ═══════════════════════════════════════════════════════════════════
        this.system = {
            info: {
                getFeatures: () => this.client.post('/system/info/get-features'),
                getDevices: () => this.client.get('/api/v2/devices'),
                getSupportedAssets: () => this.client.get('/api/v2/devices/supported-assets'),
                getHealth: () => this.client.get('/api/health'),
                listCoins: () => this.client.post('/system/info/list-coins'),
                getPublicKey: (params) => this.client.post('/system/info/get-public-key', params),
                // v1 SDK compat alias
                ping: () => this.client.post('/system/info/ping'),
            },
            device: {
                ping: () => this.client.post('/system/info/ping'),
                wipe: () => this.client.post('/system/wipe-device'),
                applySettings: (params) => this.client.post('/system/apply-settings', params),
                applyPolicies: (params) => this.client.post('/system/apply-policies', params),
                changePin: (remove) => this.client.post('/system/change-pin', remove ? { remove: true } : {}),
                clearSession: () => this.client.post('/system/clear-session'),
                resetDevice: (params) => this.client.post('/system/initialize/reset-device', params),
                recoverDevice: (params) => this.client.post('/system/initialize/recover-device', params),
                loadDevice: (params) => this.client.post('/system/initialize/load-device', params),
                sendPin: (pin) => this.client.post('/system/recovery/pin', { pin }),
            },
        };
        // ═══════════════════════════════════════════════════════════════════
        // address — derive addresses on the device
        // ═══════════════════════════════════════════════════════════════════
        this.address = {
            utxoGetAddress: (params) => this.client.post('/addresses/utxo', params),
            ethGetAddress: (params) => this.client.post('/addresses/eth', params),
            // v1 SDK compat alias
            ethereumGetAddress: (params) => this.client.post('/addresses/eth', params),
            cosmosGetAddress: (params) => this.client.post('/addresses/cosmos', params),
            thorchainGetAddress: (params) => this.client.post('/addresses/thorchain', params),
            mayachainGetAddress: (params) => this.client.post('/addresses/mayachain', params),
            osmosisGetAddress: (params) => this.client.post('/addresses/osmosis', params),
            tendermintGetAddress: (params) => this.client.post('/addresses/tendermint', params),
            xrpGetAddress: (params) => this.client.post('/addresses/xrp', params),
            bnbGetAddress: (params) => this.client.post('/addresses/bnb', params),
            // v1 SDK compat alias
            binanceGetAddress: (params) => this.client.post('/addresses/bnb', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // eth — Ethereum signing
        // ═══════════════════════════════════════════════════════════════════
        this.eth = {
            ethSignTransaction: (params) => this.client.post('/eth/sign-transaction', params),
            ethSignMessage: (params) => this.client.post('/eth/sign', params),
            ethSignTypedData: (params) => this.client.post('/eth/sign-typed-data', params),
            ethVerifyMessage: (params) => this.client.post('/eth/verify', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // btc — Bitcoin signing
        // ═══════════════════════════════════════════════════════════════════
        this.btc = {
            btcSignTransaction: (params) => this.client.post('/utxo/sign-transaction', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // cosmos — Cosmos signing (6 amino endpoints + v1 alias)
        // ═══════════════════════════════════════════════════════════════════
        this.cosmos = {
            cosmosSignAmino: (params) => this.client.post('/cosmos/sign-amino', params),
            cosmosSignAminoDelegate: (params) => this.client.post('/cosmos/sign-amino-delegate', params),
            cosmosSignAminoUndelegate: (params) => this.client.post('/cosmos/sign-amino-undelegate', params),
            cosmosSignAminoRedelegate: (params) => this.client.post('/cosmos/sign-amino-redelegate', params),
            cosmosSignAminoWithdrawRewards: (params) => this.client.post('/cosmos/sign-amino-withdraw-delegator-rewards-all', params),
            // v1 SDK compat alias (generated API name)
            cosmosSignAminoWithdrawDelegatorRewardsAll: (params) => this.client.post('/cosmos/sign-amino-withdraw-delegator-rewards-all', params),
            cosmosSignAminoIbcTransfer: (params) => this.client.post('/cosmos/sign-amino-ibc-transfer', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // osmosis — Osmosis signing (v2 names + v1 osmo* aliases)
        // ═══════════════════════════════════════════════════════════════════
        this.osmosis = {
            osmosisSignAmino: (params) => this.client.post('/osmosis/sign-amino', params),
            osmosisSignAminoDelegate: (params) => this.client.post('/osmosis/sign-amino-delegate', params),
            osmosisSignAminoUndelegate: (params) => this.client.post('/osmosis/sign-amino-undelegate', params),
            osmosisSignAminoRedelegate: (params) => this.client.post('/osmosis/sign-amino-redelegate', params),
            osmosisSignAminoWithdrawRewards: (params) => this.client.post('/osmosis/sign-amino-withdraw-delegator-rewards-all', params),
            osmosisSignAminoIbcTransfer: (params) => this.client.post('/osmosis/sign-amino-ibc-transfer', params),
            osmosisSignAminoLpRemove: (params) => this.client.post('/osmosis/sign-amino-lp-remove', params),
            osmosisSignAminoLpAdd: (params) => this.client.post('/osmosis/sign-amino-lp-add', params),
            osmosisSignAminoSwap: (params) => this.client.post('/osmosis/sign-amino-swap', params),
            // ── v1 SDK compat aliases (generated API used osmo* prefix) ──
            osmoSignAminoDelegate: (params) => this.client.post('/osmosis/sign-amino-delegate', params),
            osmoSignAminoUndelegate: (params) => this.client.post('/osmosis/sign-amino-undelegate', params),
            osmoSignAminoRedelegate: (params) => this.client.post('/osmosis/sign-amino-redelegate', params),
            osmoSignAminoWithdrawDelegatorRewardsAll: (params) => this.client.post('/osmosis/sign-amino-withdraw-delegator-rewards-all', params),
            osmoSignAminoIbcTransfer: (params) => this.client.post('/osmosis/sign-amino-ibc-transfer', params),
            osmoSignAminoLpAdd: (params) => this.client.post('/osmosis/sign-amino-lp-add', params),
            osmoSignAminoLpRemove: (params) => this.client.post('/osmosis/sign-amino-lp-remove', params),
            osmoSignAminoSwap: (params) => this.client.post('/osmosis/sign-amino-swap', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // thorchain — THORChain signing
        // ═══════════════════════════════════════════════════════════════════
        this.thorchain = {
            thorchainSignAminoTransfer: (params) => this.client.post('/thorchain/sign-amino-transfer', params),
            thorchainSignAminoDeposit: (params) => this.client.post('/thorchain/sign-amino-deposit', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // mayachain — MAYAChain signing
        // ═══════════════════════════════════════════════════════════════════
        this.mayachain = {
            mayachainSignAminoTransfer: (params) => this.client.post('/mayachain/sign-amino-transfer', params),
            mayachainSignAminoDeposit: (params) => this.client.post('/mayachain/sign-amino-deposit', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // ripple — XRP signing
        // ═══════════════════════════════════════════════════════════════════
        this.ripple = {
            xrpSignTransaction: (params) => this.client.post('/xrp/sign-transaction', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // binance — BNB signing
        // ═══════════════════════════════════════════════════════════════════
        this.binance = {
            binanceSignTransaction: (params) => this.client.post('/bnb/sign-transaction', params),
        };
        // ═══════════════════════════════════════════════════════════════════
        // xpub — public key operations (batch + single)
        // ═══════════════════════════════════════════════════════════════════
        this.xpub = {
            getPublicKey: (params) => this.client.post('/system/info/get-public-key', params),
            getPublicKeys: (paths) => this.client.post('/api/pubkeys/batch', { paths }),
        };
        // ═══════════════════════════════════════════════════════════════════
        // deviceStatus — v1 compat (non-functional, just satisfies type checks)
        // ═══════════════════════════════════════════════════════════════════
        this.deviceStatus = {
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
        this.client = client;
        // ── v1 SDK compat aliases (top-level namespaces) ───────────────
        // Old SDK exposes `sdk.info` directly (same as `sdk.system.info`)
        this.info = this.system.info;
        // Old SDK exposes `sdk.utxo` with utxoSignTransaction
        this.utxo = {
            utxoSignTransaction: (params) => this.client.post('/utxo/sign-transaction', params),
        };
        // Old SDK exposes `sdk.xrp` (we have `sdk.ripple`)
        this.xrp = this.ripple;
        // Old SDK exposes `sdk.initialize`
        this.initialize = {
            resetDevice: this.system.device.resetDevice,
            recoverDevice: this.system.device.recoverDevice,
            loadDevice: this.system.device.loadDevice,
        };
        // Old SDK exposes `sdk.auth`
        this.auth = {
            pair: () => this.client.post('/auth/pair', {
                name: 'keepkey-vault-sdk', url: '', imageUrl: '',
            }),
        };
    }
    /**
     * Create a connected KeepKeySdk instance.
     *
     * Accepts both v2 config shape and v1 compat shape:
     *   v2: { apiKey, baseUrl, serviceName, serviceImageUrl }
     *   v1: { apiKey, basePath, pairingInfo: { name, imageUrl, basePath, url } }
     */
    static async create(config = {}) {
        // Resolve base URL: v2 baseUrl > v1 pairingInfo.url > v1 basePath/pairingInfo.basePath > default
        // NOTE: pairingInfo.basePath is often a swagger URL (e.g. .../spec/swagger.json)
        //       so we prefer pairingInfo.url (actual API base) over pairingInfo.basePath
        let baseUrl = config.baseUrl
            || config.pairingInfo?.url
            || config.basePath
            || config.pairingInfo?.basePath
            || 'http://localhost:1646';
        // Guard: strip path from URLs that look like spec/swagger endpoints
        // e.g. 'http://localhost:1646/spec/swagger.json' → 'http://localhost:1646'
        try {
            const parsed = new URL(baseUrl);
            if (parsed.pathname !== '/') {
                baseUrl = parsed.origin;
            }
        }
        catch { /* not a valid URL, use as-is */ }
        // Resolve service name and image from v1 pairingInfo or v2 flat fields
        const serviceName = config.serviceName
            || config.pairingInfo?.name
            || 'keepkey-vault-sdk';
        const serviceImageUrl = config.serviceImageUrl
            || config.pairingInfo?.imageUrl
            || '';
        const client = new client_1.VaultClient(baseUrl, config.apiKey, serviceName, serviceImageUrl);
        // 1. Verify vault is reachable
        const alive = await client.ping();
        if (!alive)
            throw new client_1.SdkError(503, `Vault not reachable at ${baseUrl}`);
        // 2. Validate existing key or auto-pair
        if (config.apiKey) {
            const valid = await client.verifyAuth();
            if (!valid) {
                // Key expired or revoked — re-pair
                await client.pair();
            }
        }
        else {
            // No key provided — pair now
            await client.pair();
        }
        return new KeepKeySdk(client);
    }
    /** Access the underlying HTTP client (for advanced usage) */
    getClient() {
        return this.client;
    }
    /** Current API key */
    get apiKey() {
        return this.client.getApiKey();
    }
}
exports.KeepKeySdk = KeepKeySdk;
//# sourceMappingURL=index.js.map