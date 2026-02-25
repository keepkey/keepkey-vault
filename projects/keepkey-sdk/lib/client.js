"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SdkError = exports.VaultClient = void 0;
const DEFAULT_TIMEOUT_MS = 30000;
const SIGNING_TIMEOUT_MS = 600000;
class VaultClient {
    constructor(baseUrl, apiKey, serviceName = 'keepkey-vault-sdk', serviceImageUrl = '') {
        this.rePairPromise = null;
        // Strip trailing slash
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey || null;
        this.serviceName = serviceName;
        this.serviceImageUrl = serviceImageUrl;
        this.timeoutMs = DEFAULT_TIMEOUT_MS;
        this.signingTimeoutMs = SIGNING_TIMEOUT_MS;
    }
    /** Current API key (set after pairing) */
    getApiKey() {
        return this.apiKey;
    }
    /** Set API key (e.g. after manual pairing) */
    setApiKey(key) {
        this.apiKey = key;
    }
    /** Build headers for a request */
    headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.apiKey)
            h['Authorization'] = `Bearer ${this.apiKey}`;
        return h;
    }
    /** Create an AbortSignal with timeout */
    signal(ms) {
        return AbortSignal.timeout(ms ?? this.timeoutMs);
    }
    /** GET request */
    async get(path, timeoutMs) {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            method: 'GET',
            headers: this.headers(),
            signal: this.signal(timeoutMs),
        });
        if (resp.status === 403 && this.apiKey) {
            const rePaired = await this.tryRePair();
            if (rePaired) {
                const retry = await fetch(`${this.baseUrl}${path}`, {
                    method: 'GET',
                    headers: this.headers(),
                    signal: this.signal(timeoutMs),
                });
                if (!retry.ok)
                    throw new SdkError(retry.status, await retry.text());
                return retry.json();
            }
        }
        if (!resp.ok)
            throw new SdkError(resp.status, await resp.text());
        return resp.json();
    }
    /** POST request */
    async post(path, body, timeoutMs) {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: this.headers(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: this.signal(timeoutMs),
        });
        if (resp.status === 403 && this.apiKey) {
            const rePaired = await this.tryRePair();
            if (rePaired) {
                const retry = await fetch(`${this.baseUrl}${path}`, {
                    method: 'POST',
                    headers: this.headers(),
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    signal: this.signal(timeoutMs),
                });
                if (!retry.ok)
                    throw new SdkError(retry.status, await retry.text());
                return retry.json();
            }
        }
        if (!resp.ok)
            throw new SdkError(resp.status, await resp.text());
        return resp.json();
    }
    /** DELETE request */
    async delete(path) {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            method: 'DELETE',
            headers: this.headers(),
            signal: this.signal(),
        });
        if (resp.status === 403 && this.apiKey) {
            const rePaired = await this.tryRePair();
            if (rePaired) {
                const retry = await fetch(`${this.baseUrl}${path}`, {
                    method: 'DELETE',
                    headers: this.headers(),
                    signal: this.signal(),
                });
                if (!retry.ok)
                    throw new SdkError(retry.status, await retry.text());
                return retry.json();
            }
        }
        if (!resp.ok)
            throw new SdkError(resp.status, await resp.text());
        return resp.json();
    }
    /** Pair with the vault — user must approve on the device UI */
    async pair() {
        const resp = await fetch(`${this.baseUrl}/auth/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: this.serviceName,
                url: '',
                imageUrl: this.serviceImageUrl,
            }),
            signal: this.signal(this.signingTimeoutMs),
        });
        if (!resp.ok)
            throw new SdkError(resp.status, `Pairing failed: ${await resp.text()}`);
        const data = (await resp.json());
        if (!data || typeof data.apiKey !== 'string' || !data.apiKey) {
            throw new SdkError(500, 'Pairing response missing apiKey');
        }
        this.apiKey = data.apiKey;
        return data.apiKey;
    }
    /** Check if vault is reachable */
    async ping() {
        try {
            const resp = await fetch(`${this.baseUrl}/api/health`, {
                method: 'GET',
                signal: this.signal(5000),
            });
            return resp.ok;
        }
        catch {
            return false;
        }
    }
    /** Verify current API key is valid */
    async verifyAuth() {
        if (!this.apiKey)
            return false;
        try {
            const resp = await fetch(`${this.baseUrl}/auth/pair`, {
                method: 'GET',
                headers: this.headers(),
                signal: this.signal(),
            });
            if (!resp.ok)
                return false;
            const data = (await resp.json());
            return data.paired === true;
        }
        catch {
            return false;
        }
    }
    /**
     * Attempt to re-pair when a 403 is received.
     * Uses a mutex so concurrent 403s only trigger one re-pair attempt.
     */
    async tryRePair() {
        if (this.rePairPromise)
            return this.rePairPromise;
        this.rePairPromise = this.pair().then(() => true, () => false)
            .finally(() => { this.rePairPromise = null; });
        return this.rePairPromise;
    }
}
exports.VaultClient = VaultClient;
/** SDK-specific error with HTTP status */
class SdkError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'SdkError';
        this.status = status;
    }
}
exports.SdkError = SdkError;
//# sourceMappingURL=client.js.map