const BASE_URL = "http://localhost:1646";

let apiKey: string | null = null;

function headers(): Record<string, string> {
	const h: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		h["Authorization"] = `Bearer ${apiKey}`;
	}
	return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: headers(),
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "Unknown error");
		throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
	}
	return res.json();
}

export const keepkeyApi = {
	/** Set the API key for authenticated requests */
	setApiKey(key: string) {
		apiKey = key;
	},

	getApiKey(): string | null {
		return apiKey;
	},

	/** Check if keepkey-desktop is reachable */
	async ping(): Promise<boolean> {
		try {
			await fetch(`${BASE_URL}/auth/pair`, { method: "GET", headers: headers() });
			return true;
		} catch {
			return false;
		}
	},

	// --- Auth ---

	async pair(name: string, url: string, imageUrl: string): Promise<{ apiKey: string }> {
		return request("POST", "/auth/pair", { name, url, imageUrl });
	},

	async verifyPair(): Promise<boolean> {
		try {
			await request("GET", "/auth/pair");
			return true;
		} catch {
			return false;
		}
	},

	// --- Addresses ---

	async getEthAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/eth", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	async getUtxoAddress(
		addressN: number[],
		coin: string,
		scriptType?: string,
		showDisplay = false,
	): Promise<{ address: string }> {
		return request("POST", "/addresses/utxo", {
			address_n: addressN,
			coin,
			script_type: scriptType,
			show_display: showDisplay,
		});
	},

	async getCosmosAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/cosmos", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	async getThorchainAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/thorchain", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	async getOsmosisAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/osmosis", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	async getMayachainAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/mayachain", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	async getXrpAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/xrp", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	async getBnbAddress(addressN: number[], showDisplay = false): Promise<{ address: string }> {
		return request("POST", "/addresses/bnb", {
			address_n: addressN,
			show_display: showDisplay,
		});
	},

	// --- Signing ---

	async signEthTransaction(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
		return request("POST", "/eth/sign-transaction", tx);
	},

	async signEthMessage(message: string, address: string): Promise<{ signature: string }> {
		return request("POST", "/eth/sign", { message, address });
	},

	async signUtxoTransaction(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
		return request("POST", "/utxo/sign-transaction", tx);
	},

	async signCosmosAmino(signerAddress: string, signDoc: unknown): Promise<Record<string, unknown>> {
		return request("POST", "/cosmos/sign-amino", { signerAddress, signDoc });
	},

	async signThorchainTransfer(signerAddress: string, signDoc: unknown): Promise<Record<string, unknown>> {
		return request("POST", "/thorchain/sign-amino-transfer", { signerAddress, signDoc });
	},

	// --- System ---

	async getFeatures(): Promise<Record<string, unknown>> {
		return request("POST", "/system/info/get-features", {});
	},

	async pingDevice(): Promise<Record<string, unknown>> {
		return request("POST", "/system/info/ping", {});
	},

	async applySettings(settings: {
		label?: string;
		language?: string;
		autoLockDelayMs?: number;
		usePassphrase?: boolean;
	}): Promise<Record<string, unknown>> {
		return request("POST", "/system/apply-settings", {
			label: settings.label,
			language: settings.language,
			auto_lock_delay_ms: settings.autoLockDelayMs,
			use_passphrase: settings.usePassphrase,
		});
	},

	async changePin(remove = false): Promise<Record<string, unknown>> {
		return request("POST", "/system/change-pin", { remove });
	},

	async wipeDevice(): Promise<Record<string, unknown>> {
		return request("POST", "/system/wipe-device", {});
	},

	async clearSession(): Promise<Record<string, unknown>> {
		return request("POST", "/system/clear-session", {});
	},

	// --- Generic ---

	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		return request(method, path, body);
	},
};
