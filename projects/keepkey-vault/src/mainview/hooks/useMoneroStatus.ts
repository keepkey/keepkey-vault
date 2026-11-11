import { useCallback, useEffect, useRef, useState } from "react"
import type { MoneroStatus } from "../../shared/types"
import { rpcMoneroClient, type MoneroClient } from "../lib/monero-client"

export interface MoneroStatusState {
	/** The last status that arrived; kept when a later refresh fails, so the last known balance stays shown. */
	status: MoneroStatus | null
	refreshError: string | null
	refreshing: boolean
	refresh: () => Promise<void>
	/** Apply a status an action already returned (connect, key-image sync). */
	setStatus: (status: MoneroStatus) => void
}

/** Polls the watch wallet every 10 s while enabled. */
export function useMoneroStatus(enabled: boolean, client: MoneroClient = rpcMoneroClient): MoneroStatusState {
	const [status, setStatusState] = useState<MoneroStatus | null>(null)
	const [refreshError, setRefreshError] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const sequence = useRef(0)
	const mounted = useRef(true)
	const refresh = useCallback(async () => {
		const current = ++sequence.current
		setRefreshing(true)
		try {
			const next = await client.getStatus()
			if (!mounted.current || current !== sequence.current) return
			setStatusState(next)
			setRefreshError(null)
		} catch (error) {
			if (!mounted.current || current !== sequence.current) return
			setRefreshError(error instanceof Error ? error.message : "Unable to refresh the Monero wallet.")
		} finally {
			if (mounted.current && current === sequence.current) setRefreshing(false)
		}
	}, [client])
	const setStatus = useCallback((next: MoneroStatus) => { ++sequence.current; setStatusState(next); setRefreshError(null); setRefreshing(false) }, [])
	useEffect(() => {
		mounted.current = true
		if (!enabled) return () => { mounted.current = false }
		void refresh()
		const timer = setInterval(() => { void refresh() }, 10_000)
		return () => { mounted.current = false; ++sequence.current; clearInterval(timer) }
	}, [enabled, refresh])
	return { status, refreshError, refreshing, refresh, setStatus }
}
