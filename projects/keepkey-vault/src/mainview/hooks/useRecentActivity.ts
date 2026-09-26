import { useState, useEffect, useCallback, useRef } from "react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { RecentActivity, DeviceStateInfo } from "../../shared/types"

/**
 * Every activity row for the current wallet (no cap), kept live: refetches on
 * the backend's 'activity-changed' push (sends, REST broadcasts, swaps, scans,
 * confirmations) and on wallet switch. Out-of-order responses are dropped so a
 * slow fetch can't overwrite a newer one or leak the previous wallet's rows.
 */
export function useRecentActivity(watchOnly = false, deviceId?: string) {
	const [activities, setActivities] = useState<RecentActivity[]>([])
	const [loaded, setLoaded] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const seq = useRef(0)

	const refresh = useCallback(() => {
		const mine = ++seq.current
		rpcRequest<RecentActivity[]>("getRecentActivity", watchOnly ? { watchOnly, deviceId } : undefined, 15000)
			.then((rows) => { if (mine === seq.current && rows) { setActivities(rows); setError(null) } })
			.catch((err) => { if (mine === seq.current) setError(err?.message || "History unavailable") })
			.finally(() => { if (mine === seq.current) setLoaded(true) })
	}, [watchOnly, deviceId])

	useEffect(() => {
		setActivities([])
		setLoaded(false)
		setError(null)
		refresh()
		let lastKey = ""
		const offChanged = onRpcMessage("activity-changed", refresh)
		const offState = onRpcMessage("device-state", (state: DeviceStateInfo) => {
			const key = `${state.state}:${state.deviceId || ""}:${state.isHiddenWallet ? "hidden" : "standard"}`
			if (lastKey && key !== lastKey) {
				// Different device/seed: never show the previous wallet's rows while
				// the scoped query catches up; invalidate any fetch still in flight.
				seq.current++
				setActivities([])
			}
			lastKey = key
			if (watchOnly || (state.state === "ready" && state.deviceId)) refresh()
		})
		return () => { seq.current++; offChanged(); offState() }
	}, [refresh])

	return { activities, loaded, refresh, error }
}
