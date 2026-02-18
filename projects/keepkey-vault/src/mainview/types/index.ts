/** Supported blockchain networks */
export type Chain =
	| "bitcoin"
	| "ethereum"
	| "cosmos"
	| "thorchain"
	| "osmosis"
	| "litecoin"
	| "dogecoin"
	| "bitcoincash"
	| "dash"
	| "ripple"
	| "mayachain"
	| "arkeo"
	| "binance";

export interface ChainInfo {
	name: string;
	chain: Chain;
	symbol: string;
	color: string;
	addressEndpoint: string;
}

export interface DerivedAddress {
	chain: Chain;
	address: string;
	path: string;
}

export interface DeviceInfo {
	vendor: string;
	model: string;
	deviceId: string;
	label: string;
	firmwareVersion: string;
	initialized: boolean;
	pinProtection: boolean;
	passphraseProtection: boolean;
}

export interface ConnectionStatus {
	desktop: boolean;
	device: boolean;
	paired: boolean;
}

export interface UnsignedTransaction {
	chain: Chain;
	type: string;
	payload: Record<string, unknown>;
}

export interface SignedTransaction {
	chain: Chain;
	serialized: string;
	hash?: string;
}

/** Chains config for address derivation */
export const SUPPORTED_CHAINS: ChainInfo[] = [
	{ name: "Bitcoin", chain: "bitcoin", symbol: "BTC", color: "#F7931A", addressEndpoint: "/addresses/utxo" },
	{ name: "Ethereum", chain: "ethereum", symbol: "ETH", color: "#627EEA", addressEndpoint: "/addresses/eth" },
	{ name: "Cosmos", chain: "cosmos", symbol: "ATOM", color: "#2E3148", addressEndpoint: "/addresses/cosmos" },
	{ name: "THORChain", chain: "thorchain", symbol: "RUNE", color: "#23DCC8", addressEndpoint: "/addresses/thorchain" },
	{ name: "Osmosis", chain: "osmosis", symbol: "OSMO", color: "#750BBB", addressEndpoint: "/addresses/osmosis" },
	{ name: "Litecoin", chain: "litecoin", symbol: "LTC", color: "#BFBBBB", addressEndpoint: "/addresses/utxo" },
	{ name: "Dogecoin", chain: "dogecoin", symbol: "DOGE", color: "#C2A633", addressEndpoint: "/addresses/utxo" },
	{ name: "Bitcoin Cash", chain: "bitcoincash", symbol: "BCH", color: "#8DC351", addressEndpoint: "/addresses/utxo" },
	{ name: "Dash", chain: "dash", symbol: "DASH", color: "#008CE7", addressEndpoint: "/addresses/utxo" },
	{ name: "Ripple", chain: "ripple", symbol: "XRP", color: "#23292F", addressEndpoint: "/addresses/xrp" },
	{ name: "Mayachain", chain: "mayachain", symbol: "CACAO", color: "#2850A0", addressEndpoint: "/addresses/mayachain" },
	{ name: "Binance", chain: "binance", symbol: "BNB", color: "#F3BA2F", addressEndpoint: "/addresses/bnb" },
];
