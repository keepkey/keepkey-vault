export declare class VaultClient {
    private baseUrl;
    private apiKey;
    private serviceName;
    private serviceImageUrl;
    constructor(baseUrl: string, apiKey?: string, serviceName?: string, serviceImageUrl?: string);
    /** Current API key (set after pairing) */
    getApiKey(): string | null;
    /** Set API key (e.g. after manual pairing) */
    setApiKey(key: string): void;
    /** Build headers for a request */
    private headers;
    /** GET request */
    get<T = any>(path: string): Promise<T>;
    /** POST request */
    post<T = any>(path: string, body?: any): Promise<T>;
    /** DELETE request */
    delete<T = any>(path: string): Promise<T>;
    /** Pair with the vault — user must approve on the device UI */
    pair(): Promise<string>;
    /** Check if vault is reachable */
    ping(): Promise<boolean>;
    /** Verify current API key is valid */
    verifyAuth(): Promise<boolean>;
    /** Attempt to re-pair when a 403 is received */
    private tryRePair;
}
/** SDK-specific error with HTTP status */
export declare class SdkError extends Error {
    status: number;
    constructor(status: number, message: string);
}
//# sourceMappingURL=client.d.ts.map