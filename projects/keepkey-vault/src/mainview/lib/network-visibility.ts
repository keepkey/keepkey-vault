/**
 * Hiding a chain from the sidebar = turning its network off.
 *
 * There is one mechanism for this, the same one the network picker and
 * AddChainDialog use: the `disabled_networks` setting, written by the
 * setDisabledNetworks RPC. Bun reads it through networkOn() and skips the
 * network everywhere (portfolio fetch, single-chain refresh, history), so a
 * hidden chain also stops costing load time. Nothing here keeps a second,
 * UI-only list.
 */
import type { AppSettings } from "../../shared/types"

/** Networks Bun refuses to turn off (setDisabledNetworks drops them). */
const ALWAYS_ON = new Set(["bitcoin"])

export function canHideNetwork(chainId: string): boolean {
	return !ALWAYS_ON.has(chainId)
}

type Rpc = (method: "setDisabledNetworks", params: { chainIds: string[] }) => Promise<AppSettings>
// Loaded on use: the transport touches `window` when imported.
const defaultRpc: Rpc = (m, p) => import("./rpc").then(r => r.rpcRequest<AppSettings>(m, p))

/** The disabled list after hiding or showing one network. Order kept, no duplicates. */
export function nextDisabledNetworks(disabled: readonly string[], chainId: string, hidden: boolean): string[] {
	const rest = disabled.filter(id => id !== chainId)
	return hidden && canHideNetwork(chainId) ? [...rest, chainId] : rest
}

/** Turns one network off (hidden) or back on, and returns the saved settings.
 *  Callers update their state from the reply and announce the change with
 *  the "keepkey-settings-changed" event, as the network picker does. */
export async function setNetworkHidden(disabled: readonly string[], chainId: string, hidden: boolean, rpc: Rpc = defaultRpc): Promise<AppSettings> {
	if (hidden && !canHideNetwork(chainId)) throw new Error(`${chainId} can't be turned off`)
	return rpc("setDisabledNetworks", { chainIds: nextDisabledNetworks(disabled, chainId, hidden) })
}
