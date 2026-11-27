import { rpcRequest } from './rpc'

type Signing = { cancelled: boolean; waitingBusy: boolean }
let active: Signing | null = null

/** A device signature waits on the user's button press for as long as they
 * take. A client timeout dropped the reply while the KeepKey still showed its
 * confirm screen, then blamed the device. Cancel is cancelDeviceSigning.
 * isCurrent ties a busy-wait to the dialog: once it closes, the wait ends and
 * no late device prompt is fired. */
export function signOnDevice<T = any>(method: string, unsignedTx: unknown, isCurrent: () => boolean = () => true): Promise<T> {
	const signing: Signing = { cancelled: false, waitingBusy: false }
	active = signing
	return rpcRequest<T>(method, unsignedTx, 0,
		() => { signing.waitingBusy = false; return !signing.cancelled && isCurrent() },
		() => { signing.waitingBusy = true },
	).finally(() => { if (active === signing) active = null })
}

/** Cancels this window's own signing request only. While it is still waiting
 * for a busy KeepKey, the device holds someone else's operation: end the wait,
 * never Cancel that. With the request at the device, Cancel its prompt; the
 * waiting signOnDevice then rejects with "KeepKey request cancelled". */
export async function cancelDeviceSigning(): Promise<void> {
	const signing = active
	if (!signing) return
	signing.cancelled = true
	if (signing.waitingBusy) return
	try { await rpcRequest('cancelForegroundDeviceOperation', undefined, 5000) } catch (e: any) {
		console.warn('[signing] cancelForegroundDeviceOperation failed:', e?.message || e)
	}
}
