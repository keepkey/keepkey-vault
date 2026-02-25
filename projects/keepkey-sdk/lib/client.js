"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SdkError = exports.VaultClient = void 0;
class VaultClient {
    constructor(baseUrl, apiKey, serviceName = 'keepkey-vault-sdk', serviceImageUrl = '') {
        // Strip trailing slash
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey || null;
        this.serviceName = serviceName;
        this.serviceImageUrl = serviceImageUrl;
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
    /** GET request */
    async get(path) {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            method: 'GET',
            headers: this.headers(),
        });
        if (resp.status === 403 && this.apiKey) {
            // Token may have expired — try re-pairing once
            const rePaired = await this.tryRePair();
            if (rePaired) {
                const retry = await fetch(`${this.baseUrl}${path}`, {
                    method: 'GET',
                    headers: this.headers(),
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
    async post(path, body) {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: this.headers(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (resp.status === 403 && this.apiKey) {
            const rePaired = await this.tryRePair();
            if (rePaired) {
                const retry = await fetch(`${this.baseUrl}${path}`, {
                    method: 'POST',
                    headers: this.headers(),
                    body: body !== undefined ? JSON.stringify(body) : undefined,
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
        });
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
        });
        if (!resp.ok)
            throw new SdkError(resp.status, `Pairing failed: ${await resp.text()}`);
        const data = (await resp.json());
        this.apiKey = data.apiKey;
        return data.apiKey;
    }
    /** Check if vault is reachable */
    async ping() {
        try {
            const resp = await fetch(`${this.baseUrl}/api/health`, { method: 'GET' });
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
    /** Attempt to re-pair when a 403 is received */
    async tryRePair() {
        try {
            await this.pair();
            return true;
        }
        catch {
            return false;
        }
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