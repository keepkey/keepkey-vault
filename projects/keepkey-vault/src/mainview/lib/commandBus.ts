/**
 * Tiny imperative command bus for cross-cutting UI commands that need to
 * reach into a component (Dashboard) without lifting all its state up to App.
 *
 * Used today by CommandPalette (⌘K) to ask Dashboard to drill into a chain
 * or open a specific token without restructuring the Dashboard's existing
 * `drilledChainId` + `openChainPage` ownership.
 *
 * Also exposes a small balances bridge: Dashboard publishes its current
 * balances Map, and CommandPalette reads them via useLatestBalances() so
 * we can list token rows in search results without lifting balances state
 * up to App.tsx.
 */

import { useEffect, useState } from "react"
import type { ChainBalance } from "../../shared/types"

// ── Commands ────────────────────────────────────────────────────────────
export type VaultCommand =
	| { type: "open-chain"; chainId: string }
	| { type: "open-token"; chainId: string; tokenCaip: string }

type CommandListener = (cmd: VaultCommand) => void

const commandListeners = new Set<CommandListener>()

/** Dispatch a vault command. All subscribers are notified synchronously. */
export function dispatchVaultCommand(cmd: VaultCommand): void {
	for (const fn of commandListeners) {
		try { fn(cmd) } catch (e) { console.error("[commandBus] listener threw:", e) }
	}
}

/** Subscribe to vault commands. Returns an unsubscribe function. */
export function subscribeVaultCommand(fn: CommandListener): () => void {
	commandListeners.add(fn)
	return () => { commandListeners.delete(fn) }
}

// ── Balances bridge ─────────────────────────────────────────────────────
type BalancesListener = (balances: Map<string, ChainBalance>) => void

const balancesListeners = new Set<BalancesListener>()
let latestBalances: Map<string, ChainBalance> = new Map()

/** Called by Dashboard whenever its balances Map changes. */
export function publishBalances(balances: Map<string, ChainBalance>): void {
	latestBalances = balances
	for (const fn of balancesListeners) {
		try { fn(balances) } catch (e) { console.error("[commandBus] balances listener threw:", e) }
	}
}

/** Imperative read — useful for non-React call sites. */
export function getLatestBalances(): Map<string, ChainBalance> {
	return latestBalances
}

/** React hook that subscribes to balance updates published by Dashboard. */
export function useLatestBalances(): Map<string, ChainBalance> {
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(latestBalances)
	useEffect(() => {
		// Sync once on mount in case Dashboard published before we subscribed.
		setBalances(latestBalances)
		const fn: BalancesListener = (b) => setBalances(b)
		balancesListeners.add(fn)
		return () => { balancesListeners.delete(fn) }
	}, [])
	return balances
}
