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
// Holds one pending command when Dashboard isn't mounted (no listeners).
// CommandPalette calls onJumpToVault() then dispatchVaultCommand() synchronously,
// but React hasn't re-rendered yet so Dashboard's useEffect hasn't subscribed.
// On the next subscribe() call (Dashboard mount) we drain this immediately.
let pendingCommand: VaultCommand | null = null

/** Dispatch a vault command. If Dashboard isn't mounted yet, queues it for delivery on next subscribe. */
export function dispatchVaultCommand(cmd: VaultCommand): void {
	if (commandListeners.size === 0) {
		pendingCommand = cmd
		return
	}
	for (const fn of commandListeners) {
		try { fn(cmd) } catch (e) { console.error("[commandBus] listener threw:", e) }
	}
}

/** Subscribe to vault commands. Returns an unsubscribe function. Drains any pending command immediately. */
export function subscribeVaultCommand(fn: CommandListener): () => void {
	commandListeners.add(fn)
	if (pendingCommand) {
		const cmd = pendingCommand
		pendingCommand = null
		try { fn(cmd) } catch (e) { console.error("[commandBus] listener threw:", e) }
	}
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

/** Clear the balance cache — call when Dashboard unmounts so stale wallet
 *  balances don't bleed into the next wallet session or disconnected state. */
export function clearBalances(): void {
	latestBalances = new Map()
	for (const fn of balancesListeners) {
		try { fn(latestBalances) } catch (e) { console.error("[commandBus] balances listener threw:", e) }
	}
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
