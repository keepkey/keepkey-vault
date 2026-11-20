import { useEffect, useMemo, useRef } from 'react'
import type { AppSettings } from '../../shared/types'
import { createSettingsLoader } from '../lib/app-settings-loader'
import { rpcRequest } from '../lib/rpc'

/** A stable `load` function for a component; pending retries stop when it unmounts. */
export function useAppSettingsLoader(apply: (settings: AppSettings) => void, timeoutMs = 5000): () => void {
	const applyRef = useRef(apply)
	applyRef.current = apply
	const loader = useMemo(() => createSettingsLoader(settings => applyRef.current(settings), {
		request: () => rpcRequest<AppSettings>('getAppSettings', undefined, timeoutMs),
		setTimer: (run, ms) => setTimeout(run, ms),
		clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
		warn: message => console.warn(message),
	}), [timeoutMs])
	useEffect(() => () => loader.cancel(), [loader])
	return loader.load
}
