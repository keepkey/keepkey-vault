import { rpcRequest } from './rpc'

/** A device signature waits on the user's button press for as long as they
 * take. A client timeout dropped the reply while the KeepKey still showed its
 * confirm screen, then blamed the device. Cancel is cancelDeviceSigning. */
export function signOnDevice<T = any>(method: string, unsignedTx: unknown): Promise<T> {
	return rpcRequest<T>(method, unsignedTx, 0)
}

/** Sends Cancel to the KeepKey prompt; the waiting signOnDevice then rejects
 * with "KeepKey request cancelled". */
export async function cancelDeviceSigning(): Promise<void> {
	try { await rpcRequest('cancelForegroundDeviceOperation', undefined, 5000) } catch (e: any) {
		console.warn('[signing] cancelForegroundDeviceOperation failed:', e?.message || e)
	}
}
