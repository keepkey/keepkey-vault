/**
 * Electrobun RPC type definitions for Bun <-> WebView communication.
 *
 * BunRPC: Methods the WebView can call on the Bun (main) process
 * ViewRPC: Methods the Bun process can call on the WebView
 */

export interface DeviceFeatures {
	vendor: string;
	model: string;
	deviceId: string;
	label: string;
	firmwareVersion: string;
	initialized: boolean;
	pinProtection: boolean;
	passphraseProtection: boolean;
}

export interface PairResult {
	success: boolean;
	apiKey?: string;
	error?: string;
}

export interface ApiCallRequest {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	body?: unknown;
}

export interface ApiCallResponse {
	success: boolean;
	data?: unknown;
	error?: string;
	status?: number;
}

export interface BunRPC {
	/** Pair with keepkey-desktop, returns API key */
	pair: (appName: string) => Promise<PairResult>;
	/** Make an authenticated API call to keepkey-desktop */
	apiCall: (request: ApiCallRequest) => Promise<ApiCallResponse>;
	/** Get stored API key (if previously paired) */
	getStoredApiKey: () => Promise<string | null>;
	/** Store API key for persistence */
	storeApiKey: (apiKey: string) => Promise<void>;
	/** Get app version */
	getVersion: () => Promise<string>;
}

export interface ViewRPC {
	/** Notify WebView of device connection change */
	deviceConnectionChanged: (connected: boolean) => void;
	/** Notify WebView of pairing status */
	pairingStatusChanged: (paired: boolean) => void;
}
