export declare class VaultClient {
    private baseUrl;
    private apiKey;
    private serviceName;
    private serviceImageUrl;
    private rePairPromise;
    /** Default timeout for read operations (ms). */
    timeoutMs: number;
    /** Timeout for signing operations (ms). */
    signingTimeoutMs: number;
    constructor(baseUrl: string, apiKey?: string, serviceName?: string, serviceImageUrl?: string);
    /** Current API key (set after pairing) */
    getApiKey(): string | null;
    /** Set API key (e.g. after manual pairing) */
    setApiKey(key: string): void;
    /** Build headers for a request */
    private headers;
    /** Create an AbortSignal with timeout */
    private signal;
    /** GET request */
    get<T = any>(path: string, timeoutMs?: number): Promise<T>;
    /** POST request */
    post<T = any>(path: string, body?: any, timeoutMs?: number): Promise<T>;
    /** DELETE request */
    delete<T = any>(path: string): Promise<T>;
    /** Pair with the vault — user must approve on the device UI */
    pair(): Promise<string>;
    /** Check if vault is reachable */
    ping(): Promise<boolean>;
    /** Verify current API key is valid */
    verifyAuth(): Promise<boolean>;
    /**
     * Attempt to re-pair when a 403 is received.
     * Uses a mutex so concurrent 403s only trigger one re-pair attempt.
     */
    private tryRePair;
}
/** SDK-specific error with HTTP status */
export declare class SdkError extends Error {
    status: number;
    constructor(status: number, message: string);
}
//# sourceMappingURL=client.d.ts.map